// Expo Push Notification servisi.
// Bir kullanıcıya bildirim gönderir; cihaz tokenlarını DB'den çeker,
// Expo'nun bulutuna toplu (chunk) halinde post eder, geçersiz token'ları temizler.

const { Expo } = require('expo-server-sdk');
const pool = require('../db/pool');

const expo = new Expo();

/**
 * @param {string} userId  - bildirim gidecek kullanıcı
 * @param {object} payload - { title, body, data }
 */
async function logPush({ userId, payload, tokens_count = 0, ok_count = 0, err_count = 0, status, error }) {
  try {
    await pool.query(
      `INSERT INTO push_log (user_id, type, title, body_short, tokens_count, ok_count, err_count, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        payload?.data?.type || null,
        payload?.title || null,
        (payload?.body || '').slice(0, 100),
        tokens_count,
        ok_count,
        err_count,
        status,
        error || null,
      ]
    );
  } catch (e) {
    console.error('[push] log fail:', e.message);
  }
}

async function sendToUser(userId, payload) {
  // PII korumalı log: title/body yazılmaz, sadece user_id + payload type
  console.log(`[push] sendToUser user=${userId} type=${payload?.data?.type || 'generic'}`);
  const { rows } = await pool.query(
    'SELECT token FROM device_tokens WHERE user_id = $1',
    [userId]
  );
  console.log(`[push] DB'den bulunan token sayısı: ${rows.length}`);
  if (rows.length === 0) {
    console.warn(`[push] TOKEN YOK — user=${userId} cihaz kaydetmemiş`);
    await logPush({ userId, payload, status: 'no_tokens' });
    return;
  }

  // Badge sayısı: kullanıcının toplam okunmamış mesaj sayısı (iOS ikon üzerinde gözükür).
  // payload.badge override edilebilir; verilmediyse otomatik hesaplanır.
  let badge = payload.badge;
  if (badge === undefined) {
    const unread = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.buyer_id = $1 OR c.seller_id = $1)
         AND m.sender_id <> $1
         AND m.read_at IS NULL`,
      [userId]
    );
    badge = unread.rows[0]?.n || 0;
  }

  const messages = [];
  const invalidTokens = [];

  for (const r of rows) {
    if (!Expo.isExpoPushToken(r.token)) {
      invalidTokens.push(r.token);
      continue;
    }
    messages.push({
      to: r.token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      priority: 'high',
      channelId: 'messages',
      badge, // iOS app icon badge sayısı
    });
  }

  // Geçersiz formatları temizle
  if (invalidTokens.length > 0) {
    await pool.query('DELETE FROM device_tokens WHERE token = ANY($1)', [invalidTokens]);
  }

  if (messages.length === 0) return;

  console.log(`[push] user=${userId} → ${messages.length} mesaj gönderiliyor`);

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  for (const chunk of chunks) {
    try {
      const t = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...t);
    } catch (err) {
      console.error('[push] gönderim hatası:', err.message);
    }
  }

  // Ticket özeti
  const okCount = tickets.filter((t) => t.status === 'ok').length;
  const errCount = tickets.filter((t) => t.status === 'error').length;
  console.log(`[push] ticket sonuç: ${okCount} ok, ${errCount} error`);

  // Log — push_log tablosuna kaydet
  const status = errCount === 0 ? 'sent' : (okCount === 0 ? 'failed' : 'partial');
  const firstErr = tickets.find((t) => t.status === 'error');
  await logPush({
    userId,
    payload,
    tokens_count: messages.length,
    ok_count: okCount,
    err_count: errCount,
    status,
    error: firstErr ? firstErr.message?.slice(0, 300) : null,
  });

  // Hatalı ticket detaylarını logla
  tickets.forEach((t, i) => {
    if (t.status === 'error') {
      console.error(`[push] ticket error: ${t.message} | details:`, t.details, `| token: ${messages[i]?.to?.slice(0, 30)}...`);
    }
  });

  // DeviceNotRegistered olanları DB'den temizle
  const badTokens = [];
  tickets.forEach((t, i) => {
    if (t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered') {
      badTokens.push(messages[i].to);
    }
  });
  if (badTokens.length > 0) {
    await pool.query('DELETE FROM device_tokens WHERE token = ANY($1)', [badTokens]);
    console.log(`[push] ${badTokens.length} geçersiz token temizlendi`);
  }

  // Receipt check — 15 sn sonra Expo'dan gerçek delivery durumunu sor.
  // Ticket "ok" olabilir ama Expo→FCM iletim "InvalidCredentials" / "MismatchSenderId"
  // gibi hatalarla fail olabilir. Receipt'lerde bu net görünür.
  const ticketIds = tickets.filter((t) => t.status === 'ok' && t.id).map((t) => t.id);
  if (ticketIds.length > 0) {
    setTimeout(async () => {
      try {
        const receiptChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
        for (const chunk of receiptChunks) {
          const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
          for (const [id, r] of Object.entries(receipts)) {
            if (r.status === 'error') {
              console.error(`[push] RECEIPT ERROR id=${id} message="${r.message}" details=`, r.details);
            } else {
              console.log(`[push] receipt ok id=${id}`);
            }
          }
        }
      } catch (err) {
        console.error('[push] receipt fetch hatası:', err.message);
      }
    }, 15000);
  }
}

// Tüm admin'lere push + in-app notif — yeni kayıt / yeni ilan bildirimleri için
// excludeUserId: admin kendi eylemini yaparsa kendine push atmayı önler
async function sendToAllAdmins(payload, excludeUserId = null) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`
    );
    const targets = excludeUserId
      ? rows.filter((r) => r.id !== excludeUserId)
      : rows;
    if (targets.length === 0) return;

    console.log(`[push] sendToAllAdmins → ${targets.length} admin, type=${payload?.data?.type || 'generic'}`);

    // In-app notification (Bildirimler ekranında görünsün)
    for (const t of targets) {
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, type, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [t.id, payload?.data?.type || 'admin_notify', JSON.stringify({
            title: payload.title,
            body: payload.body,
            ...payload.data,
          })]
        );
      } catch (e) {
        console.error(`[push] admin in-app fail user=${t.id}:`, e.message);
      }
    }

    // Push notification — cihazı varsa
    await Promise.all(
      targets.map((t) =>
        sendToUser(t.id, payload).catch((err) => {
          console.error(`[push] admin push fail user=${t.id}:`, err.message);
        })
      )
    );
  } catch (err) {
    console.error('[push] sendToAllAdmins fail:', err.message);
  }
}

module.exports = { sendToUser, sendToAllAdmins };
