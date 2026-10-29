// api/health.ts
// Dedicated zero-cold-start Vercel serverless health check
export default function handler(_req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    status: 'UP',
    mode: 'serverless-edge',
    timestamp: new Date().toISOString(),
  });
}
