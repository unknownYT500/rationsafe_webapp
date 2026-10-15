// api/index.ts
// Vercel Serverless Function entry point
import { createServer } from '../src/api/server.js';

const app = createServer();

export default app;
