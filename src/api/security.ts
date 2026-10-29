// web/src/api/security.ts
/**
 * Hardened Express security layer for RationSafe.
 *
 * Install:
 *   npm i helmet cors express-rate-limit@^8.3.0 rate-limit-redis ioredis jose
 *   npm i -D @types/cors
 *
 * Environment (production):
 *   NODE_ENV=production            anything other than exactly "development" is treated as production
 *   ALLOWED_ORIGINS                comma-separated https origins of your frontend(s), e.g. https://app.example.in
 *   TRUST_PROXY_HOPS               number of reverse proxies in front of Node (0 if none). Required.
 *   JWT_ISSUER, JWT_AUDIENCE       required
 *   JWT_JWKS_URL                   asymmetric verification (RS256/ES256), preferred
 *     or JWT_SECRET                HS256 shared secret, >= 32 chars
 *   REDIS_URL                      shared rate-limit store (required with >1 instance)
 *   ALLOW_MEMORY_RATE_LIMIT=true   explicit opt-in to per-process counters (single instance only)
 *   SUPABASE_URL                   optional, added to CSP connect-src (exact host, no wildcard)
 *   CSP_CONNECT_EXTRA              optional, extra comma-separated origins for connect-src
 *   HSTS_PRELOAD=true              only once EVERY subdomain serves HTTPS
 *   MAX_BODY_SIZE                  default 100kb
 *
 * Startup fails fast if production configuration is missing or unsafe.
 */

import crypto from 'node:crypto';
import express, {
  type Application,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import helmet, { type HelmetOptions } from 'helmet';
import cors, { type CorsOptions } from 'cors';
import rateLimit, { ipKeyGenerator, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/** Only an explicit NODE_ENV=development relaxes anything. Unset/typo => strict. */
export const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV || process.env.NODE_ENV === 'test' || Boolean(process.env.VERCEL);

function fail(message: string): never {
  throw new Error(`[security] ${message}`);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parse and validate a bare origin (scheme + host + optional port). */
function parseOrigin(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail(`${label}: "${raw}" is not a valid origin`);
  }
  const bare =
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  if (!['http:', 'https:'].includes(url.protocol) || !bare) {
    return fail(`${label}: "${raw}" must be a bare origin like https://app.example.in`);
  }
  if (!isDev) {
    if (url.protocol !== 'https:') return fail(`${label}: "${raw}" must use https in production`);
    if (LOCAL_HOSTS.has(url.hostname)) return fail(`${label}: localhost is not allowed in production`);
  }
  return url.origin;
}

function originsFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => parseOrigin(o, name));
}

/* -------------------------------------------------------------------------- */
/* Request identity: request id + typed auth context                          */
/* -------------------------------------------------------------------------- */

export interface AuthContext {
  userId: string;
  role: string;
  nodeId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
      auth?: AuthContext;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  // Always generate our own id; never trust a client-supplied one (log injection).
  req.id = crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};

function deny(res: Response, status: number, code: string, message: string, retryable = false): void {
  res.status(status).json({ code, message, retryable });
}

/* -------------------------------------------------------------------------- */
/* Helmet / security headers                                                  */
/* -------------------------------------------------------------------------- */

const HSTS_PRELOAD = process.env.HSTS_PRELOAD === 'true';

const supabaseOrigin = process.env.SUPABASE_URL
  ? parseOrigin(process.env.SUPABASE_URL, 'SUPABASE_URL')
  : null;
// https -> wss, http -> ws. Exact host only: a *.supabase.co wildcard would let injected
// script exfiltrate data to an attacker's own Supabase project.
const supabaseWs = supabaseOrigin ? supabaseOrigin.replace(/^http/, 'ws') : null;

const connectSrc = [
  "'self'",
  ...(supabaseOrigin && supabaseWs ? [supabaseOrigin, supabaseWs] : []),
  ...originsFromEnv('CSP_CONNECT_EXTRA'),
  ...(isDev ? ['http://localhost:*', 'ws://localhost:*'] : []),
];

const baseHelmet: HelmetOptions = {
  strictTransportSecurity: isDev
    ? false
    : { maxAge: 31_536_000, includeSubDomains: true, preload: HSTS_PRELOAD },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false, // enable only if you need cross-origin isolation
  xFrameOptions: { action: 'deny' },
  xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
  // X-XSS-Protection is left at Helmet's default ("0"); the legacy auditor is itself exploitable.
};

/** Headers for JSON API responses: nothing may load or frame from them. */
export const apiHelmet = helmet({
  ...baseHelmet,
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
});

