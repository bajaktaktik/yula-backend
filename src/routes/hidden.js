// Gizlenen ilanlar - kullanicinin akistan kaldirdiklari.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// GET /hidden  →  kullanicinin gizledigi ilanlar
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const me = await pool.query('SELECT gender FROM users WHERE id = $1', [req.userId]);
    const myGender = me.rows[0]?.gender || null;
    const genderCond = (myGender === 'female' || myGender === 'male')
      ? `(l.restricted_to_gender IS NULL OR l.restricted_to_gender = '${myGender}' OR l.user_id = $1)`
      : `(l.restricted_to_gender IS NULL OR l.user_id = $1)`;

    const { rows } = await pool.query(
      `SELECT l.id, l.title, l.description, l.price, l.currency,
              l.location_city, l.location_district, l.created_at, l.user_id,
              l.status, l.is_negotiable,
              REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\\[DEMO\\] ', '') AS seller_name,
              u.avatar_url AS seller_avatar,
              (SELECT p.url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
              h.created_at AS hidden_at
       FROM hidden_listings h
       JOIN listings l ON l.id = h.listing_id
       JOIN users u ON u.id = l.user_id
       LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_phone_hash = u.phone_hash
       WHERE h.user_id = $1
         AND l.admin_removed_at IS NULL
         AND ${genderCond}
       ORDER BY h.created_at DESC`,
      [req.userId]
    );
    const result = rows.map((row) => ({
      ...row,
      photos: row.cover_photo ? [row.cover_photo] : [],
      photo_count: row.photo_count || 0,
    }));
    res.json({ hidden: result, count: result.length });
  } catch (err) {
    next(err);
  }
});

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
