const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { rehashClientHash } = require('../utils/phone');
const graph = require('../services/graph');

const router = express.Router();

const syncSchema = Joi.object({
  // İstemci her bir rehber kişisi için { sha256, name } gönderir.
  // sha256: E.164 normalize edilmiş numaranın SHA-256 hex hash'i (alt çizgisiz, küçük harf)
  contacts: Joi.array().items(
    Joi.object({
      sha256: Joi.string().length(64).required(),
      name: Joi.string().max(120).optional(),
    })
  ).min(1).max(5000).required(),
  replace: Joi.boolean().default(true), // true ise mevcut rehber silinir
});

router.post('/sync', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { value, error } = syncSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    await client.query('BEGIN');
    if (value.replace) {
      await client.query('DELETE FROM user_contacts WHERE user_id = $1', [req.userId]);
    }

    // Toplu insert
    const rows = value.contacts.map((c) => ({
      hash: rehashClientHash(c.sha256),
      name: c.name || null,
    }));

    // pg parametre limiti nedeniyle 500'lük gruplar
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const params = [];
      const values = [];
      slice.forEach((r, idx) => {
        params.push(`($1, $${idx * 2 + 2}, $${idx * 2 + 3})`);
        values.push(r.hash, r.name);
      });
      await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ${params.join(',')}
         ON CONFLICT (user_id, contact_phone_hash) DO UPDATE SET contact_name = EXCLUDED.contact_name`,
        [req.userId, ...values]
      );
    }
    await client.query('COMMIT');

    // Önbelleği temizle: hem bu kullanıcının hem de bu kullanıcıyı rehberine ekleyenlerin
    await graph.invalidate(req.userId);

    res.json({ ok: true, count: rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
