// Rehber tabanlı görünürlük: SADECE 1. derece — kullanıcının kendi telefon
// rehberinde olan ve Yula'ya kayıtlı kişiler.
// 2. derece (tanıdığın tanıdığı) MAHREMİYET nedeniyle kaldırıldı.

const pool = require('../db/pool');
const redis = require('../cache/redis');

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 saat

/**
 * Kullanıcının görebileceği diğer kullanıcı id'lerini döner.
 * Sadece 1. derece — rehberinde olup Yula'ya kayıtlı kişiler.
 * Geri dönüş: Map<user_id, 1>  (degree daima 1; alan UI uyumluluğu için)
 */
async function getVisibleUserIds(userId) {
  const cacheKey = `connections:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return new Map(JSON.parse(cached));
  }

  const { rows } = await pool.query(
    `SELECT u.id::text AS id
     FROM user_contacts uc
     JOIN users u ON u.phone_hash = uc.contact_phone_hash
     WHERE uc.user_id = $1 AND u.status = 'active'`,
    [userId]
  );

  // Engellenen kullanıcıları çıkar
  const blocked = await pool.query(
    'SELECT blocked_id::text AS id FROM blocks WHERE blocker_id = $1 UNION SELECT blocker_id::text FROM blocks WHERE blocked_id = $1',
    [userId]
  );
  const blockedSet = new Set(blocked.rows.map((r) => r.id));

  const map = new Map();
  for (const r of rows) {
    if (!blockedSet.has(r.id)) map.set(r.id, 1);
  }

  await redis.set(cacheKey, JSON.stringify([...map.entries()]), { EX: CACHE_TTL_SECONDS });
  return map;
}

async function invalidate(userId) {
  await redis.del(`connections:${userId}`);
}

module.exports = { getVisibleUserIds, invalidate };
