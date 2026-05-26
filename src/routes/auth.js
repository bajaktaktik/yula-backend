const express = require('express');
const Joi = require('joi');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { normalizePhone, rehashClientHash } = require('../utils/phone');
const { requestOtp, verifyOtp } = require('../auth/otp');
const { signAccess, signRefresh, verifyRefresh } = require('../auth/jwt');

const router = express.Router();

// ──── PIN tabanlı kayıt + giriş ────
// Login: phone + pin
// Register: phone + pin + OTP kodu (SMS doğrulaması zorunlu)
const loginSchema = Joi.object({
  phone: Joi.string().required(),
  pin: Joi.string().pattern(/^\d{4,8}$/).required(),
  phoneSha256: Joi.string().length(64).required(),
});

const registerSchema = Joi.object({
  phone: Joi.string().required(),
  pin: Joi.string().pattern(/^\d{4,8}$/).required(),
  phoneSha256: Joi.string().length(64).required(),
  code: Joi.string().length(6).required(), // SMS doğrulama kodu — ZORUNLU
  displayName: Joi.string().max(80).required(),
});

// POST /auth/register-pin → yeni hesap (telefon + PIN + isim + SMS kodu)
router.post('/register-pin', async (req, res, next) => {
  try {
    const { value, error } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const e164 = normalizePhone(value.phone);
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });

    // SMS doğrulaması — kod yanlışsa kayıt YOK
    const v = await verifyOtp(e164, value.code);
    if (!v.ok) return res.status(401).json({ error: 'otp_' + v.reason });

    const phoneHash = rehashClientHash(value.phoneSha256);
    const existing = await pool.query('SELECT id, pin_hash FROM users WHERE phone_hash = $1', [phoneHash]);
    if (existing.rows.length > 0 && existing.rows[0].pin_hash) {
      return res.status(409).json({ error: 'already_registered', message: 'Bu numaraya kayıtlı hesap var — giriş yap.' });
    }

    const pinHash = await bcrypt.hash(value.pin, 10);
    let user;
    if (existing.rows.length > 0) {
      // Numara var ama pin yok (eski kayıt) — pin ata, ismi varsa güncelle
      const upd = await pool.query(
        `UPDATE users SET pin_hash = $1, display_name = COALESCE($2, display_name), last_active_at = now()
         WHERE id = $3
         RETURNING id, display_name, avatar_url, bio, gender, location_city, created_at`,
        [pinHash, value.displayName || null, existing.rows[0].id]
      );
      user = upd.rows[0];
    } else {
      const ins = await pool.query(
        `INSERT INTO users (phone_hash, display_name, pin_hash)
         VALUES ($1, $2, $3)
         RETURNING id, display_name, avatar_url, bio, gender, location_city, created_at`,
        [phoneHash, value.displayName || null, pinHash]
      );
      user = ins.rows[0];
    }

    res.json({
      user,
      tokens: { access: signAccess(user.id), refresh: signRefresh(user.id) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login-pin → mevcut hesap girişi (telefon + PIN)
router.post('/login-pin', async (req, res, next) => {
  try {
    const { value, error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const phoneHash = rehashClientHash(value.phoneSha256);
    const q = await pool.query(
      'SELECT id, display_name, avatar_url, bio, gender, location_city, pin_hash FROM users WHERE phone_hash = $1',
      [phoneHash]
    );
    if (q.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'Hesap yok — önce kayıt ol.' });

    const u = q.rows[0];
    if (!u.pin_hash) return res.status(400).json({ error: 'no_pin_set', message: 'Bu hesap PIN ile kayıtlı değil — kayıt ol.' });

    const ok = await bcrypt.compare(value.pin, u.pin_hash);
    if (!ok) return res.status(401).json({ error: 'wrong_pin', message: 'PIN hatalı.' });

    await pool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [u.id]);
    delete u.pin_hash;

    res.json({
      user: u,
      tokens: { access: signAccess(u.id), refresh: signRefresh(u.id) },
    });
  } catch (err) {
    next(err);
  }
});

const requestSchema = Joi.object({
  phone: Joi.string().required(), // E.164 veya yerel format
});

const verifySchema = Joi.object({
  phone: Joi.string().required(),
  code: Joi.string().length(6).required(),
  // İstemci, OTP doğrulama esnasında kendi numarasının SHA-256 hash'ini de gönderir,
  // sunucu bu hash'i (pepper ile) rehashler ve users.phone_hash olarak saklar.
  phoneSha256: Joi.string().length(64).required(),
  displayName: Joi.string().max(80).optional(),
});

router.post('/request-otp', async (req, res, next) => {
  try {
    const { value, error } = requestSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const e164 = normalizePhone(value.phone);
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });
    await requestOtp(e164);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-otp', async (req, res, next) => {
  try {
    const { value, error } = verifySchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const e164 = normalizePhone(value.phone);
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });

    const v = await verifyOtp(e164, value.code);
    if (!v.ok) return res.status(401).json({ error: v.reason });

    const phoneHash = rehashClientHash(value.phoneSha256);

    // Kullanıcıyı bul veya oluştur
    const upsert = await pool.query(
      `INSERT INTO users (phone_hash, display_name)
       VALUES ($1, $2)
       ON CONFLICT (phone_hash) DO UPDATE SET last_active_at = now()
       RETURNING id, display_name, avatar_url, bio, created_at`,
      [phoneHash, value.displayName || null]
    );
    const user = upsert.rows[0];

    res.json({
      user,
      tokens: {
        access: signAccess(user.id),
        refresh: signRefresh(user.id),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const token = req.body.refresh;
    if (!token) return res.status(400).json({ error: 'missing_refresh' });
    const payload = verifyRefresh(token);
    // Kullanıcı hâlâ DB'de var mı? Yoksa silinmiş — eski token ile çalışmaya devam etmesin.
    // Mobil tarafta interceptor 401 alır → logout() çağrılır → kullanıcı Login ekranına döner.
    const u = await pool.query('SELECT id FROM users WHERE id = $1', [payload.sub]);
    if (u.rows.length === 0) return res.status(401).json({ error: 'user_not_found' });
    res.json({ access: signAccess(payload.sub) });
  } catch (err) {
    res.status(401).json({ error: 'invalid_refresh' });
  }
});

module.exports = router;
