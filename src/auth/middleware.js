const { verifyAccess } = require('./jwt');
const pool = require('../db/pool');

// Basit in-memory cache: user status 30 saniye önbelleklenir.
// Yasaklama etkisi hemen gelmiyor mu diye bekleyen 30sn'de görür.
// Amaç: her request'te DB'ye ekstra sorgu atmamak.
const statusCache = new Map();
const CACHE_TTL_MS = 30_000;

// last_active_at update için throttle — 5 dakikada bir DB write
// Kullanıcı bir gün boyunca app açık tutsa da her request'te değil, 5 dk aralıkla update.
const lastActiveUpdated = new Map(); // userId → timestamp (son ne zaman update ettik)
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

function touchLastActive(userId) {
  const now = Date.now();
  const lastUpdate = lastActiveUpdated.get(userId) || 0;
  if (now - lastUpdate < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveUpdated.set(userId, now);
  // Async — response'u geciktirmesin, hatası kaybolsa da olur
  pool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [userId])
    .catch((e) => console.error('[middleware] last_active update fail:', e.message));
}

async function getUserStatus(userId) {
  const cached = statusCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.status;
  try {
    const r = await pool.query(
      'SELECT status, suspended_until FROM users WHERE id = $1',
      [userId]
    );
    if (r.rows.length === 0) return null;

    let status = r.rows[0].status;
    const until = r.rows[0].suspended_until;

    // Süreli askı bitmişse otomatik aktife çevir + admin_actions'a "auto_unban" kaydı yaz
    if (status === 'suspended' && until && new Date(until) < new Date()) {
      await pool.query(
        `UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1`,
        [userId]
      );
      await pool.query(
        `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
         VALUES ($1, $1, 'unban', 'Süreli askı doldu, otomatik aktif', $2)`,
        [userId, JSON.stringify({ auto: true, expired_at: until })]
      ).catch(() => {}); // audit fail login'i bloke etmesin
      status = 'active';
    }

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

    // Kısıtlı scope'lu token'lar (TOTP setup için verilen) normal endpoint'lerde geçerli sayılmaz
    // Sadece istisnası: kendi scope'una uygun endpoint'ler bu kontrolü kendileri yapar.
    if (payload.scope && payload.scope !== 'access') {
      return res.status(403).json({ error: 'scope_forbidden', message: 'Bu token bu işlem için geçerli değil.' });
    }
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

    // Her yetkili istekte last_active_at güncelle (throttle ile 5 dk aralıkla)
    // Kullanıcı sadece login-pin sırasında değil, günlük kullanımında da "canlı" sayılır.
    touchLastActive(req.userId);

    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { requireAuth, invalidateUserStatusCache };
