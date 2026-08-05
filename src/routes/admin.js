// Admin moderasyon paneli — Apple Guideline 1.2 24-saat moderasyon zorunluluğu.
// Yetki kaynağı artık DB'de users.role = 'admin'. Env ADMIN_USER_IDS sadece backward compat için seed.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth, invalidateUserStatusCache } = require('../auth/middleware');

const router = express.Router();

// Admin durumunun DB'den çekilmesi — 30 saniye cache (aynı request'te tekrar sorgu atmaya gerek yok)
const adminCache = new Map(); // userId → { isAdmin, ts }
const ADMIN_CACHE_TTL_MS = 30_000;

async function isAdminUser(userId) {
  if (!userId) return false;
  const cached = adminCache.get(userId);
  if (cached && Date.now() - cached.ts < ADMIN_CACHE_TTL_MS) return cached.isAdmin;
  try {
    const r = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = r.rows[0]?.role === 'admin';
    adminCache.set(userId, { isAdmin, ts: Date.now() });
    return isAdmin;
  } catch {
    return false;
  }
}

function invalidateAdminCache(userId) {
  if (userId) adminCache.delete(userId);
  else adminCache.clear();
}

async function requireAdmin(req, res, next) {
  const ok = await isAdminUser(req.userId);
  if (!ok) return res.status(403).json({ error: 'forbidden', message: 'Admin yetkisi gerekli.' });
  next();
}

// GET /admin/reports?status=pending — şikayetler listesi
router.get('/reports', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const r = await pool.query(
      `SELECT
         r.id, r.target_type, r.target_id, r.reason, r.status,
         r.created_at, r.reviewed_at, r.reviewer_notes,
         reporter.id AS reporter_id,
         reporter.display_name AS reporter_name
       FROM reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       WHERE r.status = $1
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [status]
    );
    res.json({ reports: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/reports/:id — şikayet detayı + hedef içerik
router.get('/reports/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rep = await pool.query(
      `SELECT
         r.*,
         reporter.display_name AS reporter_name
       FROM reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (rep.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const report = rep.rows[0];

    let target = null;
    let targetOwnerId = null;

    if (report.target_type === 'listing') {
      const l = await pool.query(
        `SELECT l.id, l.title, l.description, l.price, l.is_negotiable,
                l.created_at, u.id AS owner_id, u.display_name AS owner_name,
                u.status AS owner_status,
                ARRAY(
                  SELECT json_build_object('url', p.url, 'thumb_url', p.thumb_url)
                  FROM listing_photos p WHERE p.listing_id = l.id
                  ORDER BY p.ordering ASC
                ) AS photos
         FROM listings l JOIN users u ON u.id = l.user_id
         WHERE l.id = $1`,
        [report.target_id]
      );
      target = l.rows[0] || null;
      targetOwnerId = target?.owner_id;
    } else if (report.target_type === 'message') {
      const m = await pool.query(
        `SELECT m.id, m.content, m.sent_at, m.conversation_id,
                sender.id AS sender_id, sender.display_name AS sender_name,
                sender.status AS sender_status
         FROM messages m JOIN users sender ON sender.id = m.sender_id
         WHERE m.id = $1`,
        [report.target_id]
      );
      target = m.rows[0] || null;
      targetOwnerId = target?.sender_id;
    } else if (report.target_type === 'user') {
      const u = await pool.query(
        `SELECT id, display_name, created_at, status,
                (SELECT COUNT(*) FROM listings WHERE user_id = users.id) AS listing_count,
                (SELECT COUNT(*) FROM reports WHERE target_type = 'user' AND target_id = users.id) AS report_count
         FROM users WHERE id = $1`,
        [report.target_id]
      );
      target = u.rows[0] || null;
      targetOwnerId = target?.id;
    }

    res.json({ report, target, targetOwnerId });
  } catch (err) {
    next(err);
  }
});

// POST /admin/reports/:id/action — aksiyon al
// body: { action: 'delete_content' | 'suspend_user' | 'dismiss', notes? }
const actionSchema = Joi.object({
  action: Joi.string().valid('delete_content', 'suspend_user', 'dismiss').required(),
  notes: Joi.string().max(500).allow('').optional(),
});

router.post('/reports/:id/action', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = actionSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const r = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const report = r.rows[0];

    const notes = value.notes || '';
    let summary = '';

    if (value.action === 'delete_content') {
      if (report.target_type === 'listing') {
        // R2 foto URL'lerini önden topla (cascade öncesi)
        const photoRes = await pool.query(
          'SELECT url, thumb_url FROM listing_photos WHERE listing_id = $1',
          [report.target_id]
        );
        const photoUrls = photoRes.rows
          .flatMap((r) => [r.url, r.thumb_url])
          .filter((u) => typeof u === 'string' && u.length > 0);

        await pool.query('DELETE FROM listings WHERE id = $1', [report.target_id]);
        require('../services/storage').cleanupPhotoUrls(photoUrls, `report delete listing ${report.target_id}`);
        summary = 'İlan silindi';
      } else if (report.target_type === 'message') {
        await pool.query('DELETE FROM messages WHERE id = $1', [report.target_id]);
        summary = 'Mesaj silindi';
      } else {
        return res.status(400).json({ error: 'cannot_delete_user_directly', message: 'Kullanıcıyı silmek için suspend_user kullan.' });
      }
      await pool.query(
        `UPDATE reports SET status = 'action_taken', reviewed_at = now(), reviewer_notes = $2
         WHERE id = $1`,
        [req.params.id, `${summary}${notes ? ' — ' + notes : ''}`]
      );
    } else if (value.action === 'suspend_user') {
      let userIdToSuspend = report.target_id;
      if (report.target_type === 'listing') {
        const l = await pool.query('SELECT user_id FROM listings WHERE id = $1', [report.target_id]);
        userIdToSuspend = l.rows[0]?.user_id;
      } else if (report.target_type === 'message') {
        const m = await pool.query('SELECT sender_id FROM messages WHERE id = $1', [report.target_id]);
        userIdToSuspend = m.rows[0]?.sender_id;
      }
      if (!userIdToSuspend) return res.status(404).json({ error: 'target_user_not_found' });
      await pool.query(
        "UPDATE users SET status = 'suspended' WHERE id = $1",
        [userIdToSuspend]
      );
      summary = 'Kullanıcı askıya alındı';
      await pool.query(
        `UPDATE reports SET status = 'action_taken', reviewed_at = now(), reviewer_notes = $2
         WHERE id = $1`,
        [req.params.id, `${summary}${notes ? ' — ' + notes : ''}`]
      );
    } else if (value.action === 'dismiss') {
      summary = 'Geçerli sebep yok';
      await pool.query(
        `UPDATE reports SET status = 'dismissed', reviewed_at = now(), reviewer_notes = $2
         WHERE id = $1`,
        [req.params.id, `${summary}${notes ? ' — ' + notes : ''}`]
      );
    }

    console.log(`[admin] action=${value.action} report=${req.params.id} by user=${req.userId}`);
    res.json({ ok: true, summary });
  } catch (err) {
    next(err);
  }
});

// GET /admin/sms-balance — Twilio ve NetGSM bakiyeleri
router.get('/sms-balance', requireAuth, requireAdmin, async (req, res, next) => {
  const result = { twilio: null, netgsm: null };

  // Twilio
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (twilioSid && twilioToken) {
    try {
      const twilio = require('twilio')(twilioSid, twilioToken);
      const b = await twilio.balance.fetch();
      result.twilio = {
        balance: parseFloat(b.balance),
        currency: b.currency || 'USD',
        ok: true,
      };
    } catch (e) {
      result.twilio = { ok: false, error: e.message };
    }
  }

  // NetGSM — text response döner: "balance|son_yukleme" formatında
  const netgsmUser = process.env.NETGSM_USERCODE;
  const netgsmPass = process.env.NETGSM_PASSWORD;
  if (netgsmUser && netgsmPass) {
    try {
      const axios = require('axios');
      const r = await axios.get('https://api.netgsm.com.tr/balance/list/get', {
        params: { usercode: netgsmUser, password: netgsmPass, stip: 1 },
        timeout: 8000,
      });
      // Response: "1234.56|son_yuklenen" veya error code (50, 60, vs)
      const text = String(r.data || '').trim();
      if (/^[\d.]+/.test(text)) {
        const [balanceStr, lastTopupStr] = text.split('|');
        result.netgsm = {
          balance: parseFloat(balanceStr),
          last_topup: lastTopupStr || null,
          currency: 'KREDİ',
          ok: true,
        };
      } else {
        // NetGSM error codes: 30=auth, 50=user blocked, vs.
        result.netgsm = { ok: false, error: `NetGSM kod: ${text}` };
      }
    } catch (e) {
      result.netgsm = { ok: false, error: e.message };
    }
  }

  res.json(result);
});

