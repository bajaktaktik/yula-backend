const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// Admin user_id'leri env'den
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, display_name, avatar_url, bio, gender, location_city, created_at, onboarded_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const user = rows[0];
    // Frontend admin menüsünü gösterip göstermeyeceğini bilmek için
    user.is_admin = ADMIN_USER_IDS.includes(user.id);
    res.json({ user });
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
  // Onboarding tamamlandı işareti — cinsiyet seçimi opsiyonel olduğu için ayrı.
  onboarded: Joi.boolean(),
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
    if (value.onboarded === true) { sets.push(`onboarded_at = COALESCE(onboarded_at, now())`); }
    if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
    params.push(req.userId);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, display_name, avatar_url, bio, gender, location_city, onboarded_at`,
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

// GET /users/me/connections →
// Kullanıcının rehberindeki Abadan kullanıcılarının listesi.
// Her kullanıcı için: id, isim (rehberde kayıtlı isim öncelikli), avatar, aktif ilan sayısı.
// Ana sayfa "X kişi" rozetine tıklandığında açılan ekran için.
router.get('/me/connections', requireAuth, async (req, res, next) => {
  try {
    // Kendi cinsiyetim — gender-restricted ilan sayımını filtrelemek için
    const me = await pool.query('SELECT gender FROM users WHERE id = $1', [req.userId]);
    const myGender = me.rows[0]?.gender || null;
    const genderCond = (myGender === 'female' || myGender === 'male')
      ? `(l.restricted_to_gender IS NULL OR l.restricted_to_gender = '${myGender}')`
      : `(l.restricted_to_gender IS NULL)`;

    const { rows } = await pool.query(
      `WITH my_first_degree_ids AS (
         SELECT u.id AS user_id
         FROM user_contacts uc
         JOIN users u ON u.phone_hash = uc.contact_phone_hash
         WHERE uc.user_id = $1 AND u.status = 'active'
       )
       SELECT u.id, u.avatar_url,
              REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\[DEMO\] ', '') AS name,
              -- Bu tanıdığın kendi aktif ilan sayısı
              (
                SELECT COUNT(*)::int FROM listings l
                WHERE l.user_id = u.id
                  AND l.status = 'active'
                  AND ${genderCond}
                  AND l.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $1)
              ) AS listing_count,
              -- Bu tanıdığın rehberindeki Abadan kullanıcı sayısı (kendisi + bakan hariç)
              -- Kullanıcının ilanları bu kadar kişiye ulaşır (o tanıdık üzerinden)
              (
                SELECT COUNT(DISTINCT u3.id)::int
                FROM user_contacts uc3
                JOIN users u3 ON u3.phone_hash = uc3.contact_phone_hash
                WHERE uc3.user_id = u.id
                  AND u3.status = 'active'
                  AND u3.id != $1
                  AND u3.id != u.id
              ) AS network_size,
              -- Bu tanıdığın rehberindeki 2. derece kullanıcıların (kendi rehberimde OLMAYAN) toplam ilan sayısı
              (
                SELECT COUNT(DISTINCT l2.id)::int
                FROM listings l2
                JOIN users u2 ON u2.id = l2.user_id
                JOIN user_contacts uc2 ON uc2.user_id = u.id AND uc2.contact_phone_hash = u2.phone_hash
                WHERE l2.status = 'active'
                  AND u2.status = 'active'
                  AND u2.id <> $1
                  AND u2.id NOT IN (SELECT user_id FROM my_first_degree_ids)
                  AND (l2.restricted_to_gender IS NULL
                       ${myGender === 'female' || myGender === 'male' ? `OR l2.restricted_to_gender = '${myGender}'` : ''})
                  AND l2.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $1)
              ) AS friend_of_friend_count
       FROM user_contacts uc
       JOIN users u ON u.phone_hash = uc.contact_phone_hash
       WHERE uc.user_id = $1
         AND u.id <> $1
         AND u.status = 'active'
       ORDER BY listing_count DESC, name ASC`,
      [req.userId]
    );

    res.json({ connections: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /users/me/network-size →
// Kullanıcının rehberindeki numaralardan kaç tanesi Abadan'a kayıtlı.
// (Kendisi hariç.) Ana sayfa header'ında "Abadan · 23 kişi" göstermek için.
router.get('/me/network-size', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT u.id)::int AS count
       FROM user_contacts uc
       JOIN users u ON u.phone_hash = uc.contact_phone_hash
       WHERE uc.user_id = $1 AND u.id <> $1`,
      [req.userId]
    );
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    next(err);
  }
});

router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    // KVKK / App Store / Play Store gereği: kullanıcının tüm verisini sil.
    // Tüm ilgili tablolar ON DELETE CASCADE olduğu için users satırını silmek
    // ilanları, mesajları, rehber bağlantılarını, bildirimleri, raporları,
    // blokları, gender-change kayıtlarını otomatik siler.
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, phone_hash',
      [req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    console.log(`[ACCOUNT-DELETE] user=${req.userId} phone_hash=${result.rows[0].phone_hash?.slice(0, 8)}...`);
    res.status(204).end();
  } catch (err) {
    console.error('[ACCOUNT-DELETE] error:', err);
    next(err);
  }
});

module.exports = router;
