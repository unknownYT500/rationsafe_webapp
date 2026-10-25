// src/api/server.ts
import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CentralDatabase } from '../database/storage.js';
import { CentralService } from '../services/central-service.js';
import { EdgeDistributionNode } from '../edge-node/edge-node.js';
import { generateNodeKeyPair } from '../core/crypto.js';
import { generateUuidV7 } from '../core/uuidv7.js';
import type { UserRole, SyncBatchRequest } from '../core/types.js';
import {
  helmetMiddleware,
  corsMiddleware,
  globalRateLimiter,
  transactionRateLimiter,
  authRateLimiter,
  adminRateLimiter,
} from './security.js';
import {
  signUserToken,
  verifyUserToken,
  requireAuth,
  requireRole,
  createWebAuthnChallenge,
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

export function createServer(customDb?: CentralDatabase) {
  const app = express();

  // 1. Strict Security Headers (Helmet CSP, HSTS, X-Frame-Options)
  app.use(helmetMiddleware);

  // 2. Domain-Restricted CORS Whitelisting (Replacing insecure wildcard cors)
  app.use(corsMiddleware);

  // 3. Global Sliding-Window Rate Limiting (200 req / 15 min per IP)
  app.use(globalRateLimiter);

  app.use(express.json({ limit: '1mb' }));

  const logger = new StructuredLogger('central_gateway');

  // 4. OpenTelemetry W3C Distributed Tracing & PII-Scrubbed Logging Middleware (Phase 5)
  app.use((req, res, next) => {
    const rawTraceparent = (req.header('traceparent') || req.header('x-traceparent')) as string | undefined;
    const traceCtx = TelemetryEngine.createTraceContext(rawTraceparent);
    (req as any).traceContext = traceCtx;
    (req as any).traceId = traceCtx.traceId;
    TelemetryEngine.setActiveContext(traceCtx);

    res.setHeader('X-Trace-Id', traceCtx.traceId);
    res.setHeader('traceparent', TelemetryEngine.formatTraceparent(traceCtx));
    res.setHeader('traceresponse', TelemetryEngine.formatTraceparent(traceCtx));

    const startTime = Date.now();
    const span = TelemetryEngine.startSpan(`HTTP ${req.method} ${req.path}`, {
      parent: traceCtx,
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.route': req.path,
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

  // Support both /api/v1/... and /v1/... when running behind serverless rewrites
  app.use((req, _res, next) => {
    if (!req.url.startsWith('/api') && req.url.startsWith('/v1')) {
      req.url = '/api' + req.url;
    }
    next();
  });

  const isVercel = Boolean(process.env.VERCEL);
  const dbPath = isVercel
    ? path.join('/tmp', 'central_db.json')
    : path.join(__dirname, '../../data/central_db.json');
  const baseNodesDir = isVercel
    ? path.join('/tmp', 'nodes')
    : path.join(__dirname, '../../data/nodes');

  try {
    fs.mkdirSync(baseNodesDir, { recursive: true });
  } catch {}

  const db = customDb || new CentralDatabase(dbPath);
  const service = new CentralService(db);

  // In-memory registry of EdgeNode instances for interactive demo
  const edgeNodes = new Map<string, EdgeDistributionNode>();
  const edgeGuardian = new EdgeGuardianEngine();
  const vernacularEngine = new VernacularEngine();

  // Ensure default seed data exists
  async function seedDefaults() {
    if (db.listNodes().length === 0) {
      const keysA = await generateNodeKeyPair();
      const nodeAId = 'node-alpha-001';
      db.insertNode({
        id: nodeAId,
        name: 'Distribution Node Alpha (District 1)',
        public_key: keysA.publicKeyHex,
        status: 'ONLINE',
        last_heartbeat: new Date().toISOString(),
        outbox_depth: 0,
        location: 'Sector 4 Community Depot',
      });

      const edgeA = new EdgeDistributionNode({
        nodeId: nodeAId,
        nodeName: 'Distribution Node Alpha',
        privateKeyHex: keysA.privateKeyHex,
        publicKeyHex: keysA.publicKeyHex,
        dataDir: baseNodesDir,
      });
      edgeNodes.set(nodeAId, edgeA);

      const keysB = await generateNodeKeyPair();
      const nodeBId = 'node-beta-002';
      db.insertNode({
        id: nodeBId,
        name: 'Distribution Node Beta (Rural Outpost)',
        public_key: keysB.publicKeyHex,
        status: 'ONLINE',
        last_heartbeat: new Date().toISOString(),
        outbox_depth: 0,
        location: 'Rural Outpost Station 9',
      });

      const edgeB = new EdgeDistributionNode({
        nodeId: nodeBId,
        nodeName: 'Distribution Node Beta',
        privateKeyHex: keysB.privateKeyHex,
        publicKeyHex: keysB.publicKeyHex,
        dataDir: baseNodesDir,
      });
      edgeNodes.set(nodeBId, edgeB);
    } else {
      // Re-hydrate edge nodes
      for (const n of db.listNodes()) {
        if (!edgeNodes.has(n.id)) {
          const keys = await generateNodeKeyPair();
          const edge = new EdgeDistributionNode({
            nodeId: n.id,
            nodeName: n.name,
            privateKeyHex: keys.privateKeyHex,
            publicKeyHex: n.public_key || keys.publicKeyHex,
            dataDir: baseNodesDir,
          });
          edgeNodes.set(n.id, edge);
        }
      }
    }

    if (db.listLots().length === 0) {
      const lot1Id = 'lot-wheat-2026-01';
      db.insertLot({
        id: lot1Id,
        name: 'National Reserve Wheat Batch 2026-A',
        grain_type: 'Wheat',
        total_quantity: 5000,
        remaining_quantity: 4850,
      });

      const lot2Id = 'lot-rice-2026-02';
      db.insertLot({
        id: lot2Id,
        name: 'Basmati Emergency Stockpile',
        grain_type: 'Rice',
        total_quantity: 3000,
        remaining_quantity: 2950,
      });

      // Seed grants
      const nodes = db.listNodes();
      for (const n of nodes) {
        db.insertLotGrant({
          id: generateUuidV7(),
          lot_id: lot1Id,
          node_id: n.id,
          max_quantity: 500,
          remaining_quantity: 500,
          expires_at: Math.floor(Date.now() / 1000) + 86400 * 7,
          signature: 'sig_grant_valid',
        });
        const edge = edgeNodes.get(n.id);
        if (edge) {
          edge.setGrant(lot1Id, 500, Math.floor(Date.now() / 1000) + 86400 * 7);
        }
      }
    }
  }

  seedDefaults().catch(console.error);

  // --- API Routes ---

  // Health
  app.get('/api/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.json({ status: 'UP', message: 'RationSafe Sovereign API running with Zero-Trust Security Suite.' });
  });

  // --- Authentication & Identity Endpoints (Zero-Trust) ---
  app.post('/api/v1/auth/login', authRateLimiter, (req, res) => {
    const { username, role, node_id } = req.body;
    const assignedRole = (role as UserRole) || 'DISTRIBUTION_OPERATOR';
    const actorId = username ? `user-${username.toLowerCase().replace(/[^a-z0-9]/g, '')}` : `op-${Date.now().toString(36)}`;
    const token = signUserToken({
      id: actorId,
      name: username ? `${username} (${assignedRole})` : 'Distribution Operator',
      role: assignedRole,
      node_id: node_id || 'node-alpha-001',
    }, 'JWT_BEARER');

    res.json({
      success: true,
      token,
      user: {
        id: actorId,
        role: assignedRole,
        node_id: node_id || 'node-alpha-001',
        auth_method: 'JWT_BEARER',
      },
      expires_in: '8h',
    });
  });

  app.post('/api/v1/auth/webauthn/challenge', authRateLimiter, (req, res) => {
    const { user_id } = req.body;
    const { challenge, ticket } = createWebAuthnChallenge(user_id || 'operator-01');
    res.json({
      challenge,
      ticket,
      rp: { name: 'RationSafe Sovereign PDS', id: 'localhost' },
      user: { id: user_id || 'operator-01', name: 'operator@rationsafe.pds', displayName: 'Fair Price Shop Operator' },
    });
  });

  app.post('/api/v1/auth/webauthn/verify', authRateLimiter, (req, res) => {
    const { ticket, clientDataJSON, user_id, role, node_id } = req.body;
    const valid = verifyWebAuthnChallenge(ticket, clientDataJSON || '');
    if (!valid && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ code: 'ERR_WEBAUTHN_FAILED', message: 'Biometric verification challenge expired or failed.' });
    }
    const actorId = user_id || 'biometric-verified-operator';
    const assignedRole = (role as UserRole) || 'DISTRIBUTION_OPERATOR';
    const token = signUserToken({
      id: actorId,
      name: 'Biometric Authenticated Operator',
      role: assignedRole,
      node_id: node_id || 'node-alpha-001',
    }, 'WEBAUTHN_FIDO2');

    res.json({
      success: true,
      token,
      auth_method: 'WEBAUTHN_FIDO2',
      user: { id: actorId, role: assignedRole, node_id: node_id || 'node-alpha-001' },
    });
  });

  app.get('/api/v1/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // 1a. Dynamic Ephemeral QR Verification (Anti-Replay & 180s TTL)
  app.post('/api/v1/qr/verify', requireAuth, (req, res) => {
    const { qr_payload } = req.body;
    if (!qr_payload) {
      return res.status(400).json({ code: 'ERR_QR_MALFORMED', message: 'Missing qr_payload' });
    }
    const result = verifyEphemeralQrToken(qr_payload);
    if (!result.isValid) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  // 1. Registrations (PRD 3.1 & TRD Section 2)
  app.post('/api/v1/registrations', (req, res) => {
    try {
      const actor = req.user?.id || (req.headers['x-user-id'] as string) || 'public-applicant';
      const nodeId = (req.body as any)?.node_id;
      const record = service.submitRegistration(req.body, actor, nodeId);
      res.status(201).json(record);
    } catch (e: any) {
      res.status(400).json({ code: 'ERR_101', message: e.message });
    }
  });

  app.get('/api/v1/registrations', (req, res) => {
    res.json(db.listRegistrations());
  });

  app.post(
    '/api/v1/registrations/:id/verify',
    requireAuth,
    requireRole(['REGISTRATION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR']),
    (req, res) => {
      try {
        const actor = req.user?.id || 'operator';
        const record = service.verifyRegistration(req.params.id as string, actor);
        res.json(record);
      } catch (e: any) {
        res.status(400).json({ code: 'ERR_401', message: e.message });
      }
    }
  );

  app.post(
    '/api/v1/registrations/:id/approve',
    requireAuth,
    requireRole(['SUPERVISOR', 'ADMINISTRATOR']),
    (req, res) => {
      try {
        const actor = req.user?.id || 'admin';
        const result = service.approveRegistration(req.params.id as string, actor);
        // Update in-memory edgeNodes map so offline mode immediately has local lease
        const allocatedQuota = result.registration.data.family_count * 10;
        for (const edge of edgeNodes.values()) {
          edge.allocateLocalLease(result.card.id, allocatedQuota);
        }
        res.status(200).json(result);
      } catch (e: any) {
        res.status(400).json({ code: 'ERR_401', message: e.message });
      }
    }
  );

  app.get('/api/v1/cards', (req, res) => {
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

  // 2. Beneficiary Lookup & Autofill (PRD 3.3, TRD Section 2)
  app.get('/api/v1/persons/:id', requireAuth, (req, res) => {
    try {
      const role = (req.user?.role || 'DISTRIBUTION_OPERATOR') as UserRole;
      const actor = req.user?.id || 'staff-user';
      const data = service.lookupPerson(req.params.id as string, role, actor);
      res.json(data);
    } catch (e: any) {
      res.status(404).json({ code: 'ERR_404', message: e.message });
    }
  });

  app.post('/api/v1/persons/:id/autofill', requireAuth, (req, res) => {
    try {
      const role = (req.user?.role || 'DISTRIBUTION_OPERATOR') as UserRole;
      const actor = req.user?.id || 'staff-user';
      const template = req.body.template || 'DISTRIBUTION_RECEIPT';
      const doc = service.autofillTemplate(req.params.id as string, template, role, actor);
      res.json(doc);
    } catch (e: any) {
      res.status(404).json({ code: 'ERR_404', message: e.message });
    }
  });

  // 3. Transactions (TRD Section 1 & api-spec.yaml)
  app.post(
    '/api/v1/transactions',
    transactionRateLimiter,
    requireAuth,
    requireRole(['DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR']),
    (req, res) => {
      const idempotencyKey = req.headers['idempotency-key'] as string;
      if (!idempotencyKey) {
        return res.status(400).json({
          code: 'ERR_101',
          message: "Missing mandatory 'Idempotency-Key' header",
          retryable: false,
        });
      }

      const { card_id, lot_id, node_id, quantity } = req.body;
      if (!card_id || !lot_id || !quantity) {
        return res.status(400).json({ code: 'ERR_101', message: 'Missing required transaction fields' });
      }

      const actor = req.user?.id || 'distribution-operator';
      const result = service.processOnlineTransaction({
        cardId: card_id,
        lotId: lot_id,
        nodeId: node_id || db.listNodes()[0]?.id || 'node-default',
        quantity: Number(quantity),
        idempotencyKey,
        actorId: actor,
      });

      res.status(result.status).json(result.body);
    }
  );

  app.get('/api/v1/transactions', (req, res) => {
    res.json(db.listTransactions());
  });

  app.get('/api/v1/transactions/:id/history', (req, res) => {
    res.json(db.getStateHistory(req.params.id as string));
  });

  // 4. Batch Sync (api-spec.yaml, reconciliation.md)
  app.post('/api/v1/nodes/:id/sync', transactionRateLimiter, async (req, res) => {
    try {
      const result = await service.reconcileBatch(req.params.id as string, req.body as SyncBatchRequest);
      res.status(200).json(result);
    } catch (e: any) {
      res.status(400).json({ code: 'ERR_401', message: e.message });
    }
  });

  // 5. Edge Node Local Operations
  app.get('/api/v1/edge-nodes/:id/status', (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return res.status(404).json({ message: 'Edge node not found' });
    res.json({
      nodeId: edge.config.nodeId,
      counter: edge.getCounter(),
      outboxDepth: edge.getOutboxDepth(),
      isOnline: edge.isOnline,
    });
  });

  app.post('/api/v1/edge-nodes/:id/issue', transactionRateLimiter, async (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return res.status(404).json({ message: 'Edge node not found' });
    try {
      const { card_id, lot_id, grant_id, quantity, allow_fallback } = req.body;
      const result = await edge.issueProvisionalGrain({
        cardId: card_id,
        lotId: lot_id,
        grantId: grant_id || lot_id,
        quantity: Number(quantity),
        idempotencyKey: (req.headers['idempotency-key'] as string) || generateUuidV7(),
        allowFallback: Boolean(allow_fallback),
      });

      // Update central node outbox tracking
      const centralNode = db.getNode(req.params.id as string);
      if (centralNode) {
        centralNode.outbox_depth = edge.getOutboxDepth();
        db.updateNode(centralNode);
      }

      res.status(200).json(result);
    } catch (e: any) {
      res.status(409).json({ code: 'ERR_409', message: e.message });
    }
  });

  app.post('/api/v1/edge-nodes/:id/sync-now', transactionRateLimiter, async (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return res.status(404).json({ message: 'Edge node not found' });

    const batch = edge.generateSyncBatch();
    if (!batch) {
      return res.json({ message: 'Outbox empty, nothing to sync', synced: 0 });
    }

    try {
      const syncResponse = await service.reconcileBatch(req.params.id as string, batch);
      edge.processSyncResponse(syncResponse);

      const centralNode = db.getNode(req.params.id as string);
      if (centralNode) {
        centralNode.outbox_depth = edge.getOutboxDepth();
        db.updateNode(centralNode);
      }

      res.json(syncResponse);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post('/api/v1/edge-nodes/:id/toggle-online', (req, res) => {
    const edge = edgeNodes.get(req.params.id as string);
    if (!edge) return res.status(404).json({ message: 'Edge node not found' });
    edge.isOnline = !edge.isOnline;

    const centralNode = db.getNode(req.params.id as string);
    if (centralNode) {
      centralNode.status = edge.isOnline ? 'ONLINE' : 'OFFLINE';
      db.updateNode(centralNode);
    }

    res.json({ isOnline: edge.isOnline });
  });

  // 6. Quotas & Admin (TRD Section 2)
  app.get('/api/v1/admin/quotas', (req, res) => {
    res.json({
      lots: db.listLots(),
      grants: db.listGrants(),
      quotas: db.listQuotaLedger(),
      cards: db.listCards(),
    });
  });

  app.post('/api/v1/admin/leases', (req, res) => {
    const { card_id, node_id, quantity } = req.body;
    db.setQuotaLedger({
      id: generateUuidV7(),
      card_id,
      node_id,
      allocated_qty: Number(quantity),
      consumed_qty: 0,
      period_start: new Date().toISOString().slice(0, 10),
    });

    const edge = edgeNodes.get(node_id);
    if (edge) {
      edge.allocateLocalLease(card_id, Number(quantity));
    }

    res.json({ success: true, message: 'Quota lease allocated successfully' });
  });

  app.get('/api/v1/nodes', (req, res) => {
    res.json(db.listNodes());
  });

  app.get('/api/v1/lots', (req, res) => {
    res.json(db.listLots());
  });

  app.post('/api/v1/lots', (req, res) => {
    const { name, grain_type, total_quantity } = req.body;
    const lotId = `lot-${Date.now()}`;
    const lot = {
      id: lotId,
      name,
      grain_type,
      total_quantity: Number(total_quantity),
      remaining_quantity: Number(total_quantity),
    };
    db.insertLot(lot);
    res.status(201).json(lot);
  });

  // 7. Metrics & Analytics (failure-catalog.md)
  app.get('/api/v1/metrics', (req, res) => {
    res.json(service.getMetrics());
  });

  // 8. Immutable Audit Log (PRD 4 & database.md)
  app.get('/api/v1/audit', (req, res) => {
    res.json(db.listAuditEvents());
  });

  // 9. Clear Full Database and Reset State (Admin reset)
  app.post(
    '/api/v1/admin/reset',
    adminRateLimiter,
    requireAuth,
    requireRole(['ADMINISTRATOR']),
    async (req, res) => {
      try {
        db.clearAllData();
        const nodeDir = path.join(__dirname, '../../data/nodes');
        if (fs.existsSync(nodeDir)) {
          const files = fs.readdirSync(nodeDir);
          for (const file of files) {
            try {
              fs.unlinkSync(path.join(nodeDir, file));
            } catch {}
          }
        }
        edgeNodes.clear();
        await seedDefaults();
        res.json({ success: true, message: 'All database records and stored state cleared successfully' });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // 10. Adaption Labs AI & Edge Guardian Anomaly Audit (Phase 4)
  app.post('/api/v1/ai/audit', (req, res) => {
    try {
      const { transaction, transactions } = req.body;
      if (transactions && Array.isArray(transactions)) {
        const batchResult = edgeGuardian.batchAudit(transactions);
        return res.json({ success: true, ...batchResult });
      }
      if (transaction) {
        const assessment = edgeGuardian.evaluate(transaction);
        return res.json({ success: true, assessment });
      }
      const assessment = edgeGuardian.evaluate(req.body);
      res.json({ success: true, assessment });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // 11. Vernacular Voice Natural Language Query (Phase 4)
  app.post('/api/v1/voice/query', (req, res) => {
    try {
      const { utterance, lang_code, context } = req.body;
      if (!utterance) {
        return res.status(400).json({ error: 'Missing required field: utterance' });
      }
      const intent = vernacularEngine.parseUtterance(utterance, lang_code || 'hi');
      const synthesizedResponse = vernacularEngine.synthesizeResponse(intent, context || {});
      res.json({
        success: true,
        intent,
        synthesized_response: synthesizedResponse,
      });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // 12. Citizen Grievance Registry (Phase 4)
  app.post('/api/v1/grievances', (req, res) => {
    try {
      const { card_id, node_id, category, complaint_text } = req.body;
      if (!card_id || !node_id || !complaint_text) {
        return res.status(400).json({ error: 'Missing required fields: card_id, node_id, complaint_text' });
      }
      const ticket = vernacularEngine.registerGrievance(
        card_id,
        node_id,
        (category as GrievanceCategory) || 'OTHER',
        complaint_text
      );
      res.status(201).json({ success: true, grievance: ticket });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  app.get('/api/v1/grievances', (req, res) => {
    res.json({
      success: true,
      count: vernacularEngine.listGrievances().length,
      grievances: vernacularEngine.listGrievances(),
    });
  });

  // 13. Blueprint Statutory Policy & NFSA Entitlement Validation (Phase 4)
  app.post('/api/v1/blueprint/validate', (req, res) => {
    try {
      const { card_id, category, family_count, monthly_consumed, requested_qty } = req.body;
      if (!card_id || requested_qty === undefined) {
        return res.status(400).json({ error: 'Missing required fields: card_id, requested_qty' });
      }
      const result = BlueprintComplianceEngine.validateDispense(
        {
          cardId: card_id,
          category: (category as CardCategory) || 'PHH',
          familyCount: Number(family_count) || 4,
          monthlyQuotaConsumed: Number(monthly_consumed) || 0,
        },
        Number(requested_qty)
      );
      res.json({ success: true, compliance: result });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // 14. OpenTelemetry Spans & Distributed Trace Records (Phase 5)
  app.get('/api/v1/telemetry/spans', (_req, res) => {
    res.json({
      success: true,
      count: TelemetryEngine.getSpans().length,
      spans: TelemetryEngine.getSpans(),
    });
  });

  // 15. PII-Scrubbed Structured Audit Logs (Phase 5)
  app.get('/api/v1/telemetry/logs', (_req, res) => {
    res.json({
      success: true,
      count: StructuredLogger.getLogs().length,
      logs: StructuredLogger.getLogs(),
    });
  });

  // 16. Reset Telemetry Buffers (Phase 5 Test / Maintenance)
  app.post('/api/v1/telemetry/clear', (_req, res) => {
    TelemetryEngine.clear();
    StructuredLogger.clear();
    res.json({ success: true, message: 'Telemetry spans and structured logs cleared.' });
  });

  return { app, service, db, edgeNodes };
}

// If executed directly, run standalone API server
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const PORT = process.env.PORT || 3001;
  const { app } = createServer();
  app.listen(PORT, () => {
    console.log(`Grain Distribution API running on http://localhost:${PORT}`);
  });
}
