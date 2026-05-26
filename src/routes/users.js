const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, display_name, avatar_url, bio, gender, location_city, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

const updateSchema = Joi.object({
  displayName: Joi.string().min(1).max(80),
  avatarUrl: Joi.string().uri(),
  bio: Joi.string().max(300).allow(''),
  gender: Joi.string().valid('female', 'male').allow(null),
  locationCity: Joi.string().max(80).allow(''),
});

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Cinsiyet değişikliği kontrolü: ilk kez set ediliyorsa direkt yazılır,
    // mevcut değeri DEĞİŞTİRMEK isterse onay sürecine yönlendirilir.
    if (value.gender !== undefined) {
      const cur = await pool.query('SELECT gender FROM users WHERE id = $1', [req.userId]);
      const currentGender = cur.rows[0]?.gender;
      if (currentGender && currentGender !== value.gender) {
        return res.status(400).json({
          error: 'gender_change_requires_approval',
          message: 'Cinsiyet değişikliği için karşı cinsten 3 tanıdığının onayı gerekli. /gender-change endpoint\'ini kullan.',
        });
      }
    }

    const sets = [];
    const params = [];
    if (value.displayName !== undefined)  { params.push(value.displayName);  sets.push(`display_name = $${params.length}`); }
    if (value.avatarUrl !== undefined)    { params.push(value.avatarUrl);    sets.push(`avatar_url = $${params.length}`); }
    if (value.bio !== undefined)          { params.push(value.bio);          sets.push(`bio = $${params.length}`); }
    if (value.gender !== undefined)       { params.push(value.gender);       sets.push(`gender = $${params.length}`); }
    if (value.locationCity !== undefined) { params.push(value.locationCity || null); sets.push(`location_city = $${params.length}`); }
    if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
    params.push(req.userId);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, display_name, avatar_url, bio, gender, location_city`,
      params
    );
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Push notification token kaydı (idempotent)
const tokenSchema = Joi.object({
  token: Joi.string().required(),
  platform: Joi.string().valid('ios', 'android').required(),
});

router.post('/me/push-token', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = tokenSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    // Önce: aynı token başka kullanıcıdaysa sil (cihaz hesap değiştirmiş olabilir)
    await pool.query('DELETE FROM device_tokens WHERE token = $1 AND user_id <> $2', [value.token, req.userId]);
    // Sonra: kullanıcıya ekle (yoksa)
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO NOTHING`,
      [req.userId, value.token, value.platform]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/push-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token_required' });
    await pool.query('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2', [req.userId, token]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    // KVKK: kullanıcı verisini siler
    await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
