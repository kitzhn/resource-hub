import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { KINDS, loadCatalog, search, toVod } from './catalog.js';

function integer(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Integer out of range');
  return number;
}

export function getConfig(env = process.env) {
  if (typeof env.API_TOKEN !== 'string' || env.API_TOKEN.length < 32 || env.API_TOKEN.startsWith('replace-') || /[\s\x00-\x1f]/.test(env.API_TOKEN)) {
    throw new Error('Set API_TOKEN to a random value of at least 32 characters');
  }
  const allowedIps = (env.COMPAT_ALLOWED_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
  return {
    host: env.HOST || '127.0.0.1', port: integer(env.PORT, 3001, 1, 65535), token: env.API_TOKEN,
    catalogPath: env.CATALOG_PATH || 'examples/catalog.demo.json', allowedIps,
    requestsPerMinute: integer(env.REQUESTS_PER_MINUTE, 120, 1, 10000),
  };
}

const hash = value => createHash('sha256').update(value).digest();
const normalizeIp = ip => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;

export function createApp(resources, config) {
  const expectedToken = hash(config.token);
  const compatibilityPeers = new Set(config.allowedIps.map(normalizeIp));
  const buckets = new Map();
  const vodResources = resources.filter(item => item.kind === 'vod' && toVod(item));
  const byId = new Map(resources.map(item => [item.id, item]));
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...headers,
      });
      res.end(JSON.stringify(body));
    };
    try {
      const peer = normalizeIp(req.socket.remoteAddress);
      const now = Date.now();
      if (buckets.size >= 1000) {
        for (const [ip, bucket] of buckets) if (bucket.expires <= now) buckets.delete(ip);
        if (!buckets.has(peer) && buckets.size >= 1000) return send(503, { error: 'Temporarily unavailable' });
      }
      let bucket = buckets.get(peer);
      if (!bucket || bucket.expires <= now) { bucket = { count: 0, expires: now + 60000 }; buckets.set(peer, bucket); }
      if (++bucket.count > config.requestsPerMinute) return send(429, { error: 'Rate limit exceeded' }, { 'Retry-After': String(Math.max(1, Math.ceil((bucket.expires - now) / 1000))) });
      if (req.method !== 'GET') return send(405, { error: 'Only GET is supported' }, { Allow: 'GET' });
      if (!req.url || req.url.length > 4096) return send(414, { error: 'URL too long' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/v1/health') return send(200, { status: 'ok', version: '0.1.0' });
      const isCompat = url.pathname === '/compat/vod';
      const suppliedToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const authenticated = timingSafeEqual(hash(suppliedToken), expectedToken);
      if (!authenticated && !(isCompat && compatibilityPeers.has(peer))) {
        return send(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q')?.trim();
        const kind = url.searchParams.get('kind') || undefined;
        if (!q || q.length > 128 || (kind && !KINDS.includes(kind))) return send(400, { error: 'Use q (1–128 characters) and optional kind: vod, torrent, comic' });
        let offset, limit;
        try {
          offset = integer(url.searchParams.get('cursor'), 0, 0, 1000000);
          limit = integer(url.searchParams.get('limit'), 20, 1, 100);
        } catch { return send(400, { error: 'Invalid cursor or limit' }); }
        return send(200, search(resources, { q, kind, offset, limit }));
      }
      if (isCompat) {
        if (url.searchParams.get('ac') !== 'videolist') return send(400, { error: 'Use ac=videolist' });
        const id = url.searchParams.get('ids');
        if (id !== null) {
          const item = vodResources.find(resource => resource.id === id);
          return send(200, { code: 1, page: 1, pagecount: 1, limit: 20, total: item ? 1 : 0, list: item ? [toVod(item)] : [] });
        }
        const q = url.searchParams.get('wd')?.trim();
        if (!q || q.length > 128) return send(400, { error: 'Use wd (1–128 characters)' });
        let page;
        try { page = integer(url.searchParams.get('pg'), 1, 1, 50000); }
        catch { return send(400, { error: 'Invalid pg' }); }
        const result = search(vodResources, { q, offset: (page - 1) * 20, limit: 20 });
        return send(200, { code: 1, page, pagecount: Math.max(1, Math.ceil(result.total / 20)), limit: 20, total: result.total, list: result.items.map(toVod) });
      }
      const match = /^\/v1\/resources\/([A-Za-z0-9_-]{1,80})(?:\/(episodes|chapters))?$/.exec(url.pathname);
      if (match) {
        const item = byId.get(match[1]);
        if (!item || (match[2] === 'episodes' && item.kind !== 'vod') || (match[2] === 'chapters' && item.kind !== 'comic')) return send(404, { error: 'Resource not found' });
        return send(200, match[2] ? { id: item.id, items: item[match[2]] } : item);
      }
      return send(404, { error: 'Not found' });
    } catch {
      return send(400, { error: 'Invalid request' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

async function main() {
  const config = getConfig();
  const resources = await loadCatalog(config.catalogPath);
  const server = createApp(resources, config);
  server.on('error', () => { console.error('Unable to start server; check HOST and PORT'); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Resource Hub listening on ${config.host}:${config.port}; ${resources.length} indexed records`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Startup failed. Check API_TOKEN, server configuration and catalog schema; see README.'); process.exitCode = 1; });
}
