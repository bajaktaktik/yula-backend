// Rehber tabanlı görünürlük:
// - 1. derece: kullanıcının rehberindeki Abadan kullanıcıları (direkt tanıdıklar)
// - 2. derece: 1. derece kullanıcıların rehberindeki Abadan kullanıcıları (tanıdığının tanıdığı)
//
// 2. derece için MAHREMİYET korunur:
//   - İsim gizli, via_user_id ve via_name ile gösterilir ("Ahmet'in tanıdığı")
//   - Kullanıcı doğrudan 2. derece kişiyle mesajlaşmaz; via kullanıcı aracıdır (UI kararı)
//   - Aynı 2. derece kullanıcı birden fazla mutual üzerinden bulunsa bile TEK kez döner
//     (alfabetik olarak ilk gelen via seçilir → deterministik)

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

/**
 * 2. derece bağlantılar — tanıdığının tanıdığı.
 * Dönüş: Map<user_id, { via_user_id, via_name }>
 *   via_user_id: aracı 1. derece kullanıcı (kullanıcının rehberinde)
 *   via_name: aracı kullanıcının rehberdeki adı (user_contacts.contact_name)
 *
 * Deduplication: aynı 2. derece kullanıcı birden çok mutual üzerinden ulaşılsa bile
 * MAP tek satır tutar; via alfabetik olarak ilki seçilir → tutarlı.
 *
 * Engellenen kullanıcılar hem 1. hem 2. dereceden filtrelenir.
 */
async function getSecondDegreeMap(userId) {
  // Önce 1. derece + engellenmiş kullanıcıları al
  const firstDegree = await getVisibleUserIds(userId);
  if (firstDegree.size === 0) return new Map();

  const firstDegreeIds = Array.from(firstDegree.keys());

  const blocked = await pool.query(
    'SELECT blocked_id::text AS id FROM blocks WHERE blocker_id = $1 UNION SELECT blocker_id::text FROM blocks WHERE blocked_id = $1',
    [userId]
  );
  const blockedSet = new Set(blocked.rows.map((r) => r.id));

  // 2. derece kullanıcıları çek. Her satır: (user_id, via_user_id, via_name)
  // via_name = current user'ın rehberindeki isim (user_contacts.contact_name)
  //
  // NOT: aynı user_id birden fazla via ile gelirse ilk (alfabetik) satır alınır.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u2.id)
       u2.id::text AS user_id,
       uc_me.user_id::text AS via_user_id,
       COALESCE(uc_me.contact_name, u_via.display_name, 'Kullanıcı') AS via_name
     FROM user_contacts uc_via
     JOIN users u2 ON u2.phone_hash = uc_via.contact_phone_hash
     JOIN users u_via ON u_via.id = uc_via.user_id
     LEFT JOIN user_contacts uc_me
       ON uc_me.user_id = $1
       AND uc_me.contact_phone_hash = u_via.phone_hash
     WHERE uc_via.user_id = ANY($2::uuid[])
       AND u2.status = 'active'
       AND u2.id != $1
       AND u2.id::text != ALL($3::text[])
     ORDER BY u2.id, COALESCE(uc_me.contact_name, u_via.display_name, '~')`,
    [userId, firstDegreeIds, firstDegreeIds]
  );

  const map = new Map();
  for (const r of rows) {
    if (blockedSet.has(r.user_id)) continue;
    map.set(r.user_id, { via_user_id: r.via_user_id, via_name: r.via_name });
  }
  return map;
}

// Backwards-compat: eski kodda contacts.js graph.invalidate çağırıyor.
async function invalidate(userId) {
  try {
    await redis.del(`connections:${userId}`);
  } catch (_) {
    // Redis yoksa sessizce geç
  }
}

module.exports = { getVisibleUserIds, getSecondDegreeMap, invalidate };
