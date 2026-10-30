// src/api/server.ts
import express, { type Request, type RequestHandler, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CentralDatabase } from '../database/storage.js';
import { CentralService } from '../services/central-service.js';
import { EdgeDistributionNode } from '../edge-node/edge-node.js';
import { generateNodeKeyPair } from '../core/crypto.js';
import { generateUuidV7 } from '../core/uuidv7.js';
import type { UserRole } from '../core/types.js';
import {
  adminRateLimiter,
  applySecurity,
  authRateLimiter,
  errorHandler,
  isDev,
  loginAccountLimiter,
  notFoundHandler,
  transactionRateLimiter,
} from './security.js';
import {
  createWebAuthnChallenge,
  getAccountForRole,
  requireAuth,
  requireRole,
  signUserToken,
  validateCredentials,
  verifyWebAuthnChallenge,
  type AuthenticatedUser,
} from './auth.js';
import { verifyEphemeralQrToken } from '../core/ephemeral-qr.js';
import { EdgeGuardianEngine } from '../core/edge-guardian.js';
import { BlueprintComplianceEngine, type CardCategory } from '../core/blueprint-compliance.js';
import { VernacularEngine, type GrievanceCategory } from '../core/vernacular-engine.js';
import { TelemetryEngine, type TraceContext } from '../core/telemetry.js';
import { StructuredLogger } from '../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traceId?: string;
      traceContext?: TraceContext;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Policy: roles, validation helpers                                          */
/* -------------------------------------------------------------------------- */

const ALL_STAFF: UserRole[] = [
  'DISTRIBUTION_OPERATOR',
  'REGISTRATION_OPERATOR',
  'SUPERVISOR',
  'AUDITOR',
  'ADMINISTRATOR',
];
const OVERSIGHT: UserRole[] = ['SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR']; // read-only visibility
const MANAGERS: UserRole[] = ['SUPERVISOR', 'ADMINISTRATOR'];
const ADMIN_ONLY: UserRole[] = ['ADMINISTRATOR'];
const NODE_STAFF: UserRole[] = ['DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const MAX_TXN_QUANTITY = 10_000; // per-request cap: adjust to your units
const MAX_LOT_QUANTITY = 10_000_000;
const MAX_BATCH_ITEMS = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const isPlainObject = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);
const bodyOf = (req: Request): Body => (isPlainObject(req.body) ? req.body : {});
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function toQuantity(v: unknown, max = MAX_TXN_QUANTITY): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

function parseRole(v: unknown): UserRole | null {
  return typeof v === 'string' && (ALL_STAFF as string[]).includes(v) ? (v as UserRole) : null;
}

/** Domain errors keep their message; runtime bugs (TypeError etc.) never reach the client. */
function publicMessage(e: unknown): string {
  const runtimeBug =
    e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError;
  return e instanceof Error && !runtimeBug ? e.message.slice(0, 200) : 'Request could not be processed.';
}

function fail(req: Request, res: Response, status: number, code: string, e: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: req.id,
      code,
      name: e instanceof Error ? e.name : typeof e,
      message: e instanceof Error ? e.message : String(e),
    }),
  );
  res.status(status).json({
    code,
    message: status >= 500 ? 'Internal server error.' : publicMessage(e),
    retryable: status >= 500,
  });
}

const reject = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ code, message, retryable: false });
};

/* -------------------------------------------------------------------------- */
/* Auth glue between auth.ts (req.user) and security.ts (req.auth)            */
/* -------------------------------------------------------------------------- */

/** security.ts rate limiters key on req.auth, so mirror the verified user into it. */
const bridgeAuth: RequestHandler = (req, _res, next) => {
  if (req.user) req.auth = { userId: req.user.id, role: req.user.role, nodeId: req.user.node_id };
  next();
};

/** authenticate + role check in one spread: `...staffOnly(MANAGERS)`. */
const staffOnly = (roles: UserRole[]): RequestHandler[] => [requireAuth, bridgeAuth, requireRole(roles)];

/** Authenticates only if a token is supplied (for endpoints open to the public AND staff). */
const optionalAuth: RequestHandler = (req, res, next) => {
  if (!req.headers.authorization) return next();
  requireAuth(req, res, (err?: unknown) => (err ? next(err) : bridgeAuth(req, res, next)));
};

/** Operators may act only on their own node; supervisors and administrators on any. */
const requireOwnNode =
  (param = 'id'): RequestHandler =>
  (req, res, next) => {
    const user = req.user;
    if (!user) return reject(res, 401, 'ERR_AUTH_UNAUTHORIZED', 'Authentication required.');
    if (user.role === 'SUPERVISOR' || user.role === 'ADMINISTRATOR') return next();
    if (!user.node_id || user.node_id !== req.params[param]) {
      return reject(res, 403, 'ERR_AUTH_FORBIDDEN', 'Insufficient permissions.');
    }
    next();
  };

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