// GET /admin/stats — özet (eski)
router.get('/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM reports WHERE status = 'pending') AS pending,
        (SELECT COUNT(*) FROM reports WHERE status = 'action_taken') AS action_taken,
        (SELECT COUNT(*) FROM reports WHERE status = 'dismissed') AS dismissed,
        (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS suspended_users,
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM listings) AS total_listings
    `);
    res.json(r.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /admin/dashboard — Dashboard için özet metrikler
// Bugün (00:00'dan itibaren) + dün karşılaştırması + toplam/aktif rakamlar
router.get('/dashboard', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(`
      WITH today AS (SELECT date_trunc('day', now()) AS ts),
           yesterday AS (SELECT date_trunc('day', now() - interval '1 day') AS ts),
           two_days_ago AS (SELECT date_trunc('day', now() - interval '2 days') AS ts)
      SELECT
        -- KAYITLAR
        (SELECT COUNT(*)::int FROM users WHERE created_at >= (SELECT ts FROM today))                             AS signup_today,
        (SELECT COUNT(*)::int FROM users WHERE created_at >= (SELECT ts FROM yesterday) AND created_at < (SELECT ts FROM today))    AS signup_yesterday,
        (SELECT COUNT(*)::int FROM users)                                                                        AS users_total,
        (SELECT COUNT(*)::int FROM users WHERE status = 'active')                                                AS users_active,
        (SELECT COUNT(*)::int FROM users WHERE status = 'suspended')                                             AS users_suspended,
        (SELECT COUNT(*)::int FROM users WHERE status = 'banned')                                                AS users_banned,

        -- İLANLAR
        (SELECT COUNT(*)::int FROM listings WHERE created_at >= (SELECT ts FROM today))                          AS listings_today,
        (SELECT COUNT(*)::int FROM listings WHERE created_at >= (SELECT ts FROM yesterday) AND created_at < (SELECT ts FROM today)) AS listings_yesterday,
        (SELECT COUNT(*)::int FROM listings WHERE status = 'active')                                             AS listings_active,
        (SELECT COUNT(*)::int FROM listings)                                                                     AS listings_total,

        -- MATLUB İSTEKLERİ
        (SELECT COUNT(*)::int FROM requests WHERE created_at >= (SELECT ts FROM today))                          AS requests_today,
        (SELECT COUNT(*)::int FROM requests WHERE created_at >= (SELECT ts FROM yesterday) AND created_at < (SELECT ts FROM today)) AS requests_yesterday,
        (SELECT COUNT(*)::int FROM requests WHERE status = 'active' AND admin_removed_at IS NULL)                AS requests_active,
        (SELECT COUNT(*)::int FROM requests)                                                                     AS requests_total,

        -- MESAJLAR
        (SELECT COUNT(*)::int FROM messages WHERE sent_at >= (SELECT ts FROM today))                             AS messages_today,
        (SELECT COUNT(*)::int FROM messages WHERE sent_at >= (SELECT ts FROM yesterday) AND sent_at < (SELECT ts FROM today))       AS messages_yesterday,

        -- AKTİF KULLANICI (DAU / MAU)
        (SELECT COUNT(*)::int FROM users WHERE last_active_at >= now() - interval '24 hours')                    AS dau,
        (SELECT COUNT(*)::int FROM users WHERE last_active_at >= now() - interval '7 days')                      AS wau,
        (SELECT COUNT(*)::int FROM users WHERE last_active_at >= now() - interval '30 days')                     AS mau,

        -- ŞİKAYETLER
        (SELECT COUNT(*)::int FROM reports WHERE status = 'pending')                                             AS reports_pending,
        (SELECT COUNT(*)::int FROM reports WHERE created_at >= (SELECT ts FROM today))                           AS reports_today,

        -- CİNSİYET DAĞILIMI
        (SELECT COUNT(*)::int FROM users WHERE gender = 'female')                                                AS users_female,
        (SELECT COUNT(*)::int FROM users WHERE gender = 'male')                                                  AS users_male,

        -- KONUŞMA
        (SELECT COUNT(*)::int FROM conversations)                                                                AS conversations_total,

        -- REHBER SAĞLIĞI (network effect için kritik)
        -- Ortalama contacts sayısı (0 rehberli hariç — sadece sync yapmış kullanıcılar)
        (SELECT COALESCE(AVG(cnt)::int, 0) FROM (
           SELECT COUNT(*)::int AS cnt FROM user_contacts GROUP BY user_id
         ) t)                                                                                                     AS avg_contacts,
        -- Median (çok az kişi ile çok fazla arasındaki gerçek orta)
        (SELECT COALESCE((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cnt))::int, 0) FROM (
           SELECT COUNT(*)::int AS cnt FROM user_contacts GROUP BY user_id
         ) t)                                                                                                     AS median_contacts,
        -- Hiç rehber paylaşmamış kullanıcı (0 satır user_contacts)
        (SELECT COUNT(*)::int FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.user_id = u.id))                               AS users_no_contacts,
        -- Az rehberli — 1-4 arası (Selected Contacts patern)
        (SELECT COUNT(*)::int FROM (
           SELECT user_id FROM user_contacts GROUP BY user_id HAVING COUNT(*) BETWEEN 1 AND 4
         ) t)                                                                                                     AS users_low_contacts,
        -- Sağlıklı rehberli — 20+
        (SELECT COUNT(*)::int FROM (
           SELECT user_id FROM user_contacts GROUP BY user_id HAVING COUNT(*) >= 20
         ) t)                                                                                                     AS users_healthy_contacts,

        -- PUSH SAĞLIĞI (bildirim ulaşabilirlik)
        (SELECT COUNT(DISTINCT user_id)::int FROM device_tokens)                                                  AS users_with_device,
        (SELECT COUNT(*)::int FROM users u WHERE NOT EXISTS
           (SELECT 1 FROM device_tokens WHERE user_id = u.id))                                                    AS users_without_device,
        (SELECT COUNT(*)::int FROM device_tokens)                                                                 AS devices_total,

        -- POTANSİYEL KULLANICI HAVUZU
        -- Rehberlerde toplam kaç FARKLI telefon var (mükerrer sayılmaz) — Abadan'ın erişebileceği potansiyel
        (SELECT COUNT(DISTINCT contact_phone_hash)::int FROM user_contacts)                                       AS unique_contacts_pool,
        -- Bunlardan kaçı zaten kayıtlı (mevcut kullanıcılar)
        (SELECT COUNT(DISTINCT u.id)::int
         FROM users u
         WHERE u.phone_hash IN (SELECT DISTINCT contact_phone_hash FROM user_contacts))                            AS pool_registered,
        -- Kayıtlı olmayan = ÇEKİM POTANSİYELİ (rehberlerde var ama Abadan'da yok)
        (SELECT COUNT(*)::int FROM (
           SELECT DISTINCT contact_phone_hash FROM user_contacts
           WHERE contact_phone_hash NOT IN (SELECT phone_hash FROM users WHERE phone_hash IS NOT NULL)
         ) t)                                                                                                     AS pool_unregistered
    `);
    res.json(r.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /admin/users?q=arama&status=active&limit=50&offset=0
// Kullanıcı arama — display_name (case-insensitive contains) veya id (UUID exact)
router.get('/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all');
    const sortBy = String(req.query.sortBy || 'recent'); // recent | low_contacts | reports | listings
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    const conds = [];
    const params = [];

    // ID (UUID) tam eşleşme veya isim ILIKE
    if (q) {
      // UUID formatına benziyorsa ID ile ara, değilse isim
      const looksLikeUuid = /^[0-9a-f-]{8,}$/i.test(q);
      if (looksLikeUuid) {
        params.push(q);
        conds.push(`u.id::text ILIKE '%' || $${params.length} || '%'`);
      } else {
        params.push(q);
        conds.push(`u.display_name ILIKE '%' || $${params.length} || '%'`);
      }
    }
    if (status !== 'all') {
      params.push(status);
      conds.push(`u.status = $${params.length}`);
    }

    // Push izni filtresi: hasDevice=true → cihaz kayıtlı olanlar, false → olmayanlar
    const hasDevice = String(req.query.hasDevice || '');
    if (hasDevice === 'true') {
      conds.push(`EXISTS (SELECT 1 FROM device_tokens WHERE user_id = u.id)`);
    } else if (hasDevice === 'false') {
      conds.push(`NOT EXISTS (SELECT 1 FROM device_tokens WHERE user_id = u.id)`);
    }

    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    // Sıralama — dashboard'dan gelen "Az Rehberli" tıklaması için low_contacts özel
    let orderBy;
    switch (sortBy) {
      case 'low_contacts':
        // 0-4 rehberli olanlar önce, kayıt tarihi yeni olanlar önde
        orderBy = 'contacts_count ASC, u.created_at DESC';
        break;
      case 'reports':
        orderBy = 'reports_against DESC, u.last_active_at DESC NULLS LAST';
        break;
      case 'listings':
        orderBy = 'active_listing_count DESC, u.last_active_at DESC NULLS LAST';
        break;
      default: // 'recent'
        orderBy = 'u.last_active_at DESC NULLS LAST';
    }

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT
         u.id, u.display_name, u.avatar_url, u.gender, u.location_city, u.status, u.role,
         u.created_at, u.last_active_at, u.onboarded_at,
         (SELECT COUNT(*)::int FROM listings WHERE user_id = u.id AND status = 'active')     AS active_listing_count,
         (SELECT COUNT(*)::int FROM listings WHERE user_id = u.id)                            AS listings_total,
         (SELECT COUNT(*)::int FROM messages WHERE sender_id = u.id)                          AS messages_sent,
         (SELECT COUNT(DISTINCT c.id)::int FROM conversations c
           WHERE c.buyer_id = u.id OR c.seller_id = u.id)                                     AS conversations_count,
         (SELECT COUNT(*)::int FROM reports  WHERE target_type = 'user' AND target_id = u.id) AS reports_against,
         (SELECT COUNT(*)::int FROM reports  WHERE reporter_id = u.id)                        AS reports_by,
         (SELECT COUNT(*)::int FROM user_contacts WHERE user_id = u.id)                       AS contacts_count,
         (SELECT COUNT(*)::int FROM device_tokens WHERE user_id = u.id)                       AS devices_count,
         (SELECT COUNT(*)::int FROM blocks WHERE blocker_id = u.id OR blocked_id = u.id)      AS blocks_count,
         (SELECT COUNT(*)::int FROM listing_shares WHERE user_id = u.id)                      AS shares_total,
         (SELECT COALESCE(SUM(view_count), 0)::int FROM listing_shares WHERE user_id = u.id)  AS shares_views,
         (SELECT COALESCE(SUM(signup_count), 0)::int FROM listing_shares WHERE user_id = u.id) AS shares_signups
       FROM users u
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json({ users: r.rows, count: r.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id — kullanıcı detayı (ilanları, mesaj sayısı, şikayet sayısı)
router.get('/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const u = await pool.query(
      `SELECT id, display_name, avatar_url, bio, gender, location_city, status,
              created_at, last_active_at, onboarded_at, suspended_until
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const user = u.rows[0];

    // İstatistikler tek seferde
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM listings   WHERE user_id = $1)                            AS listings_total,
         (SELECT COUNT(*)::int FROM listings   WHERE user_id = $1 AND status = 'active')      AS listings_active,
         (SELECT COUNT(*)::int FROM messages   WHERE sender_id = $1)                          AS messages_sent,
         (SELECT COUNT(DISTINCT id)::int FROM conversations WHERE buyer_id = $1 OR seller_id = $1) AS conversations_count,
         (SELECT COUNT(*)::int FROM reports    WHERE target_type = 'user' AND target_id = $1) AS reports_against,
         (SELECT COUNT(*)::int FROM reports    WHERE reporter_id = $1)                        AS reports_by,
         (SELECT COUNT(*)::int FROM user_contacts WHERE user_id = $1)                         AS contacts_count,
         (SELECT COUNT(*)::int FROM device_tokens WHERE user_id = $1)                         AS devices_count,
         (SELECT COUNT(*)::int FROM blocks WHERE blocker_id = $1 OR blocked_id = $1)     AS blocks_count,
         -- Paylaşım katkısı (growth)
         (SELECT COUNT(*)::int FROM listing_shares WHERE user_id = $1)                        AS shares_total,
         (SELECT COALESCE(SUM(view_count), 0)::int FROM listing_shares WHERE user_id = $1)    AS shares_views,
         (SELECT COALESCE(SUM(signup_count), 0)::int FROM listing_shares WHERE user_id = $1)  AS shares_signups,
         -- Bu kullanıcı bir share'den geldiyse
         (SELECT s.token FROM listing_shares s WHERE s.id = (SELECT referred_by_share_id FROM users WHERE id = $1)) AS referred_by_token`,
      [req.params.id]
    );

    // Son 5 ilan (özet)
    const recentListings = await pool.query(
      `SELECT id, title, price, status, created_at
       FROM listings WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    // Kendisi hakkında son 5 şikayet
    const recentReports = await pool.query(
      `SELECT id, target_type, reason, status, created_at
       FROM reports WHERE target_type = 'user' AND target_id = $1
       ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({
      user,
      stats: stats.rows[0],
      recent_listings: recentListings.rows,
      recent_reports: recentReports.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/status — active/suspended/banned + reason zorunlu + duration opsiyonel
// duration_hours: null → süresiz (aktif olana kadar)
//                sayı → o kadar saat sonra otomatik aktife dönecek
// Audit log: admin_actions tablosuna yazılır.
const statusSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended', 'banned').required(),
  reason: Joi.string().min(3).max(500).required(),
  duration_hours: Joi.number().integer().min(1).max(24 * 365).allow(null).optional(),
});

router.post('/users/:id/status', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = statusSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Kendini banlamayı engelle
    if (req.params.id === req.userId && value.status !== 'active') {
      return res.status(400).json({ error: 'cannot_ban_self', message: 'Kendini banlayamazsın.' });
    }

    // Askıya alma süreli olabilir; ban ve unban süresizdir
    const suspendedUntil = value.status === 'suspended' && value.duration_hours
      ? new Date(Date.now() + value.duration_hours * 3600 * 1000)
      : null;

    const r = await pool.query(
      `UPDATE users SET status = $2, suspended_until = $3 WHERE id = $1
       RETURNING id, display_name, status, suspended_until`,
      [req.params.id, value.status, suspendedUntil]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });

    // Middleware cache'ini patlat — hemen etkili olsun
    invalidateUserStatusCache(req.params.id);

    // Audit log
    const actionMap = { active: 'unban', suspended: 'suspend', banned: 'ban' };
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.userId,
        req.params.id,
        actionMap[value.status],
        value.reason,
        JSON.stringify({
          duration_hours: value.duration_hours || null,
          suspended_until: suspendedUntil,
        }),
      ]
    );

    console.log(`[admin] user_status_change id=${req.params.id} status=${value.status} by=${req.userId} reason=${value.reason}`);
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/note — kullanıcı hakkında admin notu yaz
// Audit log'a action='note' olarak eklenir. Kullanıcıya bildirim gitmez — sadece admin görür.
const noteSchema = Joi.object({
  note: Joi.string().min(3).max(1000).required(),
});

router.post('/users/:id/note', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = noteSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const u = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason)
       VALUES ($1, $2, 'note', $3)`,
      [req.userId, req.params.id, value.note]
    );

    console.log(`[admin] note user=${req.params.id} by=${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id/actions — bu kullanıcı hakkındaki tüm admin aksiyonları
router.get('/users/:id/actions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.action, a.reason, a.metadata, a.created_at,
              a.admin_user_id, u.display_name AS admin_name
       FROM admin_actions a
       LEFT JOIN users u ON u.id = a.admin_user_id
       WHERE a.target_user_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ actions: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/actions/recent — genel moderasyon akışı (dashboard için)
router.get('/actions/recent', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const r = await pool.query(
      `SELECT a.id, a.action, a.reason, a.metadata, a.created_at,
              a.admin_user_id, admin.display_name AS admin_name,
              a.target_user_id, target.display_name AS target_name
       FROM admin_actions a
       LEFT JOIN users admin ON admin.id = a.admin_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ actions: r.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/broadcast — seçili kullanıcılara uygulama içi bildirim gönder
// Body: { userIds: string[], title: string, body: string }
// Not: sadece in-app notification. Push notification istenirse ayrıca push_broadcast eklenebilir.
const broadcastSchema = Joi.object({
  userIds: Joi.array().items(Joi.string().uuid()).min(1).max(500).required(),
  title: Joi.string().min(1).max(120).required(),
  body: Joi.string().min(1).max(500).required(),
});

router.post('/broadcast', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = broadcastSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Idempotency yok — aynı bildirim tekrar gönderilebilir (admin kararına bırak)
    // Bulk insert — payload'a title ve body'yi koy, type = 'admin_broadcast'
    const now = new Date();
    const rows = [];
    const params = [];
    value.userIds.forEach((uid, idx) => {
      rows.push(`($${idx * 3 + 1}, 'admin_broadcast', $${idx * 3 + 2}::jsonb, $${idx * 3 + 3})`);
      params.push(uid, JSON.stringify({ title: value.title, body: value.body, sender: 'admin' }), now);
    });

    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, payload, created_at)
       VALUES ${rows.join(',')}
       RETURNING id`,
      params
    );

    console.log(`[admin] broadcast in-app sent to ${result.rowCount} users by admin=${req.userId} title="${value.title}"`);

    // Audit log — kimi/kaç kişiye/hangi mesaj (her user için ayrı satır büyür — sadece topluyı logla)
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, NULL, 'broadcast', $2, $3)`,
      [
        req.userId,
        value.title + ' — ' + value.body,
        JSON.stringify({ recipient_count: value.userIds.length, recipient_ids: value.userIds.slice(0, 20) }),
      ]
    ).catch((e) => console.error('[admin] broadcast audit fail:', e.message));

    // Push notification de gönder — arka planda, response'u geciktirmesin
    // Cihaz token varsa ilettir; her user için ayrı çağrı (chunk'lama push service içinde)
    (async () => {
      const { sendToUser } = require('../services/push');
      for (const uid of value.userIds) {
        try {
          await sendToUser(uid, {
            title: value.title,
            body: value.body,
            data: { type: 'admin_broadcast' },
          });
        } catch (err) {
          console.error(`[admin] push fail for ${uid}:`, err.message);
        }
      }
      console.log(`[admin] broadcast push done for ${value.userIds.length} users`);
    })();

    res.json({ ok: true, sent: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// İLAN MODERASYONU
// ═══════════════════════════════════════════════════════════════════

// GET /admin/listings — filtre + arama + sayfalama
// Query: ?q= &category= &city= &status= &sellerId= &limit= &offset=
router.get('/listings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const city = String(req.query.city || '').trim();
    const status = String(req.query.status || 'all');
    const sellerId = String(req.query.sellerId || '').trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    const conds = [];
    const params = [];

    if (q) {
      params.push(q);
      conds.push(`(l.title ILIKE '%' || $${params.length} || '%' OR l.description ILIKE '%' || $${params.length} || '%')`);
    }
    if (category) {
      params.push(parseInt(category, 10));
      conds.push(`l.category_id IN (
        WITH RECURSIVE sub AS (
          SELECT id FROM categories WHERE id = $${params.length}
          UNION ALL
          SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
        ) SELECT id FROM sub
      )`);
    }
    if (city) {
      params.push(city);
      conds.push(`l.location_city ILIKE '%' || $${params.length} || '%'`);
    }
    if (status === 'active') conds.push(`l.status = 'active' AND l.admin_removed_at IS NULL`);
    else if (status === 'sold') conds.push(`l.status = 'sold'`);
    else if (status === 'removed') conds.push(`l.admin_removed_at IS NOT NULL`);
    else if (status === 'featured') conds.push(`l.featured_until > now()`);
    // 'all' → tümü

    if (sellerId) {
      params.push(sellerId);
      conds.push(`l.user_id = $${params.length}`);
    }
    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT l.id, l.title, l.price, l.currency, l.status, l.location_city,
              l.created_at, l.admin_removed_at, l.admin_removed_reason, l.featured_until,
              l.user_id, u.display_name AS seller_name,
              c.name AS category_name,
              (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p
               WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM listing_photos WHERE listing_id = l.id) AS photo_count,
              (SELECT COUNT(*)::int FROM reports WHERE target_type = 'listing' AND target_id = l.id) AS reports_count
       FROM listings l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN categories c ON c.id = l.category_id
       ${whereSql}
       ORDER BY (l.featured_until > now())::int DESC, l.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({ listings: r.rows, count: r.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /admin/listings/:id — detay (foto listesi, satıcı, şikayet sayısı vb.)
router.get('/listings/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const l = await pool.query(
      `SELECT l.id, l.title, l.description, l.price, l.currency, l.status,
              l.location_city, l.location_district, l.category_id, l.created_at, l.updated_at,
              l.admin_removed_at, l.admin_removed_reason, l.featured_until,
              l.user_id, u.display_name AS seller_name, u.avatar_url AS seller_avatar,
              u.status AS seller_status,
              c.name AS category_name
       FROM listings l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.id = $1`,
      [req.params.id]
    );
    if (l.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const photos = await pool.query(
      `SELECT id, url, thumb_url, ordering FROM listing_photos
       WHERE listing_id = $1 ORDER BY ordering`,
      [req.params.id]
    );

    const reports = await pool.query(
      `SELECT id, reason, status, created_at FROM reports
       WHERE target_type = 'listing' AND target_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({ listing: l.rows[0], photos: photos.rows, reports: reports.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/listings/:id/action — remove | restore | feature | delete
// Reason zorunlu, audit log'a yazılır
const listingActionSchema = Joi.object({
  action: Joi.string().valid('remove', 'restore', 'feature', 'unfeature', 'delete').required(),
  reason: Joi.string().min(3).max(500).required(),
  feature_hours: Joi.number().integer().min(1).max(24 * 90).allow(null).optional(), // sadece feature için
});

router.post('/listings/:id/action', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = listingActionSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const l = await pool.query('SELECT id, user_id, title FROM listings WHERE id = $1', [req.params.id]);
    if (l.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const listing = l.rows[0];

    let auditAction = value.action;
    if (value.action === 'remove') {
      await pool.query(
        `UPDATE listings SET admin_removed_at = now(), admin_removed_reason = $2 WHERE id = $1`,
        [req.params.id, value.reason]
      );
      auditAction = 'listing_remove';
    } else if (value.action === 'restore') {
      await pool.query(
        `UPDATE listings SET admin_removed_at = NULL, admin_removed_reason = NULL WHERE id = $1`,
        [req.params.id]
      );
      auditAction = 'listing_restore';
    } else if (value.action === 'feature') {
      const hours = value.feature_hours || 24 * 7;
      const until = new Date(Date.now() + hours * 3600 * 1000);
      await pool.query('UPDATE listings SET featured_until = $2 WHERE id = $1', [req.params.id, until]);
      auditAction = 'listing_feature';
    } else if (value.action === 'unfeature') {
      await pool.query('UPDATE listings SET featured_until = NULL WHERE id = $1', [req.params.id]);
      auditAction = 'listing_unfeature';
    } else if (value.action === 'delete') {
      // KVKK / kalıcı silme — foto, konuşma vs. cascade
      // Önce R2 foto URL'lerini topla (cascade ile silinmeden önce)
      const photoRes = await pool.query(
        'SELECT url, thumb_url FROM listing_photos WHERE listing_id = $1',
        [req.params.id]
      );
      const photoUrls = photoRes.rows
        .flatMap((r) => [r.url, r.thumb_url])
        .filter((u) => typeof u === 'string' && u.length > 0);

      await pool.query('DELETE FROM listings WHERE id = $1', [req.params.id]);

      // R2 cleanup — arka planda
      require('../services/storage').cleanupPhotoUrls(photoUrls, `admin delete listing ${req.params.id}`);

      auditAction = 'listing_delete';
    }

    // Audit log
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.userId,
        listing.user_id,
        auditAction,
        value.reason,
        JSON.stringify({
          listing_id: listing.id,
          listing_title: listing.title,
          feature_hours: value.feature_hours || null,
        }),
      ]
    );

    console.log(`[admin] listing_${value.action} id=${listing.id} by=${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// MATLUB (İSTEK) MODERASYONU
// ═══════════════════════════════════════════════════════════════════

// GET /admin/requests — filtre + arama + sayfalama
router.get('/requests', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all');
    const userId = String(req.query.userId || '').trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    const conds = [];
    const params = [];

    if (q) {
      params.push(q);
      conds.push(`(r.title ILIKE '%' || $${params.length} || '%' OR r.description ILIKE '%' || $${params.length} || '%')`);
    }
    if (status === 'active') conds.push(`r.status = 'active' AND r.admin_removed_at IS NULL`);
    else if (status === 'fulfilled') conds.push(`r.status = 'fulfilled'`);
    else if (status === 'removed') conds.push(`r.admin_removed_at IS NOT NULL`);
    // 'all' → tümü

    if (userId) {
      params.push(userId);
      conds.push(`r.user_id = $${params.length}`);
    }
    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const r = await pool.query(
      `SELECT r.id, r.title, r.description, r.status, r.fulfilled_at,
              r.created_at, r.view_count,
              r.admin_removed_at, r.admin_removed_reason,
              r.restricted_to_gender,
              r.user_id,
              u.display_name AS user_name,
              c.name AS category_name
       FROM requests r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN categories c ON c.id = r.category_id
       ${whereSql}
       ORDER BY r.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({ requests: r.rows, count: r.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /admin/requests/:id — detay
router.get('/requests/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rq = await pool.query(
      `SELECT r.*,
              u.display_name AS user_name, u.avatar_url AS user_avatar, u.status AS user_status,
              c.name AS category_name
       FROM requests r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (rq.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ request: rq.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /admin/requests/:id/action — remove | restore | delete
const reqActionSchema = Joi.object({
  action: Joi.string().valid('remove', 'restore', 'delete').required(),
  reason: Joi.string().min(3).max(500).required(),
});

router.post('/requests/:id/action', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = reqActionSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const rq = await pool.query('SELECT id, user_id, title FROM requests WHERE id = $1', [req.params.id]);
    if (rq.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const request = rq.rows[0];

    let auditAction = value.action;
    if (value.action === 'remove') {
      await pool.query(
        `UPDATE requests SET admin_removed_at = now(), admin_removed_reason = $2 WHERE id = $1`,
        [req.params.id, value.reason]
      );
      auditAction = 'request_remove';
    } else if (value.action === 'restore') {
      await pool.query(
        `UPDATE requests SET admin_removed_at = NULL, admin_removed_reason = NULL WHERE id = $1`,
        [req.params.id]
      );
      auditAction = 'request_restore';
    } else if (value.action === 'delete') {
      await pool.query('DELETE FROM requests WHERE id = $1', [req.params.id]);
      auditAction = 'request_delete';
    }

    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.userId, request.user_id, auditAction, value.reason,
        JSON.stringify({ request_id: request.id, request_title: request.title }),
      ]
    );

    console.log(`[admin] request_${value.action} id=${request.id} by=${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// YASAK KELİME FİLTRESİ
// ═══════════════════════════════════════════════════════════════════

// GET /admin/banned-words
router.get('/banned-words', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT bw.id, bw.pattern, bw.is_regex, bw.category, bw.message, bw.created_at,
              u.display_name AS added_by_name
       FROM banned_words bw
       LEFT JOIN users u ON u.id = bw.added_by
       ORDER BY bw.created_at DESC`
    );
    res.json({ words: r.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/banned-words
const bannedWordSchema = Joi.object({
  pattern: Joi.string().min(1).max(200).required(),
  is_regex: Joi.boolean().default(false),
  category: Joi.string().max(50).allow('').optional(),
  message: Joi.string().max(200).allow('').optional(),
});

router.post('/banned-words', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = bannedWordSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // is_regex ise pattern'in geçerli bir regex olduğunu doğrula
    if (value.is_regex) {
      try { new RegExp(value.pattern, 'i'); }
      catch { return res.status(400).json({ error: 'invalid_regex', message: 'Geçersiz regex.' }); }
    }

    const r = await pool.query(
      `INSERT INTO banned_words (pattern, is_regex, category, message, added_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [value.pattern, value.is_regex, value.category || null, value.message || null, req.userId]
    );
    require('../services/banned-words').invalidateCache();
    res.json({ word: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/banned-words/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM banned_words WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    require('../services/banned-words').invalidateCache();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// SİSTEM İZLEME
// ═══════════════════════════════════════════════════════════════════

// GET /admin/system/sms-log?limit=100
router.get('/system/sms-log', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
    const r = await pool.query(
      `SELECT id, provider, phone_masked, purpose, status, error, duration_ms, created_at
       FROM sms_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    // Özet istatistikler (son 24 saat)
    const stats = await pool.query(
      `SELECT
         COUNT(*)::int AS total_24h,
         COUNT(*) FILTER (WHERE status = 'sent')::int   AS sent_24h,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_24h,
         ROUND(AVG(duration_ms))::int AS avg_ms
       FROM sms_log WHERE created_at > now() - interval '24 hours'`
    );
    res.json({ logs: r.rows, stats: stats.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/system/push-log?limit=100
router.get('/system/push-log', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
    const r = await pool.query(
      `SELECT p.id, p.type, p.title, p.body_short, p.tokens_count, p.ok_count, p.err_count,
              p.status, p.error, p.created_at,
              u.display_name AS user_name
       FROM push_log p
       LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [limit]
    );
    const stats = await pool.query(
      `SELECT
         COUNT(*)::int AS total_24h,
         SUM(tokens_count)::int AS tokens_24h,
         SUM(ok_count)::int     AS ok_24h,
         SUM(err_count)::int    AS err_24h,
         COUNT(*) FILTER (WHERE status = 'no_tokens')::int AS no_tokens_24h
       FROM push_log WHERE created_at > now() - interval '24 hours'`
    );
    res.json({ logs: r.rows, stats: stats.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/system/expo-quota — Expo push + EAS Update/Build kalan limit özeti
// Not: Expo push service ücretsiz + sınırsız (fair use). EAS Update/Build plan-bazlı.
// Bu endpoint DB'den push kullanımını topluyor + plan limitlerini gösteriyor.
router.get('/system/expo-quota', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    // Kendi push_log tablomuzdan sayaçlar
    const stats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int  AS pushes_24h,
         COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int    AS pushes_7d,
         COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int   AS pushes_30d,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int  AS pushes_month,
         COALESCE(SUM(tokens_count) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS tokens_24h,
         COALESCE(SUM(tokens_count) FILTER (WHERE created_at > now() - interval '30 days'),  0)::int AS tokens_30d,
         COALESCE(SUM(ok_count)     FILTER (WHERE created_at > now() - interval '30 days'),  0)::int AS ok_30d,
         COALESCE(SUM(err_count)    FILTER (WHERE created_at > now() - interval '30 days'),  0)::int AS err_30d,
         COUNT(*) FILTER (WHERE status = 'failed'  AND created_at > now() - interval '24 hours')::int AS failed_24h
       FROM push_log`
    );

    // Aktif kullanıcı sayısı — MAU proxy'si (EAS Update MAU limitine yakınlık)
    // last_active_at üzerinden 30 gün.
    const tokens = await pool.query(
      `SELECT COUNT(DISTINCT id)::int AS active_tokens
       FROM users
       WHERE status = 'active' AND last_active_at > now() - interval '30 days'`
    ).catch(() => ({ rows: [{ active_tokens: 0 }] }));

    const plan = (process.env.EAS_PLAN || 'production').toLowerCase();

    // Expo'nun public plan limitleri (Ağustos 2026 itibarı — expo.dev/pricing kontrol et)
    const PLANS = {
      free: {
        eas_update_mau: 1000,
        eas_build_monthly: 30,
        push_service: 'Sınırsız (fair use)',
      },
      production: {
        eas_update_mau: 50000,
        eas_build_monthly: null,   // esnek, kullanım bazlı
        push_service: 'Sınırsız (fair use)',
      },
      enterprise: {
        eas_update_mau: null,      // özel anlaşma
        eas_build_monthly: null,
        push_service: 'Sınırsız',
      },
    };
    const limits = PLANS[plan] || PLANS.production;

    const activeTokens = tokens.rows[0].active_tokens || 0;
    const mauLimit = limits.eas_update_mau;
    const mauUsage = mauLimit ? Math.min(100, Math.round((activeTokens / mauLimit) * 100)) : null;
    const mauStatus = mauUsage == null ? 'unlimited' : mauUsage >= 90 ? 'danger' : mauUsage >= 70 ? 'warn' : 'ok';

    res.json({
      plan,
      push: {
        service: 'Expo Push Service',
        limit_type: 'unlimited',
        limit_note: 'Ücretsiz + sınırsız (fair use). ~100 token/istek batch limiti var.',
        pushes_24h:   stats.rows[0].pushes_24h,
        pushes_7d:    stats.rows[0].pushes_7d,
        pushes_30d:   stats.rows[0].pushes_30d,
        pushes_month: stats.rows[0].pushes_month,
        tokens_sent_24h: stats.rows[0].tokens_24h,
        tokens_sent_30d: stats.rows[0].tokens_30d,
        ok_30d:  stats.rows[0].ok_30d,
        err_30d: stats.rows[0].err_30d,
        failed_pushes_24h: stats.rows[0].failed_24h,
      },
      eas_update: {
        plan,
        mau_limit: mauLimit,
        active_tokens_30d: activeTokens,
        usage_percent: mauUsage,
        status: mauStatus,
        note: mauLimit
          ? `${activeTokens.toLocaleString('tr-TR')} / ${mauLimit.toLocaleString('tr-TR')} MAU`
          : 'Sınırsız',
      },
      eas_build: {
        plan,
        monthly_limit: limits.eas_build_monthly,
        note: limits.eas_build_monthly
          ? `Aylık ${limits.eas_build_monthly} build (kalan sayı expo.dev'de görünür)`
          : 'Aylık limit yok (kullanım bazlı)',
      },
      docs: {
        pricing:   'https://expo.dev/pricing',
        dashboard: 'https://expo.dev/accounts',
      },
    });
  } catch (err) {
    console.error('[expo-quota] fail:', err.message);
    next(err);
  }
});

// GET /admin/system/expo-live-usage — Expo API'dan canlı kullanım (MAU, Build, Bandwidth)
// ENV: EXPO_TOKEN (expo.dev/settings/access-tokens'dan üret) + EXPO_ACCOUNT_NAME (varsayılan: bajak)
//
// Expo public GraphQL API dokümante değil — endpoint schema değişebilir.
// Bağlanamazsa dashboard linki döner, panel oradan devam eder.
router.get('/system/expo-live-usage', requireAuth, requireAdmin, async (req, res, next) => {
  const token = process.env.EXPO_TOKEN;
  const accountName = process.env.EXPO_ACCOUNT_NAME || 'bajak';

  if (!token) {
    return res.json({
      configured: false,
      message: 'EXPO_TOKEN env değişkeni ayarlanmamış. expo.dev/settings/access-tokens sayfasından token üret ve Railway env\'ine ekle.',
      dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
    });
  }

  // Expo GraphQL sorgusu — meActor.accounts üzerinden gidip hedef hesabı bul.
  // Bu Expo'nun kendi CLI'ının kullandığı pattern; en güvenilir yol.
  // Alan isimleri kısmen dokümante değil — mevcut olanları çeker, olmayanları null bırakır.
  const query = `
    query MyUsage {
      meActor {
        __typename
        id
        ... on UserActor {
          username
          accounts {
            id
            name
            subscription {
              planEnum
              status
            }
          }
        }
        ... on Robot {
          firstName
          accounts {
            id
            name
            subscription {
              planEnum
              status
            }
          }
        }
      }
    }
  `;

  async function gql(q, variables) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('https://api.expo.dev/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ query: q, variables: variables || {} }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    return resp.json();
  }

  try {
    // 1) meActor → tüm hesaplar
    const meData = await gql(query);
    if (meData.errors) {
      return res.json({
        configured: true,
        error: 'meActor query hatası: ' + JSON.stringify(meData.errors).slice(0, 400),
        dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
      });
    }
    const actor = meData.data?.meActor;
    if (!actor || !actor.accounts) {
      return res.json({
        configured: true,
        error: 'meActor.accounts alanı boş — token yetkisi yetersiz olabilir',
        dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
      });
    }
    const acct = actor.accounts.find(a => a.name === accountName);
    if (!acct) {
      return res.json({
        configured: true,
        error: `Hesap listede yok: ${accountName}. Mevcut: ${actor.accounts.map(a => a.name).join(', ')}`,
        dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
      });
    }

    // 2) Hesap ID ile usage sorusu — birkaç olası alan denemesi.
    // Expo'nun schema'sı zamanla değişiyor; hangisi çalışırsa onu kullan.
    const usageQuery = `
      query AcctUsage($id: ID!) {
        account: accountByName(id: $id) {
          id
          name
        }
      }
    `;

    res.json({
      configured: true,
      account_name: acct.name,
      account_id: acct.id,
      plan: acct.subscription?.planEnum || 'FREE',
      status: acct.subscription?.status,
      usage: null,
      note: 'Expo GraphQL schema\'sında usage metrics için public alan yok. Sayıları expo.dev dashboard\'dan görüyor olacaksın; kısa yol linki aşağıda.',
      other_accounts: actor.accounts.map(a => a.name).filter(n => n !== accountName),
      dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[expo-live-usage] fail:', err.message);
    res.json({
      configured: true,
      error: 'Network/API hatası: ' + err.message,
      dashboard_url: `https://expo.dev/accounts/${accountName}/settings/usage`,
    });
  }
});

// GET /admin/system/api-metrics — in-memory summary + recent + slow endpoints
router.get('/system/api-metrics', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const apiMetrics = require('../services/api-metrics');
    res.json({
      overall: apiMetrics.overall(),
      slow_endpoints: apiMetrics.summary(30),
      recent: apiMetrics.recent(50),
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/system/server-info — process + DB pool
router.get('/system/server-info', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const mem = process.memoryUsage();
    const uptimeSec = Math.round(process.uptime());
    const info = {
      node_version: process.version,
      env: process.env.NODE_ENV || 'development',
      uptime_seconds: uptimeSec,
      uptime_human: humanUptime(uptimeSec),
      memory_mb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heap_used: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      db_pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };

    // DB size + limit
    try {
      const dbSize = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
      info.db_size_mb = Math.round(Number(dbSize.rows[0].bytes) / 1024 / 1024);
      // Railway plan limit'i env'den (5 GB hobby, 100 GB pro — kullanıcı ayarlar)
      const limitMb = parseInt(process.env.DB_VOLUME_LIMIT_MB || '5120', 10);
      info.db_size_limit_mb = limitMb;
      info.db_size_percent = Math.round((info.db_size_mb / limitMb) * 100);
    } catch {}

    // DB row sayıları — hangi tablo ne kadar yer kaplıyor (upgrade karar vermek için)
    try {
      const tables = await pool.query(
        `SELECT relname AS table,
                pg_total_relation_size(C.oid) AS size_bytes,
                pg_size_pretty(pg_total_relation_size(C.oid)) AS size_pretty
         FROM pg_class C
         LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND C.relkind = 'r'
         ORDER BY pg_total_relation_size(C.oid) DESC
         LIMIT 10`
      );
      info.top_tables = tables.rows.map((t) => ({
        table: t.table,
        size_mb: Math.round(Number(t.size_bytes) / 1024 / 1024),
        size_pretty: t.size_pretty,
      }));
    } catch {}

    res.json(info);
  } catch (err) {
    next(err);
  }
});

function humanUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}g ${h}s ${m}dk`;
  if (h > 0) return `${h}s ${m}dk`;
  return `${m}dk`;
}

// GET /admin/system/sentry-summary — Sentry API (env token varsa)
// Env: SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT
router.get('/system/sentry-summary', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const token = process.env.SENTRY_AUTH_TOKEN;
    const org = process.env.SENTRY_ORG;
    const project = process.env.SENTRY_PROJECT;
    if (!token || !org || !project) {
      return res.json({
        configured: false,
        message: 'Sentry entegre değil. Railway env: SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT ekle.',
      });
    }

    const axios = require('axios');
    // Son 24 saatte açılan issue'lar — en son 20 tanesi
    const url = `https://sentry.io/api/0/projects/${org}/${project}/issues/?statsPeriod=24h&limit=20&query=is:unresolved`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    const issues = r.data || [];
    // Toplam event sayısı
    const totalEvents = issues.reduce((sum, it) => sum + (parseInt(it.count, 10) || 0), 0);
    const summary = issues.slice(0, 10).map((it) => ({
      id: it.id,
      title: it.title,
      culprit: it.culprit,
      level: it.level,
      count: parseInt(it.count, 10) || 0,
      users_affected: it.userCount || 0,
      last_seen: it.lastSeen,
      permalink: it.permalink,
    }));

    res.json({
      configured: true,
      issues_24h: issues.length,
      total_events_24h: totalEvents,
      top_issues: summary,
    });
  } catch (err) {
    console.error('[admin] sentry summary fail:', err.message);
    res.json({
      configured: true,
      error: err.response?.status
        ? `Sentry API hata: ${err.response.status}`
        : 'Sentry API\'ye ulaşılamadı: ' + err.message,
    });
  }
});

// GET /admin/system/r2-stats — Cloudflare R2 storage durumu (DB-based, hızlı)
router.get('/system/r2-stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const config = require('../config');
    const storage = require('../services/storage');

    const publicUrl = config.s3.publicUrl || null;
    const bucket = config.s3.bucket || null;
    const endpoint = config.s3.endpoint || null;
    const region = config.s3.region || null;
    const ready = storage.isReady();

    // DB'den foto istatistikleri
    // Not: cdn.abadan.com.tr yerine mevcut publicUrl prefix'i kullanılır (esneklik için)
    const prefix = publicUrl || 'https://';
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                           AS total_photos,
         COUNT(*) FILTER (WHERE url LIKE $1 || '%')::int                         AS r2_full_photos,
         COUNT(*) FILTER (WHERE thumb_url LIKE $1 || '%')::int                   AS r2_thumb_photos,
         COUNT(*) FILTER (WHERE url LIKE 'data:image/%')::int                    AS legacy_base64,
         COUNT(DISTINCT listing_id)::int                                         AS listings_with_photos
       FROM listing_photos`,
      [prefix]
    );
    const stats = r.rows[0];

    // Son 24 saat listing_photos inseeeer sayısı (upload proxy metric)
    const r24 = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM listings WHERE created_at >= now() - interval '24 hours') AS listings_24h,
         (SELECT COUNT(*)::int FROM listings WHERE created_at >= now() - interval '7 days')   AS listings_7d`
    );

    res.json({
      configured: ready,
      bucket,
      endpoint,
      region,
      public_url: publicUrl,
      total_photos: stats.total_photos,
      r2_full_photos: stats.r2_full_photos,
      r2_thumb_photos: stats.r2_thumb_photos,
      legacy_base64: stats.legacy_base64,
      listings_with_photos: stats.listings_with_photos,
      listings_last_24h: r24.rows[0].listings_24h,
      listings_last_7d: r24.rows[0].listings_7d,
      note: 'DB-based stats. Gerçek R2 storage için Cloudflare Dashboard veya API token eklenirse Analytics gösterilir.',
    });
  } catch (err) {
    console.error('[admin] r2-stats fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// GHOST APPROVALS — Hayalet ilan onay kuyruğu
// ═══════════════════════════════════════════════════════════════════

// GET /admin/ghost-approvals?status=pending|approved|rejected|all — hayalet ilanlar
// Default pending (aksiyon gerektiren). Panel'den filtre chip'i ile diğer durumlar sorgulanır.
// Sayaç her durum için ayrı döner → panel'de "Onay bekleyen: X | Aktif: Y | Reddedilen: Z" gösterilebilir.
router.get('/ghost-approvals', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = (req.query.status || 'pending').toString();
    const allowed = new Set(['pending', 'approved', 'rejected', 'all']);
    if (!allowed.has(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    let statusFilter = '';
    if (status === 'pending') statusFilter = "AND l.ghost_approval_status = 'pending'";
    else if (status === 'approved') statusFilter = "AND l.ghost_approval_status = 'approved'";
    else if (status === 'rejected') statusFilter = "AND l.ghost_approval_status = 'rejected'";
    // 'all' → filter yok, tüm hayalet ilanlar

    const { rows } = await pool.query(
      `SELECT
         l.id, l.title, l.description, l.price, l.currency,
         l.location_city, l.created_at,
         l.user_id,
         l.ghost_approval_status,
         l.ghost_approval_reason,
         l.ghost_approval_at,
         u.display_name AS user_name,
         u.avatar_url AS user_avatar,
         (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
         (SELECT COUNT(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
         c.name AS category_name
       FROM listings l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.ghost_mode = true
         AND l.status = 'active'
         AND l.admin_removed_at IS NULL
         ${statusFilter}
       ORDER BY
         CASE l.ghost_approval_status
           WHEN 'pending' THEN 1
           WHEN 'approved' THEN 2
           WHEN 'rejected' THEN 3
         END,
         l.created_at DESC`
    );

    // Her durum için sayaç — panel filtre chip'leri güncel gösterir
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ghost_approval_status = 'pending')::int  AS pending,
         COUNT(*) FILTER (WHERE ghost_approval_status = 'approved')::int AS approved,
         COUNT(*) FILTER (WHERE ghost_approval_status = 'rejected')::int AS rejected,
         COUNT(*)::int                                                    AS all
       FROM listings
       WHERE ghost_mode = true AND status = 'active' AND admin_removed_at IS NULL`
    );

    res.json({
      ghost_approvals: rows,
      count: rows.length,
      status,
      counts: counts.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ghost-users — user-level hayalet moddaki kullanıcıların listesi
// İlan sayısı, kayıt tarihi, son aktivite ile birlikte. Sadece bilgilendirme, aksiyon yok.
router.get('/ghost-users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.display_name, u.avatar_url, u.location_city, u.created_at,
         u.gender, u.status,
         (SELECT COUNT(*)::int FROM listings l
          WHERE l.user_id = u.id AND l.status = 'active' AND l.admin_removed_at IS NULL) AS active_listings,
         (SELECT COUNT(*)::int FROM listings l
          WHERE l.user_id = u.id AND l.status = 'sold') AS sold_listings,
         (SELECT MAX(l.created_at) FROM listings l WHERE l.user_id = u.id) AS last_listing_at
       FROM users u
       WHERE u.ghost_mode = true
         AND u.status = 'active'
       ORDER BY last_listing_at DESC NULLS LAST, u.created_at DESC`
    );
    res.json({ ghost_users: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /admin/ghost-approvals/:id/approve
router.post('/ghost-approvals/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const l = await pool.query(
      `SELECT id, user_id, title, ghost_approval_status
       FROM listings WHERE id = $1`,
      [req.params.id]
    );
    if (l.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    if (l.rows[0].ghost_approval_status !== 'pending') {
      return res.status(400).json({ error: 'not_pending', message: 'İlan zaten karar verilmiş.' });
    }
    await pool.query(
      `UPDATE listings SET
         ghost_approval_status = 'approved',
         ghost_approved_by = $2,
         ghost_approval_at = now(),
         ghost_approval_reason = NULL
       WHERE id = $1`,
      [req.params.id, req.userId]
    );

    // Audit log
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'ghost_approve', 'listing', $2, NULL)`,
      [req.userId, req.params.id]
    ).catch(() => {});

    // Kullanıcıya push + in-app bildirim
    (async () => {
      try {
        const { sendToUser } = require('../services/push');
        await sendToUser(l.rows[0].user_id, {
          title: '👻 Hayalet Onaylandı',
          body: `"${l.rows[0].title}" ilanın onaylandı ve hayalet olarak yayınlandı.`,
          data: {
            type: 'ghost_approved',
            listing_id: req.params.id,
          },
        });
      } catch (e) {
        console.warn('[ghost-approve] push fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/ghost-approvals/:id/reject
// Body: { reason: string }
router.post('/ghost-approvals/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').toString().trim();
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'invalid_reason', message: 'Sebep 3-500 karakter olmalı.' });
    }
    const l = await pool.query(
      `SELECT id, user_id, title, ghost_approval_status
       FROM listings WHERE id = $1`,
      [req.params.id]
    );
    if (l.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    if (l.rows[0].ghost_approval_status !== 'pending') {
      return res.status(400).json({ error: 'not_pending' });
    }

    // Reddet: ilan HAYALET olarak da NORMAL olarak da yayına GİRMEZ.
    // ghost_mode = true kalır, ghost_approval_status = 'rejected'.
    // Feed filtresi bunu görmez. Kullanıcı MyListings'te "Reddedildi" görür,
    // düzenleyip yeniden gönderirse PATCH otomatik pending yapar.
    await pool.query(
      `UPDATE listings SET
         ghost_approval_status = 'rejected',
         ghost_approved_by = $2,
         ghost_approval_at = now(),
         ghost_approval_reason = $3
       WHERE id = $1`,
      [req.params.id, req.userId, reason]
    );

    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'ghost_reject', 'listing', $2, $3)`,
      [req.userId, req.params.id, reason]
    ).catch(() => {});

    // Kullanıcıya bildirim — düzelt ve tekrar gönder
    (async () => {
      try {
        const { sendToUser } = require('../services/push');
        await sendToUser(l.rows[0].user_id, {
          title: '👻 Hayalet İlanın Reddedildi',
          body: `"${l.rows[0].title}" onaylanmadı: ${reason.slice(0, 100)}\n\nDüzenleyip tekrar gönderebilirsin. İlanın hâlâ yayına girmedi.`,
          data: {
            type: 'ghost_rejected',
            listing_id: req.params.id,
            reason,
          },
        });
      } catch (e) {
        console.warn('[ghost-reject] push fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/create-demo-user — hızlı test için demo hesap yaratır/günceller.
// Body: { phone: "0 500 111 22 33", pin: "4964", name: "Demo" }
// Idempotent — telefon zaten kayıtlıysa PIN + isim güncellenir.
router.post('/create-demo-user', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { phone, pin, name } = req.body || {};
    if (!phone || !pin || !name) {
      return res.status(400).json({ error: 'missing_fields', message: 'phone, pin, name gerekli' });
    }
    if (String(pin).length < 4) {
      return res.status(400).json({ error: 'weak_pin', message: 'PIN en az 4 haneli olmalı' });
    }

    const { normalizePhone } = require('../utils/phone');
    const crypto = require('crypto');
    const bcrypt = require('bcrypt');

    const e164 = normalizePhone(String(phone));
    if (!e164) {
      return res.status(400).json({ error: 'invalid_phone', message: 'Türk cep formatına uygun olmalı (05XX ile başlamalı)' });
    }

    const pepper = process.env.PHONE_HASH_PEPPER;
    if (!pepper) {
      return res.status(500).json({ error: 'no_pepper', message: 'PHONE_HASH_PEPPER env eksik' });
    }

    const clientSha = crypto.createHash('sha256').update(e164).digest('hex');
    const phoneHash = crypto.createHmac('sha256', pepper).update(clientSha).digest('hex');
    const pinHash = await bcrypt.hash(String(pin), 10);

    const existing = await pool.query('SELECT id FROM users WHERE phone_hash = $1', [phoneHash]);
    let userId;
    let action;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      action = 'updated';
      await pool.query(
        `UPDATE users
           SET pin_hash = $1, display_name = $2, status = 'active',
               onboarded_at = COALESCE(onboarded_at, now())
         WHERE id = $3`,
        [pinHash, String(name), userId]
      );
    } else {
      action = 'created';
      const r = await pool.query(
        `INSERT INTO users (phone_hash, display_name, pin_hash, status, onboarded_at, role)
         VALUES ($1, $2, $3, 'active', now(), 'user') RETURNING id`,
        [phoneHash, String(name), pinHash]
      );
      userId = r.rows[0].id;
    }

    console.log(`[admin] demo user ${action}: ${e164} → user_id=${userId}`);
    res.json({
      ok: true,
      action,
      user_id: userId,
      phone: e164,
      display_name: name,
      pin_length: String(pin).length,
      note: 'Kullanıcı hazır — telefon + PIN ile mobile\'dan giriş yapabilir.',
    });
  } catch (err) {
    console.error('[admin] create-demo-user fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// STORES — Mağaza onay kuyruğu
// ═══════════════════════════════════════════════════════════════════

// GET /admin/stores?status=pending|approved|rejected|unverified|deleted|all
router.get('/stores', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = (req.query.status || 'pending').toString();
    let where = '';
    // 'deleted' hariç tüm filtreler aktif mağazaları gösterir (deleted_at IS NULL)
    if (status === 'pending')     where = 'WHERE deleted_at IS NULL AND is_email_verified = true AND is_admin_approved = false AND admin_rejection_reason IS NULL';
    else if (status === 'approved')   where = 'WHERE deleted_at IS NULL AND is_admin_approved = true';
    else if (status === 'rejected')   where = 'WHERE deleted_at IS NULL AND admin_rejection_reason IS NOT NULL';
    else if (status === 'unverified') where = 'WHERE deleted_at IS NULL AND is_email_verified = false';
    else if (status === 'deleted')    where = 'WHERE deleted_at IS NOT NULL';
    else if (status === 'all')        where = 'WHERE deleted_at IS NULL';
    // Not: 'all' de artık deleted olanları hariç tutar. Silinmiş için ayrı chip.

    const { rows } = await pool.query(
      `SELECT id, email, name, phone, location_city,
              is_email_verified, is_admin_approved, admin_rejection_reason,
              verification_sent_at, approved_at, created_at, deleted_at,
              (CASE WHEN deleted_at IS NOT NULL
                    THEN GREATEST(0, EXTRACT(DAY FROM (deleted_at + interval '30 days' - now()))::int)
                    ELSE NULL
               END) AS days_until_purge
       FROM stores
       ${where}
       ORDER BY ${status === 'deleted' ? 'deleted_at DESC' : 'created_at DESC'}
       LIMIT 200`
    );

    // Count'lar deleted_at IS NULL için
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_email_verified = true AND is_admin_approved = false AND admin_rejection_reason IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_admin_approved = true)::int AS approved,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND admin_rejection_reason IS NOT NULL)::int AS rejected,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_email_verified = false)::int AS unverified,
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
         COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS all
       FROM stores`
    );

    res.json({ stores: rows, count: rows.length, status, counts: counts.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /admin/stores/:id/approve
router.post('/stores/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE stores
       SET is_admin_approved = true, approved_at = now(), approved_by = $2,
           admin_rejection_reason = NULL, updated_at = now()
       WHERE id = $1
       RETURNING email, name`,
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    // Audit
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_approve', 'store', $2, NULL)`,
      [req.userId, req.params.id]
    ).catch(() => {});

    // Onay maili
    (async () => {
      try {
        const email = require('../services/email');
        const STORE_FRONTEND_URL = process.env.STORE_FRONTEND_URL || 'https://magaza.abadan.com.tr';
        await email.sendStoreApproved(r.rows[0].email, r.rows[0].name, STORE_FRONTEND_URL);
      } catch (e) {
        console.warn('[store-approve] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/stores/:id/reject
// Body: { reason: string }
router.post('/stores/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').toString().trim();
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'reason_required' });
    }
    const r = await pool.query(
      `UPDATE stores
       SET is_admin_approved = false, admin_rejection_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING email, name`,
      [req.params.id, reason]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_reject', 'store', $2, $3)`,
      [req.userId, req.params.id, reason]
    ).catch(() => {});

    (async () => {
      try {
        const email = require('../services/email');
        await email.sendStoreRejected(r.rows[0].email, r.rows[0].name, reason);
      } catch (e) {
        console.warn('[store-reject] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// EMAIL DEĞİŞİM İSTEKLERİ — mağazalar yeni email talep eder, admin onaylar
// ═══════════════════════════════════════════════════════════════

// GET /admin/stores/email-changes — bekleyen email değişim istekleri
router.get('/stores/email-changes', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email AS current_email, pending_email, name,
              pending_email_requested_at, is_admin_approved
       FROM stores
       WHERE pending_email IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY pending_email_requested_at ASC`
    );
    res.json({ requests: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /admin/stores/:id/approve-email-change
router.post('/stores/:id/approve-email-change', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const store = await pool.query(
      'SELECT email, pending_email, name FROM stores WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (store.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const s = store.rows[0];
    if (!s.pending_email) return res.status(400).json({ error: 'no_pending_change' });

    // Email başka aktif hesapta olmamalı (tekrar kontrol — request'ten bu yana değişebilir)
    const dup = await pool.query(
      `SELECT id FROM stores
       WHERE LOWER(email) = LOWER($1) AND id <> $2 AND deleted_at IS NULL`,
      [s.pending_email, req.params.id]
    );
    if (dup.rows.length > 0) {
      // Pending'i temizle, mağazaya bildir
      await pool.query(
        'UPDATE stores SET pending_email = NULL, pending_email_requested_at = NULL WHERE id = $1',
        [req.params.id]
      );
      return res.status(409).json({ error: 'email_now_taken', message: 'Bu email başka bir mağazaya ait, istek iptal edildi.' });
    }

    const oldEmail = s.email;
    // Email değiştir + verified true (admin onayladı), pending temizle
    await pool.query(
      `UPDATE stores
       SET email = pending_email,
           pending_email = NULL,
           pending_email_requested_at = NULL,
           is_email_verified = true,
           updated_at = now()
       WHERE id = $1`,
      [req.params.id]
    );

    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_email_change_approved', 'store', $2, $3)`,
      [req.userId, req.params.id, `${oldEmail} → ${s.pending_email}`]
    ).catch(() => {});

    // Bildirim mailleri (async)
    (async () => {
      try {
        const email = require('../services/email');
        // Yeni adrese bildirim
        await email.sendEmail({
          to: s.pending_email,
          subject: '[Abadan] E-posta değişikliği onaylandı',
          html: `<p>Merhaba ${s.name},</p>
            <p>Abadan Mağaza hesabınızın e-posta adresi başarıyla <b>${s.pending_email}</b> olarak güncellendi.</p>
            <p>Artık bu adres ile giriş yapabilirsiniz.</p>
            <p>—<br />Abadan</p>`,
          text: `Merhaba ${s.name},\n\nE-posta adresiniz ${s.pending_email} olarak güncellendi. Artık bu adres ile giriş yapabilirsiniz.\n\n—\nAbadan`,
        });
        // Eski adrese güvenlik uyarısı
        await email.sendEmail({
          to: oldEmail,
          subject: '[Abadan] Hesabınızın e-posta adresi değişti',
          html: `<p>Merhaba ${s.name},</p>
            <p>Abadan Mağaza hesabınızın e-posta adresi <b>${s.pending_email}</b> olarak değiştirildi.</p>
            <p>Bu değişikliği <b>siz yapmadıysanız</b> derhal <a href="mailto:destek@abadan.com.tr">destek@abadan.com.tr</a> ile iletişime geçin.</p>
            <p>—<br />Abadan</p>`,
          text: `Merhaba ${s.name},\n\nHesabınızın e-posta adresi ${s.pending_email} olarak değiştirildi.\nSiz yapmadıysanız destek@abadan.com.tr ile iletişime geçin.\n\n—\nAbadan`,
        });
      } catch (e) {
        console.warn('[email-change-approve] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    console.error('[email-change-approve] fail:', err.message);
    next(err);
  }
});

// POST /admin/stores/:id/reject-email-change
router.post('/stores/:id/reject-email-change', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').toString().trim();
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'reason_required' });
    }
    const store = await pool.query(
      'SELECT email, pending_email, name FROM stores WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (store.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const s = store.rows[0];
    if (!s.pending_email) return res.status(400).json({ error: 'no_pending_change' });

    const rejectedEmail = s.pending_email;
    await pool.query(
      `UPDATE stores SET pending_email = NULL, pending_email_requested_at = NULL, updated_at = now()
       WHERE id = $1`,
      [req.params.id]
    );

    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_email_change_rejected', 'store', $2, $3)`,
      [req.userId, req.params.id, `${rejectedEmail}: ${reason}`]
    ).catch(() => {});

    // Mevcut email'e bildirim
    (async () => {
      try {
        const email = require('../services/email');
        await email.sendEmail({
          to: s.email,
          subject: '[Abadan] E-posta değişim isteğiniz onaylanmadı',
          html: `<p>Merhaba ${s.name},</p>
            <p>Yeni e-posta adresi olarak <b>${rejectedEmail}</b> istediğiniz değişiklik onaylanmadı.</p>
            <p><b>Sebep:</b> ${reason}</p>
            <p>Sorularınız için: <a href="mailto:destek@abadan.com.tr">destek@abadan.com.tr</a></p>
            <p>—<br />Abadan</p>`,
          text: `Merhaba ${s.name},\n\n"${rejectedEmail}" e-posta değişim isteğiniz onaylanmadı.\nSebep: ${reason}\n\nSorular: destek@abadan.com.tr\n\n—\nAbadan`,
        });
      } catch (e) {
        console.warn('[email-change-reject] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    console.error('[email-change-reject] fail:', err.message);
    next(err);
  }
});

// DELETE /admin/stores/:id — mağaza soft delete (30 gün retention)
router.delete('/stores/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE stores SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_soft_delete', 'store', $2, NULL)`,
      [req.userId, req.params.id]
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/stores/:id/restore — soft-deleted mağazayı geri al
router.post('/stores/:id/restore', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      'UPDATE stores SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id',
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found_or_not_deleted' });
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_restore', 'store', $2, NULL)`,
      [req.userId, req.params.id]
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/stores/:id/purge — 30 gün beklemeden HARD delete (R2 fotoları da temizler)
router.delete('/stores/:id/purge', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'reason_required', message: 'Kalıcı silme için sebep zorunlu (min 5 karakter).' });
    }

    // R2 foto cleanup
    const storage = require('../services/storage');
    const photos = await pool.query(
      `SELECT p.url FROM store_listing_photos p
       JOIN store_listings l ON l.id = p.listing_id
       WHERE l.store_id = $1
       UNION ALL
       SELECT logo_url FROM stores WHERE id = $1 AND logo_url IS NOT NULL
       UNION ALL
       SELECT cover_url FROM stores WHERE id = $1 AND cover_url IS NOT NULL`,
      [req.params.id]
    );
    if (photos.rows.length > 0 && storage.cleanupPhotoUrls) {
      const urls = photos.rows.map((r) => r.url).filter(Boolean);
      if (urls.length > 0) {
        await storage.cleanupPhotoUrls(urls, `store ${req.params.id} purge`).catch((e) =>
          console.warn('[store-purge] R2 fail:', e.message)
        );
      }
    }

    await pool.query('DELETE FROM stores WHERE id = $1', [req.params.id]);
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_hard_delete', 'store', $2, $3)`,
      [req.userId, req.params.id, reason.trim()]
    ).catch(() => {});
    console.log(`[admin-purge] HARD DELETE store=${req.params.id} by admin=${req.userId} reason="${reason.trim()}"`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-purge] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// MAĞAZA İLAN ONAY KUYRUĞU
// ═══════════════════════════════════════════════════════════════════

// GET /admin/store-listings?status=pending|active|rejected|all&category=<id>
router.get('/store-listings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = (req.query.status || 'pending').toString();
    const allowed = new Set(['pending', 'active', 'rejected', 'all']);
    if (!allowed.has(status)) return res.status(400).json({ error: 'invalid_status' });

    const categoryId = req.query.category ? parseInt(String(req.query.category), 10) : null;
    const conds = [];
    const params = [];

    if (status === 'pending')       conds.push("l.status = 'pending' AND l.admin_removed_at IS NULL");
    else if (status === 'active')   conds.push("l.status = 'active' AND l.admin_removed_at IS NULL");
    else if (status === 'rejected') conds.push('l.admin_removed_at IS NOT NULL');
    // 'all' → koşul yok

    if (categoryId) {
      params.push(categoryId);
      conds.push(`l.category_id IN (
        WITH RECURSIVE sub AS (
          SELECT id FROM categories WHERE id = $${params.length}
          UNION ALL
          SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
        ) SELECT id FROM sub
      )`);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT l.id, l.title, l.description, l.price, l.currency, l.is_negotiable,
              l.location_city, l.status, l.attributes, l.created_at,
              l.admin_removed_at, l.admin_removal_reason,
              l.store_id,
              s.name AS store_name, s.email AS store_email, s.logo_url AS store_logo,
              cat.name AS category_name,
              (SELECT COALESCE(p.thumb_url, p.url) FROM store_listing_photos p
               WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM store_listing_photos p WHERE p.listing_id = l.id) AS photo_count
       FROM store_listings l
       JOIN stores s ON s.id = l.store_id
       LEFT JOIN categories cat ON cat.id = l.category_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT 200`,
      params
    );

    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending' AND admin_removed_at IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE status = 'active' AND admin_removed_at IS NULL)::int  AS active,
         COUNT(*) FILTER (WHERE admin_removed_at IS NOT NULL)::int                    AS rejected,
         COUNT(*)::int                                                                 AS all
       FROM store_listings`
    );

    res.json({ listings: rows, count: rows.length, status, counts: counts.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /admin/store-listings/:id/approve
router.post('/store-listings/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE store_listings
       SET status = 'active', admin_removed_at = NULL, admin_removal_reason = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, title, store_id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    // Audit log
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_listing_approve', 'store_listing', $2, NULL)`,
      [req.userId, req.params.id]
    ).catch(() => {});

    // Mağazaya email
    (async () => {
      try {
        const emailSvc = require('../services/email');
        const storeInfo = await pool.query('SELECT email, name FROM stores WHERE id = $1', [r.rows[0].store_id]);
        if (storeInfo.rows[0]) {
          await emailSvc.sendEmail({
            to: storeInfo.rows[0].email,
            subject: '[Abadan] İlanınız onaylandı',
            html: `<p>Merhaba ${storeInfo.rows[0].name},</p>
              <p>"<b>${r.rows[0].title}</b>" ilanınız onaylandı ve yayına alındı.</p>
              <p>—<br />Abadan</p>`,
            text: `Merhaba ${storeInfo.rows[0].name},\n\n"${r.rows[0].title}" ilanınız onaylandı ve yayına alındı.\n\n—\nAbadan`,
          });
        }
      } catch (e) {
        console.warn('[store-listing-approve] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    console.error('[store-listing-approve] fail:', err.message);
    next(err);
  }
});

// POST /admin/store-listings/:id/reject
// Body: { reason }
router.post('/store-listings/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').toString().trim();
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'reason_required' });
    }

    const r = await pool.query(
      `UPDATE store_listings
       SET admin_removed_at = now(), admin_removal_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, title, store_id`,
      [req.params.id, reason]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
       VALUES ($1, 'store_listing_reject', 'store_listing', $2, $3)`,
      [req.userId, req.params.id, reason]
    ).catch(() => {});

    // Mağazaya email
    (async () => {
      try {
        const emailSvc = require('../services/email');
        const storeInfo = await pool.query('SELECT email, name FROM stores WHERE id = $1', [r.rows[0].store_id]);
        if (storeInfo.rows[0]) {
          await emailSvc.sendEmail({
            to: storeInfo.rows[0].email,
            subject: '[Abadan] İlanınız onaylanmadı',
            html: `<p>Merhaba ${storeInfo.rows[0].name},</p>
              <p>"<b>${r.rows[0].title}</b>" ilanınız onaylanmadı.</p>
              <p><b>Sebep:</b> ${reason}</p>
              <p>Düzenleyip yeniden gönderebilirsiniz.</p>
              <p>—<br />Abadan</p>`,
            text: `Merhaba ${storeInfo.rows[0].name},\n\n"${r.rows[0].title}" ilanınız onaylanmadı.\nSebep: ${reason}\n\n—\nAbadan`,
          });
        }
      } catch (e) {
        console.warn('[store-listing-reject] mail fail:', e.message);
      }
    })();

    res.json({ ok: true });
  } catch (err) {
    console.error('[store-listing-reject] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// GROWTH — Share leaderboard
// ═══════════════════════════════════════════════════════════════════

// GET /admin/growth/top-referrers?limit=20
// En çok kayıt getiren kullanıcılar (share → signup dönüşümü)
router.get('/growth/top-referrers', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const r = await pool.query(
      `SELECT
         u.id, u.display_name, u.avatar_url, u.last_active_at,
         COUNT(s.id)::int AS shares_created,
         COALESCE(SUM(s.view_count), 0)::int   AS total_views,
         COALESCE(SUM(s.signup_count), 0)::int AS total_signups,
         COALESCE(SUM(s.conversation_count), 0)::int AS total_conversations
       FROM users u
       JOIN listing_shares s ON s.user_id = u.id
       GROUP BY u.id
       HAVING SUM(s.view_count) > 0 OR SUM(s.signup_count) > 0
       ORDER BY total_signups DESC, total_views DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ referrers: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/growth/overview — dashboard için özet
router.get('/growth/overview', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM listing_shares) AS total_links,
         (SELECT COALESCE(SUM(view_count), 0)::int FROM listing_shares)   AS total_views,
         (SELECT COALESCE(SUM(signup_count), 0)::int FROM listing_shares) AS total_signups,
         (SELECT COUNT(*)::int FROM users WHERE referred_by_share_id IS NOT NULL) AS referred_users,
         (SELECT COUNT(*)::int FROM listing_shares WHERE created_at > now() - interval '24 hours') AS links_24h,
         (SELECT COALESCE(SUM(view_count), 0)::int FROM listing_shares WHERE last_viewed_at > now() - interval '24 hours') AS views_24h`
    );
    res.json(r.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// OPERASYON — Bakım modu, Feature flags, Admin yönetimi, Kampanya
// ═══════════════════════════════════════════════════════════════════

const settingsSvc = require('../services/settings');

// GET /admin/settings — tüm anahtarlar
router.get('/settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await settingsSvc.all();
    res.json({ settings: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/settings/:key — key/value güncelle (upsert)
const settingUpdateSchema = Joi.object({
  value: Joi.any().required(),
  description: Joi.string().max(300).allow('').optional(),
});

router.put('/settings/:key', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = settingUpdateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    await settingsSvc.set(req.params.key, value.value, req.userId, value.description);

    // Audit log
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, NULL, 'setting_change', $2, $3)`,
      [
        req.userId,
        'Ayar güncellendi: ' + req.params.key,
        JSON.stringify({ key: req.params.key, new_value: value.value }),
      ]
    ).catch(() => {});

    console.log(`[admin] setting_change key=${req.params.key} by=${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Admin listesi + ekle/çıkar
// GET /admin/admins
router.get('/admins', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, display_name, avatar_url, last_active_at, created_at
       FROM users WHERE role = 'admin' ORDER BY display_name`
    );
    res.json({ admins: r.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/admins — kullanıcıyı admin yap
const adminGrantSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  reason: Joi.string().min(3).max(500).required(),
});

router.post('/admins', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = adminGrantSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const r = await pool.query(
      `UPDATE users SET role = 'admin' WHERE id = $1 AND role != 'admin'
       RETURNING id, display_name`,
      [value.userId]
    );
    if (r.rowCount === 0) {
      return res.status(400).json({ error: 'already_admin_or_not_found', message: 'Zaten admin veya kullanıcı yok.' });
    }

    invalidateAdminCache(value.userId);
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason)
       VALUES ($1, $2, 'grant_admin', $3)`,
      [req.userId, value.userId, value.reason]
    );

    console.log(`[admin] grant_admin user=${value.userId} by=${req.userId}`);
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/admins/:id — admin yetkisini geri al
router.delete('/admins/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'cannot_revoke_self', message: 'Kendini admin\'likten çıkaramazsın.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'reason_required' });

    const r = await pool.query(
      `UPDATE users SET role = 'user' WHERE id = $1 AND role = 'admin'
       RETURNING id, display_name`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_admin' });

    invalidateAdminCache(req.params.id);
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason)
       VALUES ($1, $2, 'revoke_admin', $3)`,
      [req.userId, req.params.id, reason]
    );

    console.log(`[admin] revoke_admin user=${req.params.id} by=${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Kampanya broadcast — audience ile tüm kullanıcılara veya alt kümeye
// audience: 'all' | 'active_7d' | 'active_30d' | 'no_contacts' | 'low_contacts'
const campaignSchema = Joi.object({
  audience: Joi.string().valid('all', 'active_7d', 'active_30d', 'no_contacts', 'low_contacts').required(),
  title: Joi.string().min(1).max(120).required(),
  body: Joi.string().min(1).max(500).required(),
});

router.post('/broadcast/campaign', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { value, error } = campaignSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Audience'a göre user_id listesi
    let query;
    if (value.audience === 'all') {
      query = `SELECT id FROM users WHERE status = 'active'`;
    } else if (value.audience === 'active_7d') {
      query = `SELECT id FROM users WHERE status = 'active' AND last_active_at > now() - interval '7 days'`;
    } else if (value.audience === 'active_30d') {
      query = `SELECT id FROM users WHERE status = 'active' AND last_active_at > now() - interval '30 days'`;
    } else if (value.audience === 'no_contacts') {
      query = `SELECT u.id FROM users u WHERE u.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.user_id = u.id)`;
    } else if (value.audience === 'low_contacts') {
      query = `SELECT user_id AS id FROM user_contacts GROUP BY user_id HAVING COUNT(*) BETWEEN 1 AND 4`;
    }
    const r = await pool.query(query);
    const userIds = r.rows.map((row) => row.id);

    if (userIds.length === 0) {
      return res.json({ ok: true, sent: 0, message: 'Bu segmentte kullanıcı yok.' });
    }

    // In-app bildirim toplu insert — 500'lük parçalar
    const now = new Date();
    const BATCH = 500;
    let total = 0;
    for (let i = 0; i < userIds.length; i += BATCH) {
      const slice = userIds.slice(i, i + BATCH);
      const rows = [];
      const params = [];
      slice.forEach((uid, idx) => {
        rows.push(`($${idx * 3 + 1}, 'admin_broadcast', $${idx * 3 + 2}::jsonb, $${idx * 3 + 3})`);
        params.push(uid, JSON.stringify({ title: value.title, body: value.body, sender: 'admin', campaign: true }), now);
      });
      const result = await pool.query(
        `INSERT INTO notifications (user_id, type, payload, created_at)
         VALUES ${rows.join(',')} RETURNING id`,
        params
      );
      total += result.rowCount;
    }

    // Audit
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, metadata)
       VALUES ($1, NULL, 'broadcast', $2, $3)`,
      [
        req.userId,
        value.title + ' — ' + value.body,
        JSON.stringify({ campaign: true, audience: value.audience, recipient_count: userIds.length }),
      ]
    ).catch(() => {});

    // Push — arka planda
    (async () => {
      const { sendToUser } = require('../services/push');
      for (const uid of userIds) {
        try {
          await sendToUser(uid, {
            title: value.title,
            body: value.body,
            data: { type: 'admin_broadcast' },
          });
        } catch (err) {
          console.error(`[campaign] push fail for ${uid}:`, err.message);
        }
      }
      console.log(`[campaign] push done for ${userIds.length} users audience=${value.audience}`);
    })();

    console.log(`[admin] campaign audience=${value.audience} sent=${total} by=${req.userId}`);
    res.json({ ok: true, sent: total, audience: value.audience });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// KATEGORİLER — Admin görünümü (user + store listing sayıları)
// ═══════════════════════════════════════════════════════════════
// GET /admin/categories/stats
// Kategori ağacı + her düğüm için:
//   - user_count:  o kategori altındaki (recursive) aktif user listing sayısı
//   - store_count: o kategori altındaki (recursive) aktif store listing sayısı
router.get('/categories/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows: cats } = await pool.query(
      `SELECT id, parent_id, name, slug, icon, ordering
       FROM categories
       ORDER BY parent_id NULLS FIRST, ordering, name`
    );

    // Doğrudan (kendi) sayılar — user listings (aktif + removed değil)
    const { rows: userDirect } = await pool.query(
      `SELECT category_id, COUNT(*)::int AS n
       FROM listings
       WHERE status = 'active' AND admin_removed_at IS NULL AND category_id IS NOT NULL
       GROUP BY category_id`
    );
    const userMap = new Map(userDirect.map((r) => [r.category_id, r.n]));

    // Doğrudan sayılar — store listings (onaylı mağaza + aktif)
    const { rows: storeDirect } = await pool.query(
      `SELECT l.category_id, COUNT(*)::int AS n
       FROM store_listings l
       JOIN stores s ON s.id = l.store_id
       WHERE l.status = 'active'
         AND l.admin_removed_at IS NULL
         AND s.is_admin_approved = true
         AND s.deleted_at IS NULL
         AND l.category_id IS NOT NULL
       GROUP BY l.category_id`
    );
    const storeMap = new Map(storeDirect.map((r) => [r.category_id, r.n]));

    // Ağaç kur
    const byId = new Map();
    const roots = [];
    cats.forEach((c) => byId.set(c.id, {
      ...c,
      children: [],
      user_count: userMap.get(c.id) || 0,
      store_count: storeMap.get(c.id) || 0,
    }));
    cats.forEach((c) => {
      const node = byId.get(c.id);
      if (c.parent_id) byId.get(c.parent_id)?.children.push(node);
      else roots.push(node);
    });

    // Recursive toplama (kendi + tüm alt kategoriler)
    function recur(node) {
      let u = node.user_count;
      let s = node.store_count;
      for (const ch of node.children) {
        const [cu, cs] = recur(ch);
        u += cu;
        s += cs;
      }
      node.user_count = u;
      node.store_count = s;
      return [u, s];
    }
    roots.forEach(recur);

    const totalUser = Array.from(userMap.values()).reduce((a, b) => a + b, 0);
    const totalStore = Array.from(storeMap.values()).reduce((a, b) => a + b, 0);

    res.json({ tree: roots, total_user: totalUser, total_store: totalStore });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
