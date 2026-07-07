// Admin moderasyon paneli — Apple Guideline 1.2 24-saat moderasyon zorunluluğu.
// ADMIN_USER_IDS env var'ı virgülle ayrılmış user UUID listesi.
// Sadece bu kullanıcılar admin endpoint'lerini çağırabilir.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth, invalidateUserStatusCache } = require('../auth/middleware');

const router = express.Router();

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function requireAdmin(req, res, next) {
  if (!ADMIN_USER_IDS.includes(req.userId)) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin yetkisi gerekli.' });
  }
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
        await pool.query('DELETE FROM listings WHERE id = $1', [report.target_id]);
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
         u.id, u.display_name, u.avatar_url, u.gender, u.location_city, u.status,
         u.created_at, u.last_active_at,
         (SELECT COUNT(*)::int FROM listings WHERE user_id = u.id AND status = 'active') AS active_listing_count,
         (SELECT COUNT(*)::int FROM reports  WHERE target_type = 'user' AND target_id = u.id) AS reports_against,
         (SELECT COUNT(*)::int FROM user_contacts WHERE user_id = u.id) AS contacts_count
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
         (SELECT COUNT(*)::int FROM blocks WHERE blocker_id = $1 OR blocked_id = $1)     AS blocks_count`,
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

module.exports = router;
