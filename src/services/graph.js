// Rehber tabanlı görünürlük: SADECE 1. derece — kullanıcının kendi telefon
// rehberinde olan ve Abadan'a kayıtlı kişiler.
// 2. derece (tanıdığın tanıdığı) MAHREMİYET nedeniyle kaldırıldı.
//
// NOT: Eski sürümde Redis cache (24 saat TTL) vardı. Sorun: rehber yenilenince,
// kullanıcı kayıt olunca, ilan eklenince cache stale kalıyordu ve invalidate
// her noktada tetiklenemiyordu. Sonuç: yeni içerikler görünmüyordu.
// Şimdi her çağrıda DB'den taze veri okunur. Sorgu hızlıdır (<50ms typical).
// Cache ileride gerçekten lazım olursa graphdb-style sayfalama ile gelir.

const pool = require('../db/pool');
const redis = require('../cache/redis');

/**
 * Kullanıcının görebileceği diğer kullanıcı id'lerini döner.
 * Sadece 1. derece — rehberinde olup Abadan'a kayıtlı kişiler.
 * Geri dönüş: Map<user_id, 1>  (degree daima 1; alan UI uyumluluğu için)
 */
async function getVisibleUserIds(userId) {
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
  return map;
}

// Backwards-compat: eski kodda contacts.js graph.invalidate çağırıyor.
// Cache yok artık ama signature'ı koruyalım — no-op + eski cache key'i de temizle.
async function invalidate(userId) {
  try {
    await redis.del(`connections:${userId}`);
  } catch (_) {
    // Redis yoksa veya bağlantı sorunu — sessizce geç, kritik değil
  }
}

module.exports = { getVisibleUserIds, invalidate };
