// Kategori ağacı endpoint'i — her kategori için kullanıcıya görünen aktif ilan sayısı.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const graph = require('../services/graph');

const router = express.Router();

// GET /categories  →  { tree, flat } — her kategorinin "count" alanı var (kullanıcıya görünen ilan sayısı)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    // Kullanıcının görebileceği satıcılar
    // 1. + 2. derece — kategori sayaçları da tanıdıklarımın tanıdıklarını içersin
    const visible = await graph.getVisibleUserIds(req.userId);
    const secondMap = await graph.getSecondDegreeMap(req.userId);
    const allIds = new Set([...visible.keys(), ...secondMap.keys()]);
    const visibleIds = Array.from(allIds);

    // Cinsiyet filtresi
    const me = await pool.query('SELECT gender FROM users WHERE id = $1', [req.userId]);
    const myGender = me.rows[0]?.gender || null;
    const genderCond = (myGender === 'female' || myGender === 'male')
      ? `(l.restricted_to_gender IS NULL OR l.restricted_to_gender = '${myGender}')`
      : `(l.restricted_to_gender IS NULL)`;

    const freeOnly = req.query.freeOnly === '1' || req.query.freeOnly === 'true';

    // Kategori başına direkt ilan sayısı — listings + requests (Matlub istekleri)
    // Requests fiyatsız olduğu için free mode'da sayılmaz (kullanıcı zaten "ücretsiz ürün arıyorum" mantıksız)
    const directCount = new Map();
    if (visibleIds.length > 0) {
      // Listings
      const { rows: countRows } = await pool.query(
        `SELECT l.category_id, COUNT(*)::int AS count
         FROM listings l
         WHERE l.user_id = ANY($1::uuid[])
           AND l.user_id <> $2
           AND l.status = 'active'
           AND ${genderCond}
           AND l.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $2)
           AND l.category_id IS NOT NULL
           ${freeOnly ? "AND (l.price = 0 OR l.is_negotiable = TRUE)" : ''}
         GROUP BY l.category_id`,
        [visibleIds, req.userId]
      );
      countRows.forEach((r) => directCount.set(r.category_id, r.count));

      // Requests (Matlub) — free mode değilse ekle
      if (!freeOnly) {
        const reqGenderCond = (myGender === 'female' || myGender === 'male')
          ? `(r.restricted_to_gender IS NULL OR r.restricted_to_gender = '${myGender}')`
          : `(r.restricted_to_gender IS NULL)`;
        const { rows: reqCountRows } = await pool.query(
          `SELECT r.category_id, COUNT(*)::int AS count
           FROM requests r
           WHERE r.user_id = ANY($1::uuid[])
             AND r.user_id <> $2
             AND r.status = 'active'
             AND r.admin_removed_at IS NULL
             AND ${reqGenderCond}
             AND r.id NOT IN (SELECT request_id FROM hidden_requests WHERE user_id = $2)
             AND r.category_id IS NOT NULL
           GROUP BY r.category_id`,
          [visibleIds, req.userId]
        );
        reqCountRows.forEach((r) => {
          const prev = directCount.get(r.category_id) || 0;
          directCount.set(r.category_id, prev + r.count);
        });
      }
    }

    const { rows } = await pool.query(
      `SELECT id, parent_id, name, slug, icon, ordering
       FROM categories
       ORDER BY COALESCE(parent_id, 0), ordering, id`
    );

    // Toplam sayım: kategorinin kendi + tüm alt-altlarının tam toplamı (recursive)
    const childrenByParent = new Map();
    rows.forEach((r) => {
      if (r.parent_id != null) {
        if (!childrenByParent.has(r.parent_id)) childrenByParent.set(r.parent_id, []);
        childrenByParent.get(r.parent_id).push(r.id);
      }
    });
    const totalCount = new Map();
    function computeTotal(catId) {
      if (totalCount.has(catId)) return totalCount.get(catId);
      let total = directCount.get(catId) || 0;
      const kids = childrenByParent.get(catId) || [];
      for (const k of kids) total += computeTotal(k);
      totalCount.set(catId, total);
      return total;
    }
    rows.forEach((r) => computeTotal(r.id));

    const byId = new Map();
    rows.forEach((r) =>
      byId.set(r.id, { ...r, children: [], count: totalCount.get(r.id) || 0 })
    );

    const tree = [];
    for (const r of rows) {
      const node = byId.get(r.id);
      if (r.parent_id && byId.has(r.parent_id)) {
        byId.get(r.parent_id).children.push(node);
      } else {
        tree.push(node);
      }
    }
    tree.sort((a, b) => a.ordering - b.ordering);

    res.json({ tree, flat: [...byId.values()] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
