// Kullanıcı grupları — rehberdeki kişileri kendi listelerine ayırma.
// İlan verirken görünürlük bu gruplar bazında ayarlanabilir.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/jwt');

const router = express.Router();

const groupSchema = Joi.object({
  name:     Joi.string().min(1).max(60).trim().required(),
  icon:     Joi.string().max(10).allow('').optional(),
  is_ghost: Joi.boolean().default(false),
});

const groupUpdateSchema = Joi.object({
  name:     Joi.string().min(1).max(60).trim().optional(),
  icon:     Joi.string().max(10).allow('').optional(),
  is_ghost: Joi.boolean().optional(),
});

// GET /me/groups — user'ın grupları + üye sayısı
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.icon, g.is_ghost, g.created_at,
              (SELECT COUNT(*)::int FROM contact_group_members m WHERE m.group_id = g.id) AS member_count
       FROM contact_groups g
       WHERE g.user_id = $1
       ORDER BY g.is_ghost DESC, g.created_at ASC`,
      [req.userId]
    );
    res.json({ groups: rows });
  } catch (err) { next(err); }
});

// POST /me/groups — yeni grup
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = groupSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const r = await pool.query(
      `INSERT INTO contact_groups (user_id, name, icon, is_ghost)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, icon, is_ghost, created_at`,
      [req.userId, value.name, value.icon || null, value.is_ghost]
    );
    res.status(201).json({ group: { ...r.rows[0], member_count: 0 } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate_name', message: 'Bu isimde grubun zaten var.' });
    next(err);
  }
});

// PATCH /me/groups/:id
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = groupUpdateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    if (Object.keys(value).length === 0) return res.status(400).json({ error: 'no_fields' });

    const fields = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(value)) {
      fields.push(`${k} = $${i}`);
      params.push(v);
      i++;
    }
    params.push(req.params.id, req.userId);

    const r = await pool.query(
      `UPDATE contact_groups SET ${fields.join(', ')}
       WHERE id = $${i} AND user_id = $${i + 1}
       RETURNING id, name, icon, is_ghost`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ group: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate_name' });
    next(err);
  }
});

// DELETE /me/groups/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      'DELETE FROM contact_groups WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /me/groups/:id — üyelerle
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const g = await pool.query(
      `SELECT id, name, icon, is_ghost, created_at FROM contact_groups WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (g.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const members = await pool.query(
      `SELECT m.contact_phone_hash, m.contact_name, m.added_at,
              u.id AS user_id, u.display_name AS user_name, u.avatar_url
       FROM contact_group_members m
       LEFT JOIN users u ON u.phone_hash = m.contact_phone_hash
       WHERE m.group_id = $1
       ORDER BY m.added_at DESC`,
      [req.params.id]
    );
    res.json({ group: g.rows[0], members: members.rows });
  } catch (err) { next(err); }
});

// POST /me/groups/:id/members  { members: [{phone_hash, contact_name}, ...] }
const addMembersSchema = Joi.object({
  members: Joi.array().items(Joi.object({
    phone_hash:   Joi.string().min(4).max(200).required(),
    contact_name: Joi.string().max(200).allow('').optional(),
  })).min(1).max(200).required(),
});
router.post('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = addMembersSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const own = await pool.query(
      'SELECT id FROM contact_groups WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    for (const m of value.members) {
      await pool.query(
        `INSERT INTO contact_group_members (group_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, contact_phone_hash)
         DO UPDATE SET contact_name = COALESCE(EXCLUDED.contact_name, contact_group_members.contact_name)`,
        [req.params.id, m.phone_hash, m.contact_name || null]
      );
    }
    res.json({ ok: true, added: value.members.length });
  } catch (err) { next(err); }
});

// DELETE /me/groups/:id/members/:phone_hash
router.delete('/:id/members/:phone_hash', requireAuth, async (req, res, next) => {
  try {
    const own = await pool.query(
      'SELECT id FROM contact_groups WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      'DELETE FROM contact_group_members WHERE group_id = $1 AND contact_phone_hash = $2',
      [req.params.id, req.params.phone_hash]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
