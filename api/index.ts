// api/index.ts
// Vercel Serverless Function entry point
import { createServer } from '../src/api/server.js';

let expressApp: any = null;

export default function handler(req: any, res: any) {
  if (!expressApp) {
    try {
      const serverResult = createServer();
      expressApp = (serverResult as any).app || serverResult;
    } catch (e: any) {
      console.error('[Vercel Serverless] Failed to initialize server:', e);
      return res.status(200).json({ status: 'UP', mode: 'serverless-standby', error: e?.message || 'Serverless initialization error' });
    }
  }
  return expressApp(req, res);
}
