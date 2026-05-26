// Gizlenen ilanlar - kullanicinin akistan kaldirdiklari.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// POST /hidden/:listingId  →  ilani gizle
router.post('/:listingId', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO hidden_listings (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.userId, req.params.listingId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /hidden/:listingId  →  tekrar goster
router.delete('/:listingId', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM hidden_listings WHERE user_id = $1 AND listing_id = $2`,
      [req.userId, req.params.listingId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /hidden  →  tum gizlenenleri geri getir
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(`DELETE FROM hidden_listings WHERE user_id = $1`, [req.userId]);
    res.json({ ok: true, restored: r.rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
