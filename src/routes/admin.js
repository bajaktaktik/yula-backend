// Admin moderasyon paneli — Apple Guideline 1.2 24-saat moderasyon zorunluluğu.
// ADMIN_USER_IDS env var'ı virgülle ayrılmış user UUID listesi.
// Sadece bu kullanıcılar admin endpoint'lerini çağırabilir.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

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

// GET /admin/stats — özet
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

module.exports = router;