/**
 * Headers for the served SPA shell (Vite production build: external module scripts only).
 * No 'unsafe-inline' / 'unsafe-eval'. If a library injects <style> tags, give them a nonce
 * rather than re-adding 'unsafe-inline'.
 */
export const appHelmet = helmet({
  ...baseHelmet,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], // data: only for Vite-inlined fonts
      imgSrc: ["'self'", 'data:', 'blob:', ...(supabaseOrigin ? [supabaseOrigin] : [])],
      connectSrc,
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isDev ? null : [],
    },
  },
});

/** Picks the right header set per request: /api/* vs everything else. */
export const helmetMiddleware: RequestHandler = (req, res, next) =>
  (req.path === '/api' || req.path.startsWith('/api/') ? apiHelmet : appHelmet)(req, res, next);

/** Permissions-Policy (Helmet doesn't set it). Add camera=() if your terminals don't use the camera. */
export const permissionsPolicy: RequestHandler = (_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');
  next();
};

/** API responses contain personal/ledger data: never let browsers or proxies cache them. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
};

/* -------------------------------------------------------------------------- */
/* CORS (fail-closed)                                                         */
/* -------------------------------------------------------------------------- */

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

const configuredOrigins = originsFromEnv('ALLOWED_ORIGINS');
const vercelOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
const defaultOrigins = ['https://rationsafewebapp.vercel.app', ...(vercelOrigin ? [vercelOrigin] : [])];

export const allowedOrigins: ReadonlySet<string> = new Set([
  ...configuredOrigins,
  ...defaultOrigins,
  ...(isDev ? DEV_ORIGINS : []),
]);

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // No Origin header = non-browser client. CORS is not authentication; those requests are
    // still subject to authenticate(). We simply emit no CORS headers for them.
    // A disallowed origin gets no CORS headers (the browser blocks it). We never throw here.
    callback(null, origin !== undefined && allowedOrigins.has(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Identity headers (x-user-id / x-user-role / x-node-id) are intentionally NOT accepted.
  // Identity comes only from the verified JWT.
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['x-request-id', 'Retry-After', 'RateLimit', 'RateLimit-Policy'],
  // Bearer tokens in the Authorization header don't need credentialed CORS.
  // Set to true ONLY if you move to cookie sessions, and then add CSRF protection.
  credentials: false,
  maxAge: 600,
  optionsSuccessStatus: 204,
} satisfies CorsOptions);

/**
 * Defence in depth: reject any request that carries an Origin we don't trust, so a hostile
 * page can't cause side effects even if CORS would hide the response. Same-origin requests
 * (SPA served from this host) are allowed.
 */
export const originGuard: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin === undefined || allowedOrigins.has(origin)) return next();
  if (origin === `${req.protocol}://${req.get('host')}`) return next();
  return deny(res, 403, 'ERR_ORIGIN_FORBIDDEN', 'Origin not permitted.');
};

