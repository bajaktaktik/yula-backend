// Otomatik bildirim tetikleyicileri:
//   - Yeni bir kullanıcı kaydolunca → tanıdıkları + 2. derece tanıdıklarına haber ver
//   - Yeni bir ilan yayınlanınca → o ilanı görebilecek herkese haber ver (1. + 2. derece)
//   - Bir ilan iletildiğinde → forwarder'ın 1. derece çevresine haber ver
//
// Anti-spam:
//   - Her event max 500 alıcıya (büyük ağlarda patlamayı önle)
//   - insert failure/duplicate → sessizce yut
//   - Push fire-and-forget

const pool = require('../db/pool');
const push = require('./push');

const MAX_RECIPIENTS_PER_EVENT = 500;

async function insertNotifAndPush(userId, type, payload) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, listing_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, type, payload.listing_id || null, JSON.stringify(payload)]
    );
    push.sendToUser(userId, {
      title: payload.title,
      body: payload.body,
      data: { type, ...payload },
    }).catch(() => {});
  } catch (_) { /* duplicate/FK → skip */ }
}

// ─────────────────────────────────────────────────────────────
// 1) Yeni kullanıcı kaydoldu
// ─────────────────────────────────────────────────────────────
async function notifyOnNewMember(newUserId) {
  try {
    const info = await pool.query(
      `SELECT id, display_name, phone_hash FROM users WHERE id = $1`,
      [newUserId]
    );
    if (info.rows.length === 0) return;
    const newUser = info.rows[0];

    // 1. derece — rehberinde bu yeni kullanıcının numarası olan aktif kullanıcılar
    const firstDegree = await pool.query(
      `SELECT DISTINCT uc.user_id, uc.contact_name
       FROM user_contacts uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.contact_phone_hash = $1
         AND u.status = 'active'
         AND u.id <> $2
       LIMIT $3`,
      [newUser.phone_hash, newUserId, MAX_RECIPIENTS_PER_EVENT]
    );
    const firstIds = firstDegree.rows.map(r => r.user_id);

    // 2. derece — 1. derece üzerinden erişilebilir kişiler
    let secondIds = [];
    if (firstIds.length > 0) {
      const res = await pool.query(
        `SELECT DISTINCT uc.user_id
         FROM user_contacts uc
         JOIN users u2 ON u2.phone_hash = uc.contact_phone_hash
         JOIN users u ON u.id = uc.user_id
         WHERE u2.id = ANY($1::uuid[])
           AND uc.user_id <> $2
           AND uc.user_id <> ALL($1::uuid[])
           AND u.status = 'active'
         LIMIT $3`,
        [firstIds, newUserId, MAX_RECIPIENTS_PER_EVENT]
      );
      secondIds = res.rows.map(r => r.user_id);
    }

    // 1. derece → kişiselleştirilmiş
    for (const row of firstDegree.rows) {
      const name = row.contact_name || newUser.display_name || 'Rehberindeki biri';
      await insertNotifAndPush(row.user_id, 'contact_joined', {
        title: '👋 Tanıdığın Abadan\'a katıldı',
        body: `${name} Abadan\'a kayıt oldu — artık ilanlarını görebilirsin`,
        new_user_id: newUserId,
        new_user_name: name,
        tier: 1,
      });
    }

    // 2. derece → generic
    for (const uid of secondIds) {
      await insertNotifAndPush(uid, 'contact_joined', {
        title: '🔗 Ağın büyüdü',
        body: 'Tanıdığının tanıdığı Abadan\'a katıldı',
        new_user_id: newUserId,
        tier: 2,
      });
    }
  } catch (e) {
    console.error('[notify-new-member] fail:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 2) Yeni ilan yayınlandı (görebilenlere haber ver)
// ─────────────────────────────────────────────────────────────
async function notifyOnNewListing(listingId, sellerId) {
  try {
    const info = await pool.query(
      `SELECT l.id, l.title, l.price, l.is_negotiable, l.user_id, l.ghost_mode,
              l.restricted_to_gender,
              u.display_name AS seller_name, u.phone_hash AS seller_phone_hash,
              u.ghost_mode AS seller_ghost_mode
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1 AND l.status = 'active' AND l.admin_removed_at IS NULL`,
      [listingId]
    );
    if (info.rows.length === 0) return;
    const listing = info.rows[0];
    const isGhost = listing.ghost_mode || listing.seller_ghost_mode;

    // Cinsiyet kısıtlı ilan → sadece o cinsiyetteki kullanıcılara bildir
    const genderFilter = listing.restricted_to_gender
      ? `AND u.gender = '${listing.restricted_to_gender}'`
      : '';

    // 1. derece — satıcıyı rehberinde olan aktif kullanıcılar
    const firstDegree = await pool.query(
      `SELECT DISTINCT uc.user_id, uc.contact_name AS seller_contact_name
       FROM user_contacts uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.contact_phone_hash = $1
         AND uc.user_id <> $2
         AND u.status = 'active'
         ${genderFilter}
       LIMIT $3`,
      [listing.seller_phone_hash, sellerId, MAX_RECIPIENTS_PER_EVENT]
    );

    // 2. derece
    const firstIds = firstDegree.rows.map(r => r.user_id);
    let secondIds = [];
    if (firstIds.length > 0) {
      const res = await pool.query(
        `SELECT DISTINCT uc.user_id
         FROM user_contacts uc
         JOIN users u2 ON u2.phone_hash = uc.contact_phone_hash
         JOIN users u ON u.id = uc.user_id
         WHERE u2.id = ANY($1::uuid[])
           AND uc.user_id <> $2
           AND uc.user_id <> ALL($1::uuid[])
           AND u.status = 'active'
           ${genderFilter}
         LIMIT $3`,
        [firstIds, sellerId, MAX_RECIPIENTS_PER_EVENT]
      );
      secondIds = res.rows.map(r => r.user_id);
    }

    const priceStr = listing.is_negotiable
      ? 'Pazarlıklı'
      : Number(listing.price) === 0 ? 'ÜCRETSİZ'
      : Number(listing.price).toLocaleString('tr-TR') + ' ₺';

    // 1. derece → kişiselleştirilmiş (hayalet değilse isim, hayaletse anonim)
    for (const row of firstDegree.rows) {
      const name = isGhost
        ? 'Bir tanıdığın'
        : (row.seller_contact_name || listing.seller_name || 'Tanıdığın');
      await insertNotifAndPush(row.user_id, 'new_visible_listing', {
        title: `📦 ${name} yeni ilan verdi`,
        body: `${(listing.title || '').slice(0, 80)} · ${priceStr}`,
        listing_id: listingId,
        tier: 1,
        is_ghost: !!isGhost,
      });
    }

    // 2. derece
    for (const uid of secondIds) {
      await insertNotifAndPush(uid, 'new_visible_listing', {
        title: '🔗 Ağında yeni ilan',
        body: `${(listing.title || '').slice(0, 80)} · ${priceStr}`,
        listing_id: listingId,
        tier: 2,
        is_ghost: !!isGhost,
      });
    }
  } catch (e) {
    console.error('[notify-new-listing] fail:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 3) İlan iletildi (forwarder'ın çevresine görünür oldu)
// ─────────────────────────────────────────────────────────────
async function notifyOnListingForwarded(listingId, forwarderId) {
  try {
    const info = await pool.query(
      `SELECT l.id, l.title, l.price, l.is_negotiable, l.restricted_to_gender
       FROM listings l
       WHERE l.id = $1 AND l.status = 'active' AND l.admin_removed_at IS NULL`,
      [listingId]
    );
    if (info.rows.length === 0) return;
    const listing = info.rows[0];

    const fwdInfo = await pool.query(
      `SELECT phone_hash FROM users WHERE id = $1`, [forwarderId]
    );
    if (fwdInfo.rows.length === 0) return;
    const forwarderHash = fwdInfo.rows[0].phone_hash;

    const genderFilter = listing.restricted_to_gender
      ? `AND u.gender = '${listing.restricted_to_gender}'`
      : '';

    // Forwarder'ın 1. derece çevresi — bunlar artık ilanı "ileti" olarak görebilir
    // Forwarder anonim: bildirimde ileti yapan kişinin adı YOK
    const recipients = await pool.query(
      `SELECT DISTINCT uc.user_id
       FROM user_contacts uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.contact_phone_hash = $1
         AND uc.user_id <> $2
         AND u.status = 'active'
         ${genderFilter}
       LIMIT $3`,
      [forwarderHash, forwarderId, MAX_RECIPIENTS_PER_EVENT]
    );

    const priceStr = listing.is_negotiable
      ? 'Pazarlıklı'
      : Number(listing.price) === 0 ? 'ÜCRETSİZ'
      : Number(listing.price).toLocaleString('tr-TR') + ' ₺';

    for (const { user_id } of recipients.rows) {
      await insertNotifAndPush(user_id, 'new_visible_listing', {
        title: '📤 Tanıdığın bir ilan iletti',
        body: `${(listing.title || '').slice(0, 80)} · ${priceStr}`,
        listing_id: listingId,
        tier: 1,
        forwarded: true,
      });
    }
  } catch (e) {
    console.error('[notify-forwarded] fail:', e.message);
  }
}

module.exports = {
  notifyOnNewMember,
  notifyOnNewListing,
  notifyOnListingForwarded,
};
