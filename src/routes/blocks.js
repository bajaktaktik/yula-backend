// Kullanıcı engelleme — Apple Guideline 1.2 User-Generated Content gereği.
// Engellenen kullanıcının ilanları + mesajları + sohbetleri anında görünmez olur
// (graph.js already-implemented blocks tablosunu okuyor; bu endpoint INSERT/DELETE yapar).

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

const blockSchema = Joi.object({
  blockedId: Joi.string().uuid().required(),
  reason: Joi.string().max(200).optional(),
});

// POST /blocks — kullanıcı engelle
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = blockSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    if (value.blockedId === req.userId) {
      return res.status(400).json({ error: 'cannot_block_self' });
    }

    // Kullanıcı var mı?
    const u = await pool.query('SELECT id FROM users WHERE id = $1', [value.blockedId]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'user_not_found' });

    await pool.query(
      `INSERT INTO blocks (blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [req.userId, value.blockedId, value.reason || null]
    );

    console.log(`[block] user=${req.userId} blocked=${value.blockedId}`);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /blocks/:id — engeli kaldır
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [req.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /blocks — engellediklerimi listele
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT b.blocked_id AS id, u.display_name, b.created_at, b.reason
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.userId]
    );
    res.json({ blocked: r.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
