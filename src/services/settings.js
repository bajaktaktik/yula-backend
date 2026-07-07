// Runtime ayarları (bakım modu + feature flags) — DB'de settings tablosunda tutulur.
// 30 saniye cache — restart gerektirmez, panel değiştirdiğinde en fazla 30 saniye içinde yürürlüğe girer.

const crypto = require('crypto');
const pool = require('../db/pool');

let cache = new Map(); // key → { value, ts }
const TTL_MS = 30_000;

async function get(key, fallback = null) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    const value = r.rows[0]?.value ?? fallback;
    cache.set(key, { value, ts: Date.now() });
    return value;
  } catch {
    return fallback;
  }
}

async function set(key, value, updatedBy, description) {
  await pool.query(
    `INSERT INTO settings (key, value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(EXCLUDED.description, settings.description),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [key, JSON.stringify(value), description || null, updatedBy || null]
  );
  cache.delete(key);
}

async function del(key) {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
  cache.delete(key);
}

async function all() {
  const r = await pool.query(
    `SELECT s.key, s.value, s.description, s.updated_at, u.display_name AS updated_by_name
     FROM settings s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.key`
  );
  return r.rows;
}

// Deterministic yüzde-tabanlı rollout: user_id string'inin md5 hash'i mod 100 < percent
// → aynı kullanıcı her seferinde aynı sonucu alır (cihaz değişse bile)
function isFeatureEnabledForUser(userId, percent) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const hash = crypto.createHash('md5').update(userId).digest();
  // 32-bit uint from first 4 bytes → mod 100
  const bucket = (hash.readUInt32BE(0) % 100);
  return bucket < percent;
}

// Kullanıcı için hesaplanmış tüm feature flag'ler
// settings.feature_flags = { flag_key: { percent: 100, description: '...' } }
async function getFeaturesForUser(userId) {
  const flags = await get('feature_flags', {});
  const out = {};
  for (const [key, cfg] of Object.entries(flags || {})) {
    const pct = typeof cfg === 'number' ? cfg : (cfg?.percent || 0);
    out[key] = isFeatureEnabledForUser(userId, pct);
  }
  return out;
}

async function isMaintenanceMode() {
  const v = await get('maintenance_mode', { enabled: false });
  return !!v?.enabled;
}

async function getMaintenanceInfo() {
  return await get('maintenance_mode', { enabled: false, message: '' });
}

function invalidateCache() {
  cache = new Map();
}

module.exports = {
  get, set, del, all,
  isFeatureEnabledForUser,
  getFeaturesForUser,
  isMaintenanceMode,
  getMaintenanceInfo,
  invalidateCache,
};
