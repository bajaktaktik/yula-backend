// API response time izleme — in-memory ring buffer.
// Middleware her request için timing kaydeder. Admin endpoint özet döner.
// Sunucu restart olduğunda sıfırlanır (kalıcı istatistik istersen DB'ye taşınır).

const MAX_ENTRIES = 2000; // son 2000 request tutulur

// Ring buffer
const buffer = new Array(MAX_ENTRIES);
let idx = 0;
let size = 0;

// Endpoint bazlı agg
const endpointStats = new Map(); // key: 'GET /listings' → { count, sum_ms, max_ms, err_count }

function record(method, routePath, ms, statusCode) {
  const key = method + ' ' + routePath;
  const entry = { method, route: routePath, ms, status: statusCode, at: Date.now() };
  buffer[idx] = entry;
  idx = (idx + 1) % MAX_ENTRIES;
  if (size < MAX_ENTRIES) size++;

  const s = endpointStats.get(key) || { count: 0, sum_ms: 0, max_ms: 0, err_count: 0, last_at: 0 };
  s.count += 1;
  s.sum_ms += ms;
  if (ms > s.max_ms) s.max_ms = ms;
  if (statusCode >= 500) s.err_count += 1;
  s.last_at = Date.now();
  endpointStats.set(key, s);
}

// Middleware
function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Route path yoksa (404 vs) req.path kullan; parametreleri normalize et (uuid'ler)
    let route = req.route?.path || req.path;
    // Route path prefix ekle (Express router prefix her zaman route.path'te yok)
    if (req.baseUrl) route = req.baseUrl + route;
    // UUID benzeri parametreleri :id ile normalize et — endpoint stats kirlenmesin
    route = route.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id');
    record(req.method, route, ms, res.statusCode);
  });
  next();
}

// Son N request
function recent(n = 100) {
  const out = [];
  const count = Math.min(size, n);
  for (let i = 0; i < count; i++) {
    const bufIdx = (idx - 1 - i + MAX_ENTRIES) % MAX_ENTRIES;
    if (buffer[bufIdx]) out.push(buffer[bufIdx]);
  }
  return out;
}

// Endpoint özet — avg, count, max, err
function summary(limit = 30) {
  const rows = [];
  for (const [key, s] of endpointStats.entries()) {
    const [method, route] = key.split(' ');
    rows.push({
      method,
      route,
      count: s.count,
      avg_ms: Math.round(s.sum_ms / s.count),
      max_ms: Math.round(s.max_ms),
      err_count: s.err_count,
      last_at: s.last_at,
    });
  }
  // En yavaş ortalama olanlar önce
  rows.sort((a, b) => b.avg_ms - a.avg_ms);
  return rows.slice(0, limit);
}

// Genel istatistik — son 5 dk
function overall() {
  const now = Date.now();
  const last5min = [];
  const last1min = [];
  for (let i = 0; i < size; i++) {
    const bufIdx = (idx - 1 - i + MAX_ENTRIES) % MAX_ENTRIES;
    const e = buffer[bufIdx];
    if (!e) continue;
    if (now - e.at <= 5 * 60 * 1000) last5min.push(e);
    if (now - e.at <= 60 * 1000) last1min.push(e);
  }
  const stats = (arr) => {
    if (arr.length === 0) return { count: 0, avg_ms: 0, p95_ms: 0, err_count: 0 };
    const sorted = arr.map((x) => x.ms).sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: arr.length,
      avg_ms: Math.round(sum / arr.length),
      p95_ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
      err_count: arr.filter((x) => x.status >= 500).length,
    };
  };
  return {
    last_1_min: stats(last1min),
    last_5_min: stats(last5min),
    total_buffer_count: size,
  };
}

module.exports = { middleware, recent, summary, overall };
