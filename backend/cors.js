export function createCorsMiddleware({ origins = '', production = process.env.NODE_ENV === 'production' } = {}) {
  const allowed = new Set(String(origins).split(',').map(value => value.trim()).filter(Boolean));
  if (!production) {
    ['http://localhost:8081', 'http://127.0.0.1:8081', 'http://localhost:19006', 'http://127.0.0.1:19006'].forEach(origin => allowed.add(origin));
  }
  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) return res.status(403).json({ error: 'This web origin is not allowed.' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      return res.status(204).end();
    }
    next();
  };
}