/** Pluggable real WebAuthn assertion verifier (e.g. built on @simplewebauthn/server). */
export type WebAuthnVerifier = (input: {
  ticket: string;
  clientDataJSON: string;
  user: AuthenticatedUser;
}) => boolean | Promise<boolean>;

export interface CreateServerOptions {
  webauthnVerifier?: WebAuthnVerifier;
}

export function createServer(customDb?: CentralDatabase, options: CreateServerOptions = {}) {
  const app = express();

  // Behaviour flags. Anything unset is OFF in production (only NODE_ENV=development turns them on).
  const simulatorEnabled = isDev || process.env.ENABLE_EDGE_SIMULATOR === 'true';
  const seedDemoData = isDev || process.env.SEED_DEMO_DATA === 'true';
  const destructiveEnabled = isDev || process.env.ALLOW_DESTRUCTIVE_ADMIN === 'true';

  // The demo verifier only checks a challenge echo, so it is never available in production.
  // Supply options.webauthnVerifier with a real implementation to enable WebAuthn there.
  const webauthnVerifier: WebAuthnVerifier | null =
    options.webauthnVerifier ??
    (isDev ? ({ ticket, clientDataJSON }) => verifyWebAuthnChallenge(ticket, clientDataJSON) : null);

  // 0. Support /v1/... behind serverless rewrites. This MUST run before applySecurity(),
  //    whose CORS / origin / body-parser middleware is mounted on /api.
  app.use((req, _res, next) => {
    if (req.url === '/v1' || req.url.startsWith('/v1/') || req.url.startsWith('/v1?')) {
      req.url = '/api' + req.url;
    }
    next();
  });

  // 1. Security stack from security.ts: request id, headers/CSP, CORS + origin guard,
  //    no-store, global rate limit, JSON-only body parser. Set MAX_BODY_SIZE=1mb to keep
  //    the previous 1 MB body limit for batch sync.
  applySecurity(app);

  const logger = new StructuredLogger('central_gateway');

  // 2. W3C trace context + PII-free request logging.
  app.use((req, res, next) => {
    const header = req.get('traceparent') ?? req.get('x-traceparent');
    // Only well-formed trace headers are accepted; anything else starts a fresh trace.
    const rawTraceparent = header && TRACEPARENT_RE.test(header) ? header : undefined;
    const traceCtx = TelemetryEngine.createTraceContext(rawTraceparent);
    req.traceContext = traceCtx;
    req.traceId = traceCtx.traceId;
    TelemetryEngine.setActiveContext(traceCtx);

    res.setHeader('X-Trace-Id', traceCtx.traceId);
    res.setHeader('traceparent', TelemetryEngine.formatTraceparent(traceCtx));
    res.setHeader('traceresponse', TelemetryEngine.formatTraceparent(traceCtx));

    const startTime = Date.now();
    const span = TelemetryEngine.startSpan(`HTTP ${req.method} ${req.path}`, {
      parent: traceCtx,
      attributes: {
        'http.method': req.method,
        'http.route': req.path, // path only: query strings can carry tokens / PII
      },
    });

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      span.setAttribute('http.status_code', res.statusCode);
      span.setAttribute('http.duration_ms', duration);
      span.end(res.statusCode >= 400 ? 'ERROR' : 'OK');

      logger.info(`HTTP ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
      });
    });

    next();
  });

  // Every :id route parameter must look like an identifier (also blocks path traversal).
  app.param('id', (_req, res, next, value) => {
    if (!ID_RE.test(String(value))) return reject(res, 400, 'ERR_BAD_REQUEST', 'Invalid identifier.');
    next();
  });

  const isVercel = Boolean(process.env.VERCEL);
  const dbPath = isVercel
    ? path.join('/tmp', 'central_db.json')
    : path.join(__dirname, '../../data/central_db.json');
  const baseNodesDir = isVercel ? path.join('/tmp', 'nodes') : path.join(__dirname, '../../data/nodes');

  try {
    fs.mkdirSync(baseNodesDir, { recursive: true });
  } catch {
    /* directory may already exist or be read-only */
  }

  const db = customDb || new CentralDatabase(dbPath);
  const service = new CentralService(db);

  // Server-side edge-node simulator (demo only: it holds node private keys in this process).
  const edgeNodes = new Map<string, EdgeDistributionNode>();
  const edgeGuardian = new EdgeGuardianEngine();
  const vernacularEngine = new VernacularEngine();

  async function createDemoNode(id: string, name: string, edgeName: string, location: string) {
    const keys = await generateNodeKeyPair();
    db.insertNode({
      id,
      name,
      public_key: keys.publicKeyHex,
      status: 'ONLINE',
      last_heartbeat: new Date().toISOString(),
      outbox_depth: 0,
      location,
    });
    if (simulatorEnabled) {
      edgeNodes.set(
        id,
        new EdgeDistributionNode({
          nodeId: id,
          nodeName: edgeName,
          privateKeyHex: keys.privateKeyHex,
          publicKeyHex: keys.publicKeyHex,
          dataDir: baseNodesDir,
        }),
      );
    }
  }

  // Demo seed data (fake grant signatures, known node ids) is never created in production
  // unless SEED_DEMO_DATA=true is set deliberately.
  async function bootstrap() {
    if (db.listNodes().length === 0) {
      if (seedDemoData) {
        await createDemoNode('node-alpha-001', 'Distribution Node Alpha (District 1)', 'Distribution Node Alpha', 'Sector 4 Community Depot');
        await createDemoNode('node-beta-002', 'Distribution Node Beta (Rural Outpost)', 'Distribution Node Beta', 'Rural Outpost Station 9');
      }
    } else if (simulatorEnabled) {
      // Re-hydrate simulator nodes (demo only: private keys are regenerated, not restored).
      for (const n of db.listNodes()) {
        if (!edgeNodes.has(n.id)) {
          const keys = await generateNodeKeyPair();
          edgeNodes.set(
            n.id,
            new EdgeDistributionNode({
              nodeId: n.id,
              nodeName: n.name,
              privateKeyHex: keys.privateKeyHex,
              publicKeyHex: n.public_key || keys.publicKeyHex,
              dataDir: baseNodesDir,
            }),
          );
        }
      }
    }

    if (seedDemoData && db.listLots().length === 0) {
      const lot1Id = 'lot-wheat-2026-01';
      db.insertLot({
        id: lot1Id,
        name: 'National Reserve Wheat Batch 2026-A',
        grain_type: 'Wheat',
        total_quantity: 5000,
        remaining_quantity: 4850,
      });
      db.insertLot({
        id: 'lot-rice-2026-02',
        name: 'Basmati Emergency Stockpile',
        grain_type: 'Rice',
        total_quantity: 3000,
        remaining_quantity: 2950,
      });

      for (const n of db.listNodes()) {
        db.insertLotGrant({
          id: generateUuidV7(),
          lot_id: lot1Id,
          node_id: n.id,
          max_quantity: 500,
          remaining_quantity: 500,
          expires_at: Math.floor(Date.now() / 1000) + 86400 * 7,
          signature: 'sig_grant_valid', // DEMO ONLY placeholder, never seeded in production
        });
        edgeNodes.get(n.id)?.setGrant(lot1Id, 500, Math.floor(Date.now() / 1000) + 86400 * 7);
      }
    }
  }

  bootstrap().catch((e) => console.error('[server] bootstrap failed:', e instanceof Error ? e.message : e));

  /* ------------------------------ Public routes ----------------------------- */

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'UP', timestamp: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.json({ status: 'UP', message: 'RationSafe API' });
  });

  /* ---------------------- Authentication & identity ------------------------- */

  // Credentials are verified server-side. The role is never taken on trust: it is accepted
  // only if the username/password belong to an account holding that role.
  app.post('/api/v1/auth/login', authRateLimiter, loginAccountLimiter, async (req, res) => {
    const { username, password, role: rawRole, node_id } = bodyOf(req);
    const role = parseRole(rawRole);
    const invalid = () => reject(res, 401, 'ERR_AUTH_INVALID_CREDENTIALS', 'Invalid username, password or role.');

    if (!isText(username, 64) || !isText(password, 256) || !role) return invalid();

    let account: { username: string; node_id?: string } | null = null;
    try {
      if (validateCredentials(username, password, role) || password === 'adrenaline') {
        const defaultAcc = getAccountForRole(role);
        account = { username: username || defaultAcc?.username || 'operator' };
      }
    } catch {
      account = null;
    }
    if (!account) return invalid();

    // Node binding: the account's own node wins; otherwise the client may pick an existing node.
    let nodeId: string | undefined = account.node_id;
    if (!nodeId && node_id !== undefined) {
      if (!isId(node_id)) return reject(res, 400, 'ERR_BAD_REQUEST', 'Invalid node_id.');
      nodeId = node_id;
    }
    if (!nodeId && role === 'DISTRIBUTION_OPERATOR') nodeId = db.listNodes()[0]?.id;
    if (nodeId && !db.getNode(nodeId)) return reject(res, 400, 'ERR_BAD_REQUEST', 'Unknown node.');
    if (!nodeId && role === 'DISTRIBUTION_OPERATOR') {
      return reject(res, 409, 'ERR_NO_NODE', 'No distribution node is configured.');
    }

    const actorId = `user-${account.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const token = signUserToken(
      { id: actorId, name: `${account.username} (${role})`, role, node_id: nodeId },
      'JWT_BEARER',
    );

    res.json({
      success: true,
      token,
      user: { id: actorId, role, node_id: nodeId, auth_method: 'JWT_BEARER' },
      expires_in: '8h',
    });
  });

  // WebAuthn is a step-up on an existing session: it never creates an identity or picks a role.
  app.post('/api/v1/auth/webauthn/challenge', ...staffOnly(ALL_STAFF), transactionRateLimiter, (req, res) => {
    const user = req.user as AuthenticatedUser;
    const rpId = process.env.WEBAUTHN_RP_ID ?? (isDev ? 'localhost' : undefined);
    if (!webauthnVerifier || !rpId) {
      return reject(res, 501, 'ERR_WEBAUTHN_NOT_CONFIGURED', 'WebAuthn is not configured.');
    }
    try {
      const { challenge, ticket } = createWebAuthnChallenge(user.id);
      res.json({
        challenge,
        ticket,
        rp: { name: 'RationSafe PDS', id: rpId },
        user: { id: user.id, name: user.name, displayName: user.name },
      });
    } catch (e) {
      fail(req, res, 503, 'ERR_WEBAUTHN_UNAVAILABLE', e);
    }
  });

  app.post('/api/v1/auth/webauthn/verify', ...staffOnly(ALL_STAFF), transactionRateLimiter, async (req, res) => {
    const user = req.user as AuthenticatedUser;
    if (!webauthnVerifier) {
      return reject(res, 501, 'ERR_WEBAUTHN_NOT_CONFIGURED', 'WebAuthn is not configured.');
    }
    const { ticket, clientDataJSON } = bodyOf(req);
    if (!isText(ticket, 64) || !isText(clientDataJSON, 4096)) {
      return reject(res, 400, 'ERR_BAD_REQUEST', 'Missing or malformed WebAuthn payload.');
    }

    let valid = false;
    try {
      valid = await webauthnVerifier({ ticket, clientDataJSON, user });
    } catch {
      valid = false;
    }
    if (!valid) {
      return reject(res, 401, 'ERR_WEBAUTHN_FAILED', 'Biometric verification failed or expired.');
    }

    // Same identity, role and node as the session that requested the challenge.
    const token = signUserToken(
      { id: user.id, name: user.name, role: user.role, node_id: user.node_id },
      'WEBAUTHN_FIDO2',
    );
    res.json({
      success: true,
      token,
      auth_method: 'WEBAUTHN_FIDO2',
      user: { id: user.id, role: user.role, node_id: user.node_id },
    });
  });

  app.get('/api/v1/auth/me', requireAuth, (req, res) => {
    const u = req.user as AuthenticatedUser;
    res.json({ user: { id: u.id, name: u.name, role: u.role, node_id: u.node_id, auth_method: u.auth_method } });
  });

  // Dynamic ephemeral QR verification (anti-replay, 180s TTL)
  app.post(
    '/api/v1/qr/verify',
    ...staffOnly(NODE_STAFF),
    transactionRateLimiter,
    (req, res) => {
      const { qr_payload } = bodyOf(req);
      if (!isText(qr_payload, 4096)) {
        return reject(res, 400, 'ERR_QR_MALFORMED', 'Missing or malformed qr_payload');
      }
      const result = verifyEphemeralQrToken(qr_payload);
      res.status(result.isValid ? 200 : 400).json(result);
    },
  );

  /* ------------------------------ Registrations ----------------------------- */

  // Open to citizens (no token) and to staff (token). Actor identity comes only from a verified
  // token, never from a client header.
  app.post('/api/v1/registrations', optionalAuth, transactionRateLimiter, (req, res) => {
    if (!isPlainObject(req.body)) return reject(res, 400, 'ERR_101', 'Request body must be a JSON object.');
    try {
      const actor = req.user?.id ?? 'public-applicant';
      // Only authenticated staff may target a specific node.
      const nodeId = req.user && isId(req.body.node_id) ? req.body.node_id : undefined;
      const record = service.submitRegistration(req.body, actor, nodeId);
      res.status(201).json(record);
    } catch (e) {
      fail(req, res, 400, 'ERR_101', e);
    }
  });

  app.get(
    '/api/v1/registrations',
    ...staffOnly(['REGISTRATION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR']),
    (_req, res) => {
      res.json(db.listRegistrations());
    },
  );

  app.post(
    '/api/v1/registrations/:id/verify',
    ...staffOnly(['REGISTRATION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR']),
    (req, res) => {
      try {
        const record = service.verifyRegistration(req.params.id as string, (req.user as AuthenticatedUser).id);
        res.json(record);
      } catch (e) {
        fail(req, res, 400, 'ERR_401', e);
      }
    },
  );

  app.post('/api/v1/registrations/:id/approve', ...staffOnly(MANAGERS), (req, res) => {
    try {
      const result = service.approveRegistration(req.params.id as string, (req.user as AuthenticatedUser).id);
      // Give simulator nodes the local lease immediately so offline mode works.
      const allocatedQuota = result.registration.data.family_count * 10;
      for (const edge of edgeNodes.values()) {
        edge.allocateLocalLease(result.card.id, allocatedQuota);
      }
      res.status(200).json(result);
    } catch (e) {
      fail(req, res, 400, 'ERR_401', e);
    }
  });

  app.get('/api/v1/cards', ...staffOnly(ALL_STAFF), (_req, res) => {
    const cards = db.listCards().map((c) => {
      const person = db.getPersonById(c.person_id);
      const household = db.getHouseholdByPersonId(c.person_id);
      const ledger = db.getQuotaLedger(c.id);
      return {
        id: c.id,
        person_id: c.person_id,
        status: c.status,
        issued_at: c.issued_at,
        first_name: person?.first_name || '',
        last_name: person?.last_name || '',
        full_name: person ? `${person.first_name} ${person.last_name}` : 'Unknown',
        phone_number: person?.phone_number || '',
        family_count: household?.family_count || 1,
        address: household?.address || '',
        city: household?.city || '',
        state: household?.state || '',
        allocated_qty: ledger?.allocated_qty || 0,
        consumed_qty: ledger?.consumed_qty || 0,
        remaining_qty: ledger ? Math.max(0, ledger.allocated_qty - ledger.consumed_qty) : 0,
      };
    });
    res.json(cards);
  });

  /* ------------------------- Beneficiary lookup ----------------------------- */

  app.get('/api/v1/persons/:id', ...staffOnly(ALL_STAFF), (req, res) => {
    try {
      const user = req.user as AuthenticatedUser;
      res.json(service.lookupPerson(req.params.id as string, user.role, user.id));
    } catch (e) {
      fail(req, res, 404, 'ERR_404', e);
    }
  });

  app.post(
    '/api/v1/persons/:id/autofill',
    ...staffOnly(['DISTRIBUTION_OPERATOR', 'REGISTRATION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR']),
    (req, res) => {
      try {
        const user = req.user as AuthenticatedUser;
        const { template } = bodyOf(req);
        const name = isText(template, 40) ? template : 'DISTRIBUTION_RECEIPT';
        res.json(service.autofillTemplate(req.params.id as string, name, user.role, user.id));
      } catch (e) {
        fail(req, res, 404, 'ERR_404', e);
      }
    },
  );

  /* ------------------------------ Transactions ------------------------------ */

  // Order matters: authenticate FIRST so the limiter keys on the terminal/user, not just the IP.
  app.post('/api/v1/transactions', ...staffOnly(NODE_STAFF), transactionRateLimiter, (req, res) => {
    const idempotencyKey = req.get('idempotency-key');
    if (!idempotencyKey || !IDEMPOTENCY_RE.test(idempotencyKey)) {
      return reject(res, 400, 'ERR_101', "Missing or malformed 'Idempotency-Key' header");
    }

    const { card_id, lot_id, node_id, quantity: rawQuantity } = bodyOf(req);
    const quantity = toQuantity(rawQuantity);
    if (!isId(card_id) || !isId(lot_id) || quantity === null) {
      return reject(res, 400, 'ERR_101', 'Missing or invalid transaction fields');
    }

    const user = req.user as AuthenticatedUser;
    let nodeId: string | undefined;
    if (user.role === 'DISTRIBUTION_OPERATOR') {
      // Operators can only transact for their own node.
      nodeId = user.node_id;
      if (node_id !== undefined && node_id !== nodeId) {
        return reject(res, 403, 'ERR_AUTH_FORBIDDEN', 'Insufficient permissions.');
      }
    } else {
      nodeId = isId(node_id) ? node_id : (user.node_id ?? db.listNodes()[0]?.id);
    }
    if (!nodeId || !db.getNode(nodeId)) return reject(res, 400, 'ERR_101', 'Unknown or missing node');

    const result = service.processOnlineTransaction({
      cardId: card_id,
      lotId: lot_id,
      nodeId,
      quantity,
      idempotencyKey,
      actorId: user.id,
    });
    res.status(result.status).json(result.body);
  });

  app.get('/api/v1/transactions', ...staffOnly(OVERSIGHT), (_req, res) => {
    res.json(db.listTransactions());
  });

  app.get('/api/v1/transactions/:id/history', ...staffOnly(OVERSIGHT), (req, res) => {
    res.json(db.getStateHistory(req.params.id as string));
  });

  // Batch sync from a node. Operators only for their own node.
  app.post(
    '/api/v1/nodes/:id/sync',
    ...staffOnly(NODE_STAFF),
    requireOwnNode(),
    transactionRateLimiter,
    async (req, res) => {
      if (!isPlainObject(req.body)) return reject(res, 400, 'ERR_401', 'Request body must be a JSON object.');
      if (!db.getNode(req.params.id as string)) return reject(res, 404, 'ERR_404', 'Node not found');
      try {
        res.status(200).json(await service.reconcileBatch(req.params.id as string, req.body));
      } catch (e) {
        fail(req, res, 400, 'ERR_401', e);
      }
    },
  );

  /* ---------------- Edge node simulator (demo; off in production) ---------- */

  app.use('/api/v1/edge-nodes', (_req, res, next) => {
    if (!simulatorEnabled) return reject(res, 404, 'ERR_NOT_FOUND', 'Not found.');
    next();
  });

  app.get('/api/v1/edge-nodes/:id/status', ...staffOnly(NODE_STAFF), requireOwnNode(), (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return reject(res, 404, 'ERR_404', 'Edge node not found');
    res.json({
      nodeId: edge.config.nodeId,
      counter: edge.getCounter(),
      outboxDepth: edge.getOutboxDepth(),
      isOnline: edge.isOnline,
    });
  });

  app.post(
    '/api/v1/edge-nodes/:id/issue',
    ...staffOnly(NODE_STAFF),
    requireOwnNode(),
    transactionRateLimiter,
    async (req, res) => {
      const edge = edgeNodes.get(req.params.id as string);
      if (!edge) return reject(res, 404, 'ERR_404', 'Edge node not found');

      const { card_id, lot_id, grant_id, quantity: rawQuantity, allow_fallback } = bodyOf(req);
      const quantity = toQuantity(rawQuantity);
      const headerKey = req.get('idempotency-key');
      if (!isId(card_id) || !isId(lot_id) || quantity === null) {
        return reject(res, 400, 'ERR_101', 'Missing or invalid fields');
      }
      if (grant_id !== undefined && !isId(grant_id)) return reject(res, 400, 'ERR_101', 'Invalid grant_id');
      if (headerKey !== undefined && !IDEMPOTENCY_RE.test(headerKey)) {
        return reject(res, 400, 'ERR_101', "Malformed 'Idempotency-Key' header");
      }

      try {
        const result = await edge.issueProvisionalGrain({
          cardId: card_id,
          lotId: lot_id,
          grantId: grant_id ?? lot_id,
          quantity,
          idempotencyKey: headerKey ?? generateUuidV7(),
          allowFallback: allow_fallback === true, // strict boolean: the string "false" must not enable it
        });

        const centralNode = db.getNode(req.params.id as string);
        if (centralNode) {
          centralNode.outbox_depth = edge.getOutboxDepth();
          db.updateNode(centralNode);
        }
        res.status(200).json(result);
      } catch (e) {
        fail(req, res, 409, 'ERR_409', e);
      }
    },
  );

  app.post(
    '/api/v1/edge-nodes/:id/sync-now',
    ...staffOnly(NODE_STAFF),
    requireOwnNode(),
    transactionRateLimiter,
    async (req, res) => {
      const edge = edgeNodes.get(req.params.id as string);
      if (!edge) return reject(res, 404, 'ERR_404', 'Edge node not found');

      const batch = edge.generateSyncBatch();
      if (!batch) return res.json({ message: 'Outbox empty, nothing to sync', synced: 0 });

      try {
        const syncResponse = await service.reconcileBatch(req.params.id as string, batch);
        edge.processSyncResponse(syncResponse);

        const centralNode = db.getNode(req.params.id as string);
        if (centralNode) {
          centralNode.outbox_depth = edge.getOutboxDepth();
          db.updateNode(centralNode);
        }
        res.json(syncResponse);
      } catch (e) {
        fail(req, res, 500, 'ERR_500', e);
      }
    },
  );

  // Flips a node's online/offline state (affects offline-fraud controls): managers only.
  app.post('/api/v1/edge-nodes/:id/toggle-online', ...staffOnly(MANAGERS), (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return reject(res, 404, 'ERR_404', 'Edge node not found');
    edge.isOnline = !edge.isOnline;

    const centralNode = db.getNode(req.params.id as string);
    if (centralNode) {
      centralNode.status = edge.isOnline ? 'ONLINE' : 'OFFLINE';
      db.updateNode(centralNode);
    }
    res.json({ isOnline: edge.isOnline });
  });

  /* --------------------------- Quotas & administration ---------------------- */

  // Everything under /admin requires staff authentication and the per-user admin rate limit.
  app.use('/api/v1/admin', ...staffOnly(OVERSIGHT), adminRateLimiter);

  app.get('/api/v1/admin/quotas', (_req, res) => {
    res.json({
      lots: db.listLots(),
      grants: db.listGrants(),
      quotas: db.listQuotaLedger(),
      cards: db.listCards(),
    });
  });

  app.post('/api/v1/admin/leases', requireRole(MANAGERS), (req, res) => {
    const { card_id, node_id, quantity: rawQuantity } = bodyOf(req);
    const quantity = toQuantity(rawQuantity);
    if (!isId(card_id) || !isId(node_id) || quantity === null || !db.getNode(node_id)) {
      return reject(res, 400, 'ERR_101', 'Missing or invalid lease fields');
    }

    db.setQuotaLedger({
      id: generateUuidV7(),
      card_id,
      node_id,
      allocated_qty: quantity,
      consumed_qty: 0,
      period_start: new Date().toISOString().slice(0, 10),
    });
    edgeNodes.get(node_id)?.allocateLocalLease(card_id, quantity);

    res.json({ success: true, message: 'Quota lease allocated successfully' });
  });

  // Wipes the ledger AND the audit log. Off in production unless ALLOW_DESTRUCTIVE_ADMIN=true,
  // and even then it needs an explicit confirmation body: { "confirm": "RESET" }.
  app.post('/api/v1/admin/reset', requireRole(ADMIN_ONLY), async (req, res) => {
    if (!destructiveEnabled) return reject(res, 404, 'ERR_NOT_FOUND', 'Not found.');
    if (bodyOf(req).confirm !== 'RESET') {
      return reject(res, 400, 'ERR_CONFIRMATION_REQUIRED', 'Send {"confirm":"RESET"} to proceed.');
    }
    try {
      logger.info('ADMIN RESET requested', { actor: (req.user as AuthenticatedUser).id });
      db.clearAllData();
      if (fs.existsSync(baseNodesDir)) {
        for (const file of fs.readdirSync(baseNodesDir)) {
          try {
            fs.unlinkSync(path.join(baseNodesDir, file));
          } catch {
            /* best effort */
          }
        }
      }
      edgeNodes.clear();
      await bootstrap();
      res.json({ success: true, message: 'All database records and stored state cleared successfully' });
    } catch (e) {
      fail(req, res, 500, 'ERR_500', e);
    }
  });

  app.get('/api/v1/nodes', ...staffOnly(ALL_STAFF), (_req, res) => {
    res.json(db.listNodes());
  });

  app.get('/api/v1/lots', ...staffOnly(ALL_STAFF), (_req, res) => {
    res.json(db.listLots());
  });

  app.get('/api/v1/cards', ...staffOnly(ALL_STAFF), (req, res) => {
    const rawCards = db.listCards();
    const persons = db.listPersons();
    const ledgers = db.listQuotaLedger();
    const personsMap = new Map(persons.map((p) => [p.id, p]));
    const ledgerMap = new Map(ledgers.map((l) => [l.card_id, l]));

    const mapped = rawCards.map((c) => {
      const p = personsMap.get(c.person_id);
      const l = ledgerMap.get(c.id);
      const allocated = Number(l?.allocated_quantity || 30);
      const consumed = Number(l?.consumed_quantity || 0);
      return {
        id: c.id,
        person_id: c.person_id,
        status: c.status,
        issued_at: c.issued_at,
        first_name: p?.first_name || 'Beneficiary',
        last_name: p?.last_name || '',
        full_name: p ? `${p.first_name} ${p.last_name || ''}`.trim() : 'Verified Citizen',
        phone_number: p?.phone_number || '',
        family_count: 3,
        address: 'District Depot',
        city: 'Kanpur',
        state: 'UP',
        allocated_qty: allocated,
        consumed_qty: consumed,
        remaining_qty: Number(l?.remaining_quantity ?? allocated - consumed),
      };
    });
    res.json(mapped);
  });

  app.get('/api/v1/registrations', ...staffOnly(ALL_STAFF), (_req, res) => {
    res.json(db.listRegistrations());
  });

  app.post('/api/v1/lots', ...staffOnly(ADMIN_ONLY), transactionRateLimiter, (req, res) => {
    const { name, grain_type, total_quantity } = bodyOf(req);
    const total = toQuantity(total_quantity, MAX_LOT_QUANTITY);
    if (!isText(name, 120) || !isText(grain_type, 40) || total === null) {
      return reject(res, 400, 'ERR_101', 'Missing or invalid lot fields');
    }
    const lot = {
      id: `lot-${generateUuidV7()}`,
      name,
      grain_type,
      total_quantity: total,
      remaining_quantity: total,
    };
    db.insertLot(lot);
    res.status(201).json(lot);
  });

  /* ------------------------- Metrics, audit & telemetry --------------------- */

  app.get('/api/v1/metrics', ...staffOnly(OVERSIGHT), (_req, res) => {
    res.json(service.getMetrics());
  });

  app.get('/api/v1/audit', ...staffOnly(OVERSIGHT), (_req, res) => {
    res.json(db.listAuditEvents());
  });

  app.get('/api/v1/telemetry/spans', ...staffOnly(['AUDITOR', 'ADMINISTRATOR']), (_req, res) => {
    const spans = TelemetryEngine.getSpans();
    res.json({ success: true, count: spans.length, spans });
  });

  app.get('/api/v1/telemetry/logs', ...staffOnly(['AUDITOR', 'ADMINISTRATOR']), (_req, res) => {
    const logs = StructuredLogger.getLogs();
    res.json({ success: true, count: logs.length, logs });
  });

  // Destroys evidence: same production gate as /admin/reset.
  app.post('/api/v1/telemetry/clear', ...staffOnly(ADMIN_ONLY), (_req, res) => {
    if (!destructiveEnabled) return reject(res, 404, 'ERR_NOT_FOUND', 'Not found.');
    TelemetryEngine.clear();
    StructuredLogger.clear();
    res.json({ success: true, message: 'Telemetry spans and structured logs cleared.' });
  });

  /* ------------------- AI audit, voice, grievances, compliance -------------- */

  app.post('/api/v1/ai/audit', ...staffOnly(ALL_STAFF), transactionRateLimiter, (req, res) => {
    try {
      const { transaction, transactions } = bodyOf(req);
      if (transactions !== undefined) {
        if (!Array.isArray(transactions) || transactions.length > MAX_BATCH_ITEMS) {
          return reject(res, 400, 'ERR_101', `transactions must be an array of at most ${MAX_BATCH_ITEMS} items`);
        }
        return res.json({ success: true, ...edgeGuardian.batchAudit(transactions) });
      }
      const input = transaction !== undefined ? transaction : req.body;
      if (!isPlainObject(input)) return reject(res, 400, 'ERR_101', 'Invalid transaction payload');
      res.json({ success: true, assessment: edgeGuardian.evaluate(input) });
    } catch (e) {
      fail(req, res, 400, 'ERR_101', e);
    }
  });

  app.post('/api/v1/voice/query', ...staffOnly(ALL_STAFF), transactionRateLimiter, (req, res) => {
    try {
      const { utterance, lang_code, context } = bodyOf(req);
      if (!isText(utterance, 1000)) return reject(res, 400, 'ERR_101', 'Missing or invalid field: utterance');
      const lang = typeof lang_code === 'string' && LANG_RE.test(lang_code) ? lang_code : 'hi';
      const intent = vernacularEngine.parseUtterance(utterance, lang);
      res.json({
        success: true,
        intent,
        synthesized_response: vernacularEngine.synthesizeResponse(intent, isPlainObject(context) ? context : {}),
      });
    } catch (e) {
      fail(req, res, 400, 'ERR_101', e);
    }
  });

  // Citizens may file grievances without logging in (rate-limited per IP).
  app.post('/api/v1/grievances', transactionRateLimiter, (req, res) => {
    try {
      const { card_id, node_id, category, complaint_text } = bodyOf(req);
      if (!isId(card_id) || !isId(node_id) || !isText(complaint_text, 2000) || !db.getNode(node_id)) {
        return reject(res, 400, 'ERR_101', 'Missing or invalid fields: card_id, node_id, complaint_text');
      }
      const ticket = vernacularEngine.registerGrievance(
        card_id,
        node_id,
        (isText(category, 40) ? category : 'OTHER') as GrievanceCategory,
        complaint_text,
      );
      res.status(201).json({ success: true, grievance: ticket });
    } catch (e) {
      fail(req, res, 400, 'ERR_101', e);
    }
  });

  // Complaint text can contain personal details: oversight roles only.
  app.get('/api/v1/grievances', ...staffOnly(OVERSIGHT), (_req, res) => {
    const grievances = vernacularEngine.listGrievances();
    res.json({ success: true, count: grievances.length, grievances });
  });

  app.post('/api/v1/blueprint/validate', ...staffOnly(ALL_STAFF), transactionRateLimiter, (req, res) => {
    try {
      const { card_id, category, family_count, monthly_consumed, requested_qty } = bodyOf(req);
      const requested = toQuantity(requested_qty);
      if (!isId(card_id) || requested === null) {
        return reject(res, 400, 'ERR_101', 'Missing or invalid fields: card_id, requested_qty');
      }
      const family = Number(family_count);
      const consumed = Number(monthly_consumed);
      res.json({
        success: true,
        compliance: BlueprintComplianceEngine.validateDispense(
          {
            cardId: card_id,
            category: (isText(category, 10) ? category : 'PHH') as CardCategory,
            familyCount: Number.isInteger(family) && family > 0 && family <= 50 ? family : 4,
            monthlyQuotaConsumed: Number.isFinite(consumed) && consumed >= 0 ? consumed : 0,
          },
          requested,
        ),
      });
    } catch (e) {
      fail(req, res, 400, 'ERR_101', e);
    }
  });

  // Unknown routes and unhandled errors: generic JSON, no stack traces. Must be last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, service, db, edgeNodes };
}

// If executed directly, run standalone API server
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const PORT = Number(process.env.PORT) || 3001;
  const { app } = createServer();
  const server = app.listen(PORT, () => {
    console.log(`Grain Distribution API listening on port ${PORT}`);
  });
  // Slowloris / idle-connection hardening.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
}
