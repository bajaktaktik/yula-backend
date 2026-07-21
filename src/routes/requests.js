// Matlub (İstekler) — kullanıcıların aradıkları ürünler.
// Tanıdıkları elinde varsa ama satmayı unuttuysa bu şekilde farkında olur.
// Listings'ten farkları: fiyat yok, foto yok, "fulfilled" (karşılandı) durumu var.
//
// Zaman filtresi + Sold-benzeri "fulfilled" tracking (24h user / 7d global) uygulanır.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const graph = require('../services/graph');

const router = express.Router();

// Kendi cinsiyetim (cinsiyet kısıtlı istekleri filtrelemek için)
async function getMyGender(userId) {
  const r = await pool.query('SELECT gender FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.gender || null;
}

function genderFilter(myGender) {
  if (myGender === 'female' || myGender === 'male') {
    return `(r.restricted_to_gender IS NULL OR r.restricted_to_gender = '${myGender}')`;
  }
  return `(r.restricted_to_gender IS NULL)`;
}

// ─────────────────────────────────────────
// GET /requests — feed (tanıdık + 2. derece)
// ─────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const includeSecondDegree = req.query.includeSecondDegree === '1' || req.query.includeSecondDegree === 'true';
    const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
    const days = req.query.days ? Math.max(1, Math.min(parseInt(req.query.days, 10), 365)) : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    // 1. derece + opsiyonel 2. derece
    const visible = await graph.getVisibleUserIds(req.userId);
    const tierMap = new Map();
    for (const uid of visible.keys()) tierMap.set(String(uid), { tier: 1 });
    if (includeSecondDegree) {
      const second = await graph.getSecondDegreeMap(req.userId);
      for (const [uid, info] of second) {
        if (!tierMap.has(String(uid))) {
          tierMap.set(String(uid), { tier: 2, ...info });
        }
      }
    }
    const ids = Array.from(tierMap.keys());
    if (ids.length === 0) return res.json({ requests: [], count: 0 });

    const myGender = await getMyGender(req.userId);

    const filters = [
      'r.user_id = ANY($1::uuid[])',
      `(
        r.status = 'active'
        OR (
          r.status = 'fulfilled'
          AND r.fulfilled_at IS NOT NULL
          AND r.fulfilled_at > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM fulfilled_request_seen fs
            WHERE fs.request_id = r.id
              AND fs.user_id = '${req.userId}'
              AND fs.first_seen_at < now() - interval '24 hours'
          )
        )
      )`,
      'r.admin_removed_at IS NULL',
      genderFilter(myGender),
      `r.user_id <> '${req.userId}'`,
    ];
    const params = [ids];
    if (days) filters.push(`r.created_at >= now() - interval '${days} days'`);
    if (!includeHidden) {
      filters.push(`r.id NOT IN (SELECT request_id FROM hidden_requests WHERE user_id = '${req.userId}')`);
    }

    params.push(limit, offset);

    const sql = `
      SELECT r.id, r.title, r.description, r.status, r.fulfilled_at,
             r.category_id, c.name AS category_name, c.slug AS category_slug,
             r.created_at, r.view_count,
             r.user_id,
             REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\\[DEMO\\] ', '') AS seller_name,
             u.avatar_url AS seller_avatar,
             EXISTS(SELECT 1 FROM hidden_requests WHERE user_id = '${req.userId}' AND request_id = r.id) AS is_hidden
      FROM requests r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN categories c ON c.id = r.category_id
      LEFT JOIN user_contacts uc ON uc.user_id = '${req.userId}' AND uc.contact_phone_hash = u.phone_hash
      WHERE ${filters.join(' AND ')}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(sql, params);

    const result = rows.map((row) => {
      const tierInfo = tierMap.get(String(row.user_id)) || { tier: 1 };
      const tier = tierInfo.tier;
      const isSecond = tier === 2;
      return {
        ...row,
        degree: tier,
        tier,
        seller_name: isSecond ? null : row.seller_name,
        seller_avatar: isSecond ? null : row.seller_avatar,
        via_user_id: isSecond ? tierInfo.via_user_id : null,
        via_name: isSecond ? tierInfo.via_name : null,
        mutual_count: isSecond ? tierInfo.mutual_count : null,
      };
    });

    // Fulfilled request tracking — bu feed'de görülen fulfilled request'leri kaydet
    const fulfilledIds = result.filter((r) => r.status === 'fulfilled').map((r) => r.id);
    if (fulfilledIds.length > 0) {
      pool.query(
        `INSERT INTO fulfilled_request_seen (request_id, user_id)
         SELECT unnest($1::uuid[]), $2
         ON CONFLICT DO NOTHING`,
        [fulfilledIds, req.userId]
      ).catch((e) => console.error('[requests] fulfilled_seen track fail:', e.message));
    }

    res.json({
      requests: result,
      count: result.length,
      counts: {
        first: result.filter((r) => r.tier === 1).length,
        second: result.filter((r) => r.tier === 2).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// POST /requests — yeni istek
// ─────────────────────────────────────────
const createSchema = Joi.object({
  title: Joi.string().min(2).max(120).required(),
  description: Joi.string().min(2).max(2000).required(),
  categoryId: Joi.number().integer().allow(null).optional(),
  restrictedToGender: Joi.string().valid('female', 'male').allow(null).optional(),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Yasak kelime kontrolü
    const bannedWords = require('../services/banned-words');
    const combined = (value.title || '') + '\n' + (value.description || '');
    const check = await bannedWords.checkText(combined);
    if (check.blocked) {
      return res.status(400).json({
        error: 'content_blocked',
        message: check.message,
        matched: check.matched_pattern,
      });
    }

    // Cinsiyet kısıtı — kullanıcı kendi cinsiyetiyle uyumlu olmalı
    let restrictedTo = null;
    if (value.restrictedToGender) {
      const myGender = await getMyGender(req.userId);
      if (myGender && myGender === value.restrictedToGender) {
        restrictedTo = value.restrictedToGender;
      }
    }

    const r = await pool.query(
      `INSERT INTO requests (user_id, title, description, category_id, restricted_to_gender)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, value.title, value.description, value.categoryId || null, restrictedTo]
    );

    res.status(201).json({ request: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// GET /requests/:id — detay
// ─────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const visible = await graph.getVisibleUserIds(req.userId);
    const myGender = await getMyGender(req.userId);
    const { rows } = await pool.query(
      `SELECT r.*,
              REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\\[DEMO\\] ', '') AS seller_name,
              u.avatar_url AS seller_avatar,
              c.name AS category_name, c.slug AS category_slug
       FROM requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN user_contacts uc ON uc.user_id = $2 AND uc.contact_phone_hash = u.phone_hash
       WHERE r.id = $1`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const request = rows[0];

    if (request.user_id !== req.userId && request.restricted_to_gender) {
      if (request.restricted_to_gender !== myGender) return res.status(404).json({ error: 'not_found' });
    }

    const isOwn = request.user_id === req.userId;
    const inFirstDegree = visible.has(request.user_id);
    let tier = isOwn ? 0 : (inFirstDegree ? 1 : null);
    let viaInfo = null;

    if (!isOwn && !inFirstDegree) {
      const secondMap = await graph.getSecondDegreeMap(req.userId);
      const info = secondMap.get(request.user_id);
      if (info) { tier = 2; viaInfo = info; }
      else return res.status(403).json({ error: 'not_in_your_network' });
    }

    const isSecond = tier === 2;

    // View count artır — sahibi hariç
    if (!isOwn) {
      pool.query('UPDATE requests SET view_count = view_count + 1 WHERE id = $1', [req.params.id]).catch(() => {});
    }

    res.json({
      ...request,
      seller_name: isSecond ? null : request.seller_name,
      seller_avatar: isSecond ? null : request.seller_avatar,
      user_id: isSecond ? null : request.user_id,
      real_user_id: request.user_id,
      tier,
      degree: tier,
      via_user_id: viaInfo?.via_user_id || null,
      via_name: viaInfo?.via_name || null,
      mutual_count: viaInfo?.mutual_count || null,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// PATCH /requests/:id — düzenle (sahibi)
// ─────────────────────────────────────────
const updateSchema = Joi.object({
  title: Joi.string().min(2).max(120),
  description: Joi.string().min(2).max(2000),
  categoryId: Joi.number().integer().allow(null),
  restrictedToGender: Joi.string().valid('female', 'male').allow(null),
  status: Joi.string().valid('active', 'fulfilled'),
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const own = await pool.query(
      'SELECT id, admin_removed_at FROM requests WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    if (own.rows[0].admin_removed_at) {
      return res.status(403).json({ error: 'admin_removed', message: 'Bu istek yönetim tarafından kaldırıldı.' });
    }

    const { value, error } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Yasak kelime kontrolü
    if (value.title || value.description) {
      const bannedWords = require('../services/banned-words');
      const combined = (value.title || '') + '\n' + (value.description || '');
      const check = await bannedWords.checkText(combined);
      if (check.blocked) {
        return res.status(400).json({ error: 'content_blocked', message: check.message });
      }
    }

    const updates = [];
    const params = [];
    if (value.title !== undefined) { params.push(value.title); updates.push(`title = $${params.length}`); }
    if (value.description !== undefined) { params.push(value.description); updates.push(`description = $${params.length}`); }
    if (value.categoryId !== undefined) { params.push(value.categoryId); updates.push(`category_id = $${params.length}`); }
    if (value.restrictedToGender !== undefined) { params.push(value.restrictedToGender || null); updates.push(`restricted_to_gender = $${params.length}`); }
    if (value.status !== undefined) {
      params.push(value.status);
      updates.push(`status = $${params.length}`);
      // Fulfilled/active geçişinde fulfilled_at damgala/temizle
      if (value.status === 'fulfilled') updates.push(`fulfilled_at = COALESCE(fulfilled_at, now())`);
      else if (value.status === 'active') updates.push(`fulfilled_at = NULL`);
    }
    updates.push(`updated_at = now()`);

    if (updates.length === 1) return res.status(400).json({ error: 'no_fields' });

    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE requests SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ request: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// DELETE /requests/:id — sil (sahibi)
// ─────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      'DELETE FROM requests WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// POST /requests/:id/hide — gizle
// DELETE /requests/:id/hide — göster
// ─────────────────────────────────────────
router.post('/:id/hide', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO hidden_requests (user_id, request_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/hide', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM hidden_requests WHERE user_id = $1 AND request_id = $2',
      [req.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// GET /requests/mine/list — kullanıcının kendi istekleri
// ─────────────────────────────────────────
router.get('/mine/list', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT r.*, c.name AS category_name
       FROM requests r
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.userId]
    );
    res.json({ requests: r.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
