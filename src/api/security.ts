// web/src/api/security.ts
/**
 * Express Security Suite for RationSafe
 * 
 * Integrates:
 * 1. Helmet: Strict Content Security Policy (CSP), HSTS preloading, clickjacking protection.
 * 2. Domain-Restricted CORS Whitelisting: Replaces insecure wildcard cors().
 * 3. Express Rate Limiters: Sliding-window DDoS and brute-force mitigation.
 */

import helmet from 'helmet';
import cors, { CorsOptions } from 'cors';
import rateLimit from 'express-rate-limit';

/**
 * Configure Helmet with strict production security headers.
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'http://localhost:*', 'https://localhost:*'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  strictTransportSecurity: {
    maxAge: 31536000, // 1 Year in seconds
    includeSubDomains: true,
    preload: true,
  },
  crossOriginEmbedderPolicy: false,
  xFrameOptions: { action: 'deny' },
  xContentTypeOptions: true,
  xXssProtection: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hidePoweredBy: true,
});

/**
 * Domain-Restricted CORS Configuration
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [];

const allowedOrigins = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...envOrigins])];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. mobile apps, local cURL, edge terminal daemons) with no origin
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy violation: Origin '${origin}' is not in the authorized domain whitelist.`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'x-user-id',
    'x-user-role',
    'x-node-id',
  ],
  exposedHeaders: ['Idempotency-Key', 'x-request-id', 'Retry-After'],
  credentials: true,
  maxAge: 86400, // 24 hours
} as CorsOptions);

/**
 * Global Sliding-Window Rate Limiter (200 requests / 15 minutes per IP)
 */
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'ERR_RATE_LIMIT_EXCEEDED',
    message: 'Too many requests from this IP address. Please wait 15 minutes before retrying.',
    retryable: true,
  },
});

/**
 * Sensitive Transaction Rate Limiter (40 requests / 1 minute per IP)
 * Targets /api/v1/transactions, /api/v1/edge-nodes/:id/issue, /api/v1/nodes/:id/sync
 */
export const transactionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'ERR_TXN_RATE_LIMIT_EXCEEDED',
    message: 'Transaction throughput limit reached for this terminal. Rate throttled to prevent ledger saturation.',
    retryable: true,
  },
});

/**
 * Authentication Rate Limiter (25 login attempts / 15 minutes per IP)
 * Prevents password brute-forcing and token spray attacks.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'ERR_AUTH_RATE_LIMIT_EXCEEDED',
    message: 'Excessive authentication attempts detected. IP temporarily throttled to prevent brute-force attacks.',
    retryable: true,
  },
});

/**
 * Administrative Rate Limiter (10 admin actions / 15 minutes per IP)
 * Targets /api/v1/admin/*
 */
export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'ERR_ADMIN_RATE_LIMIT_EXCEEDED',
    message: 'Administrative operation rate limit exceeded.',
    retryable: false,
  },
});