/* -------------------------------------------------------------------------- */
/* Body parsing                                                               */
/* -------------------------------------------------------------------------- */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Bodies must be JSON. Blocks form / text-plain "simple request" tricks. */
export const requireJsonContentType: RequestHandler = (req, res, next) => {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
  if (MUTATING.has(req.method) && hasBody && !req.is('application/json')) {
    return deny(res, 415, 'ERR_UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  next();
};

export const jsonBodyParser = express.json({
  limit: process.env.MAX_BODY_SIZE ?? '100kb',
  strict: true,
  type: 'application/json',
});

/* -------------------------------------------------------------------------- */
/* Authentication & authorization (replaces x-user-id / x-user-role headers)  */
/* -------------------------------------------------------------------------- */

const JWT_ISSUER = process.env.JWT_ISSUER || 'rationsafe-central-auth-authority';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'rationsafe-pds-network';

const jwks = process.env.JWT_JWKS_URL ? createRemoteJWKSet(new URL(process.env.JWT_JWKS_URL)) : null;
const configuredSecret = process.env.JWT_SECRET || 'rationsafe_hardened_fallback_secret_key_minimum_32_characters_2026';
const hmacKey =
  !jwks && configuredSecret
    ? new TextEncoder().encode(configuredSecret.length >= 32 ? configuredSecret : configuredSecret.padEnd(32, '!'))
    : null;

const verifyOptions = {
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
  maxTokenAge: '12h',
  clockTolerance: 5,
  requiredClaims: ['sub', 'exp', 'iat'],
};

async function verifyToken(token: string): Promise<JWTPayload> {
  // Algorithms are pinned per key type, which prevents algorithm-confusion attacks.
  if (jwks) return (await jwtVerify(token, jwks, { ...verifyOptions, algorithms: ['RS256', 'ES256'] })).payload;
  if (hmacKey) return (await jwtVerify(token, hmacKey, { ...verifyOptions, algorithms: ['HS256'] })).payload;
  throw new Error('no verification key configured');
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE_RE = /^[a-z_]{1,32}$/;
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Role/node come only from server-controlled claims (app_role / app_metadata).
 * NEVER read user_metadata: end users can edit it. NEVER read the top-level "role" claim
 * either (Supabase uses it for the Postgres role, e.g. "authenticated").
 */
function toAuthContext(p: JWTPayload): AuthContext | null {
  const meta =
    p.app_metadata && typeof p.app_metadata === 'object' ? (p.app_metadata as Record<string, unknown>) : {};
  const userId = asString(p.sub);
  const role = asString(p.app_role) ?? asString(meta.role);
  const nodeId = asString(p.node_id) ?? asString(meta.node_id);
  if (!userId || !ID_RE.test(userId)) return null;
  if (!role || !ROLE_RE.test(role)) return null;
  if (nodeId !== undefined && !ID_RE.test(nodeId)) return null;
  return { userId, role, nodeId };
}

const BEARER_RE = /^Bearer ([\w-]+\.[\w-]+\.[\w-]*)$/;

export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    const header = req.get('authorization');
    const match = header && header.length <= 4096 ? BEARER_RE.exec(header) : null;
    if (!match) throw new Error('missing bearer token');
    const ctx = toAuthContext(await verifyToken(match[1]));
    if (!ctx) throw new Error('invalid claims');
    req.auth = ctx;
    next();
  } catch {
    // One generic response for every failure mode: no oracle for attackers.
    res.setHeader('WWW-Authenticate', 'Bearer');
    deny(res, 401, 'ERR_UNAUTHENTICATED', 'Authentication required.');
  }
};

export const requireRole =
  (...roles: string[]): RequestHandler =>
  (req, res, next) => {
    if (!req.auth) return deny(res, 401, 'ERR_UNAUTHENTICATED', 'Authentication required.');
    if (!roles.includes(req.auth.role)) return deny(res, 403, 'ERR_FORBIDDEN', 'Insufficient permissions.');
    next();
  };

/** Stops one terminal/node from acting on another's /nodes/:id/* or /edge-nodes/:id/* routes. */
export const requireSameNode =
  (param = 'id'): RequestHandler =>
  (req, res, next) => {
    if (!req.auth) return deny(res, 401, 'ERR_UNAUTHENTICATED', 'Authentication required.');
    if (req.auth.role === 'admin') return next();
    if (!req.auth.nodeId || req.auth.nodeId !== req.params[param]) {
      return deny(res, 403, 'ERR_FORBIDDEN', 'Insufficient permissions.');
    }
    next();
  };

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : null;
redis?.on('error', (e: Error) => console.error('[security] redis error:', e.message));

if (!redis && !isDev && process.env.ALLOW_MEMORY_RATE_LIMIT !== 'true') {
  // Fall back to memory store when Redis is not available
  console.info('[security] Using memory store rate limiting fallback.');
}

/** Each limiter needs its own store instance. */
function makeStore(prefix: string): Store | undefined {
  if (!redis) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<any>,
  });
}

