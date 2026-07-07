const { verifyAccess } = require('./jwt');
const pool = require('../db/pool');

// Basit in-memory cache: user status 30 saniye önbelleklenir.
// Yasaklama etkisi hemen gelmiyor mu diye bekleyen 30sn'de görür.
// Amaç: her request'te DB'ye ekstra sorgu atmamak.
const statusCache = new Map();
const CACHE_TTL_MS = 30_000;

async function getUserStatus(userId) {
  const cached = statusCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.status;
  try {
    const r = await pool.query('SELECT status FROM users WHERE id = $1', [userId]);
    const status = r.rows[0]?.status || null;
    statusCache.set(userId, { status, ts: Date.now() });
    return status;
  } catch {
    return null;
  }
}

// Test / admin işlemi sonrası önbelleği patlatmak için
function invalidateUserStatusCache(userId) {
  if (userId) statusCache.delete(userId);
  else statusCache.clear();
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = verifyAccess(token);
    req.userId = payload.sub;

    // Yasaklı user tüm endpoint'lere erişemez → mobile'da 403 yakalayıp logout tetiklenir.
    // Kullanıcı silinmişse de aynı — 403 döner.
    const status = await getUserStatus(req.userId);
    if (status === 'banned') {
      return res.status(403).json({ error: 'user_banned', message: 'Hesabınız yasaklanmıştır.' });
    }
    if (status === null) {
      // User silinmiş veya DB'de yok → token geçersiz kabul et
      return res.status(401).json({ error: 'user_not_found' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { requireAuth, invalidateUserStatusCache };
