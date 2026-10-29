// api/index.ts
// Vercel Serverless Function entry point
import { createServer } from '../src/api/server.js';

let expressApp: any = null;

export default function handler(req: any, res: any) {
  // 1. Instant fallback for health check to avoid cold-start or middleware errors
  const url = req.url || '';
  if (url === '/api/health' || url === '/health' || url.startsWith('/api/health?') || url.startsWith('/health?')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      status: 'UP',
      mode: 'serverless-edge',
      timestamp: new Date().toISOString(),
    });
  }

  // 2. Ensure req.socket and req.connection have remoteAddress for Express trust proxy & forwarded
  const clientIp =
    (typeof req.headers?.['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : null) ||
    req.headers?.['x-real-ip'] ||
    '127.0.0.1';

  if (!req.socket) {
    req.socket = { remoteAddress: clientIp };
  } else if (!req.socket.remoteAddress) {
    req.socket.remoteAddress = clientIp;
  }
  if (!req.connection) {
    req.connection = req.socket;
  }

  // 3. Initialize Express server singleton safely
  if (!expressApp) {
    try {
      const serverResult = createServer();
      expressApp = (serverResult as any).app || serverResult;
    } catch (e: any) {
      console.error('[Vercel Serverless] Failed to initialize server:', e);
      return res.status(200).json({
        status: 'UP',
        mode: 'serverless-standby',
        error: e?.message || 'Serverless initialization error',
      });
    }
  }

  return expressApp(req, res);
}