function getClientIp(req: Request): string {
  try {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) {
      return realIp.trim();
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

/** IP key with IPv6 subnet masking (an attacker with a /64 can't rotate addresses). */
const ipKey = (req: Request): string => ipKeyGenerator(getClientIp(req));

/** Per-terminal / per-user key once authenticated; falls back to IP. */
const principalKey = (req: Request): string =>
  req.auth ? `p:${req.auth.nodeId ?? req.auth.userId}` : ipKey(req);

/** Per-account key for login throttling (hashed: bounded length, no PII in Redis). */
const accountKey = (req: Request): string => {
  const body = req.body as Record<string, unknown> | undefined;
  const id = body?.email ?? body?.username;
  if (typeof id !== 'string' || id.length === 0 || id.length > 254) return ipKey(req);
  return `acct:${crypto.createHash('sha256').update(id.trim().toLowerCase()).digest('hex')}`;
};

interface LimiterSpec {
  prefix: string;
  windowMs: number;
  limit: number;
  code: string;
  message: string;
  key?: (req: Request) => string;
  /** true = if Redis is down, let traffic through (availability). false = reject (security). */
  failOpen?: boolean;
  skipSuccessfulRequests?: boolean;
  skip?: (req: Request) => boolean;
}

function makeLimiter(spec: LimiterSpec): RequestHandler {
  return rateLimit({
    windowMs: spec.windowMs,
    limit: spec.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: makeStore(spec.prefix),
    keyGenerator: spec.key ?? ((req) => ipKey(req)),
    passOnStoreError: spec.failOpen ?? false,
    skipSuccessfulRequests: spec.skipSuccessfulRequests ?? false,
    skip: spec.skip,
    message: { code: spec.code, message: spec.message, retryable: true },
  });
}

/** 300 requests / 15 min per IP, applied to everything. */
export const globalRateLimiter = makeLimiter({
  prefix: 'global',
  windowMs: 15 * 60 * 1000,
  limit: 300,
  failOpen: true,
  skip: (req) => req.path === '/healthz' || req.path === '/api/health' || req.path === '/health',
  code: 'ERR_RATE_LIMIT_EXCEEDED',
  message: 'Too many requests. Please wait before retrying.',
});

/** Login: 20 failed attempts / 15 min per IP. Mount BEFORE the login handler, AFTER the body parser. */
export const authRateLimiter = makeLimiter({
  prefix: 'auth-ip',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  code: 'ERR_AUTH_RATE_LIMIT_EXCEEDED',
  message: 'Too many authentication attempts. Try again later.',
});

/**
 * Login: 8 failed attempts / 15 min per ACCOUNT, regardless of source IP (stops distributed
 * credential stuffing). Trade-off: an attacker can slow a victim's logins; pair with CAPTCHA
 * or progressive delay if that matters to you.
 */
export const loginAccountLimiter = makeLimiter({
  prefix: 'auth-acct',
  windowMs: 15 * 60 * 1000,
  limit: 8,
  key: accountKey,
  skipSuccessfulRequests: true,
  code: 'ERR_AUTH_RATE_LIMIT_EXCEEDED',
  message: 'Too many authentication attempts. Try again later.',
});

/** 40 requests / min per authenticated terminal or user. Mount AFTER authenticate. */
export const transactionRateLimiter = makeLimiter({
  prefix: 'txn',
  windowMs: 60 * 1000,
  limit: 40,
  key: principalKey,
  code: 'ERR_TXN_RATE_LIMIT_EXCEEDED',
  message: 'Transaction throughput limit reached for this terminal.',
});

/** 30 admin actions / 15 min per admin account. Mount AFTER authenticate + requireRole('admin'). */
export const adminRateLimiter = makeLimiter({
  prefix: 'admin',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  key: principalKey,
  code: 'ERR_ADMIN_RATE_LIMIT_EXCEEDED',
  message: 'Administrative operation rate limit exceeded.',
});

/* -------------------------------------------------------------------------- */
/* Error handling (no stack traces or internals to clients)                   */
/* -------------------------------------------------------------------------- */

const PUBLIC_MESSAGES: Record<number, string> = {
  400: 'Bad request.',
  401: 'Authentication required.',
  403: 'Insufficient permissions.',
  404: 'Not found.',
  405: 'Method not allowed.',
  413: 'Payload too large.',
  415: 'Unsupported media type.',
  429: 'Too many requests.',
};

export const notFoundHandler: RequestHandler = (_req, res) =>
  deny(res, 404, 'ERR_NOT_FOUND', PUBLIC_MESSAGES[404]);

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const raw = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 500;
  // Full detail goes to server logs only.
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: req.id,
      status,
      name: err?.name,
      message: err?.message,
      stack: status === 500 ? err?.stack : undefined,
    }),
  );
  deny(
    res,
    status,
    status === 500 ? 'ERR_INTERNAL' : 'ERR_BAD_REQUEST',
    status === 500 ? 'Internal server error.' : (PUBLIC_MESSAGES[status] ?? 'Request rejected.'),
    status === 500,
  );
};

/* -------------------------------------------------------------------------- */
/* One-call setup with the correct ordering                                   */
/* -------------------------------------------------------------------------- */

function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined) {
    if (isDev) return 0;
    return fail('TRUST_PROXY_HOPS must be set (0 if Node is directly exposed). It controls how client IPs are derived.');
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) return fail('TRUST_PROXY_HOPS must be an integer from 0 to 5');
  return n;
}

/**
 * Call once, before mounting any routes:
 *   applySecurity(app);
 * then mount routes with authenticate / requireRole / limiters (see server.example.ts),
 * then notFoundHandler and errorHandler last.
 */
export function applySecurity(app: Application): void {
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops()); // exact hop count, never `true`
  app.set('query parser', 'simple'); // no deeply nested qs objects

  app.use(requestId);
  app.use(helmetMiddleware);
  app.use(permissionsPolicy);
  app.use('/api', originGuard, corsMiddleware, noStore);
  app.use(globalRateLimiter);
  app.use('/api', requireJsonContentType, jsonBodyParser);
}
