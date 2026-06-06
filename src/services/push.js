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
async function sendToUser(userId, payload) {
  const { rows } = await pool.query(
    'SELECT token FROM device_tokens WHERE user_id = $1',
    [userId]
  );
  if (rows.length === 0) return;

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

  // Hata dönen ticket'lardaki DeviceNotRegistered tokenları temizle
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
}

module.exports = { sendToUser };
