// Bildirim endpoint'leri — şu anda price_change tipi, ileride başkaları eklenebilir.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// GET /notifications  →  kullanıcının tüm bildirimleri (en yeni üstte)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.listing_id, n.payload, n.read_at, n.created_at,
              l.title AS listing_title, l.price AS listing_price,
              (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS listing_cover,
              -- Cinsiyet talebi türündeyse, talep edenin adını (alıcının rehberindeki ad öncelikli) ekle
              CASE
                WHEN n.type = 'gender_change_request' THEN
                  (SELECT COALESCE(uc.contact_name, ru.display_name, 'Bir tanıdığın')
                   FROM users ru
                   LEFT JOIN user_contacts uc ON uc.user_id = n.user_id AND uc.contact_phone_hash = ru.phone_hash
                   WHERE ru.id = (n.payload->>'requester_id')::uuid)
                ELSE NULL
              END AS requester_name
       FROM notifications n
       LEFT JOIN listings l ON l.id = n.listing_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    const unread_count = rows.filter((r) => !r.read_at).length;
    res.json({ notifications: rows, count: rows.length, unread_count });
  } catch (err) {
    next(err);
  }
});

// POST /notifications/:id/read  →  bir bildirimi okundu işaretle
router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notifications SET read_at = now()
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /notifications/:id  →  bildirimi tamamen sil
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /notifications/read-all  →  tümünü okundu işaretle
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
