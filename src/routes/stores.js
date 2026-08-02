// Mağaza (Store) auth endpoints
// Kullanıcı auth (SMS+PIN) sisteminden TAMAMEN bağımsız.
// Flow: register → email verify → admin approve → login
// JWT payload'da type='store' ile user JWT'sinden ayırt edilir.

const express = require('express');
const Joi = require('joi');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const config = require('../config');
const email = require('../services/email');

const router = express.Router();

// Store frontend base URL — email link'i buraya işaret eder
const STORE_FRONTEND_URL = process.env.STORE_FRONTEND_URL || 'https://magaza.abadan.com.tr';

// ═══════════════════════════════════════════════════════════
// POST /stores/register
// ═══════════════════════════════════════════════════════════
const registerSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(8).max(128).required(),
  name: Joi.string().min(2).max(120).trim().required(),
  phone: Joi.string().max(30).trim().optional().allow(''),
  location_city: Joi.string().max(80).trim().optional().allow(''),
});

router.post('/register', async (req, res, next) => {
  try {
    const { value, error } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Email çakışması
    const existing = await pool.query(
      'SELECT id, is_email_verified FROM stores WHERE LOWER(email) = LOWER($1)',
      [value.email]
    );
    if (existing.rows.length > 0) {
      // Zaten kayıtlı — verify beklemişse tekrar mail gönderelim, aksi halde hata
      const s = existing.rows[0];
      if (!s.is_email_verified) {
        // Yeni verification token + tekrar mail
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `UPDATE stores SET verification_token = $1, verification_sent_at = now()
           WHERE id = $2`,
          [token, s.id]
        );
        await email.sendStoreVerification(
          value.email,
          value.name,
          `${STORE_FRONTEND_URL}/verify.html?token=${token}`
        );
        return res.json({
          ok: true,
          message: 'Bu e-posta zaten kayıtlı ama henüz doğrulanmamış. Yeni doğrulama linki gönderildi.',
        });
      }
      return res.status(409).json({ error: 'email_already_registered' });
    }

    // Yeni kayıt
    const passwordHash = await bcrypt.hash(value.password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const ins = await pool.query(
      `INSERT INTO stores (email, password_hash, name, phone, location_city, verification_token, verification_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING id, email, name`,
      [value.email, passwordHash, value.name, value.phone || null, value.location_city || null, verificationToken]
    );

    // Verification maili
    const emailResult = await email.sendStoreVerification(
      value.email,
      value.name,
      `${STORE_FRONTEND_URL}/verify.html?token=${verificationToken}`
    );

    console.log(`[store-register] new store id=${ins.rows[0].id} email=${value.email} mail_ok=${emailResult.ok}`);

    res.status(201).json({
      ok: true,
      message: 'Kayıt tamamlandı. E-posta adresinize doğrulama linki gönderildi.',
      email_sent: emailResult.ok,
    });
  } catch (err) {
    console.error('[store-register] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /stores/verify?token=xxx
// Email verification link buraya gelir.
// ═══════════════════════════════════════════════════════════
router.get('/verify', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token || token.length < 20) {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }

    const r = await pool.query(
      `SELECT id, email, name, is_email_verified, verification_sent_at
       FROM stores WHERE verification_token = $1`,
      [token]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'token_not_found' });
    }
    const s = r.rows[0];

    if (s.is_email_verified) {
      return res.json({ ok: true, already: true, message: 'E-posta zaten doğrulanmış.' });
    }

    // 48 saat geçerlilik
    const sentAt = new Date(s.verification_sent_at).getTime();
    if (Date.now() - sentAt > 48 * 60 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'token_expired' });
    }

    await pool.query(
      `UPDATE stores SET is_email_verified = true, verification_token = NULL, updated_at = now()
       WHERE id = $1`,
      [s.id]
    );

    console.log(`[store-verify] email verified store=${s.id}`);

    res.json({
      ok: true,
      message: 'E-posta doğrulandı. Admin onayı bekleniyor — onay durumu e-posta ile bildirilecek.',
      email: s.email,
      name: s.name,
    });
  } catch (err) {
    console.error('[store-verify] fail:', err.message);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /stores/login
// ═══════════════════════════════════════════════════════════
const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().required(),
});

router.post('/login', async (req, res, next) => {
  try {
    const { value, error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const r = await pool.query(
      `SELECT id, email, password_hash, name, phone, location_city,
              is_email_verified, is_admin_approved, admin_rejection_reason
       FROM stores WHERE LOWER(email) = LOWER($1)`,
      [value.email]
    );
    if (r.rows.length === 0) {
      // Kimlik açığa çıkarmamak için genel hata
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const s = r.rows[0];

    const ok = await bcrypt.compare(value.password, s.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    if (!s.is_email_verified) {
      return res.status(403).json({
        error: 'email_not_verified',
        message: 'E-postanızı henüz doğrulamadınız. Kayıt sonrası gönderilen linke tıklayın.',
      });
    }

    if (!s.is_admin_approved) {
      if (s.admin_rejection_reason) {
        return res.status(403).json({
          error: 'account_rejected',
          message: 'Başvurunuz onaylanmadı.',
          reason: s.admin_rejection_reason,
        });
      }
      return res.status(403).json({
        error: 'pending_approval',
        message: 'Hesabınız admin onayı bekliyor. Onay durumu e-posta ile bildirilecek.',
      });
    }

    // JWT — type='store' ile user JWT'sinden ayrılır
    const token = jwt.sign(
      { sub: s.id, type: 'store', email: s.email },
      config.jwt.accessSecret,
      { expiresIn: '7d' }  // Mağaza oturumu user'dan daha uzun (15dk yerine 7 gün)
    );

    console.log(`[store-login] ok store=${s.id} email=${s.email}`);

    res.json({
      ok: true,
      token,
      store: {
        id: s.id,
        email: s.email,
        name: s.name,
        phone: s.phone,
        location_city: s.location_city,
      },
    });
  } catch (err) {
    console.error('[store-login] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// Middleware — store auth (JWT.type='store' zorunlu)
// ═══════════════════════════════════════════════════════════
function requireStoreAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const payload = jwt.verify(token, config.jwt.accessSecret);
    if (payload.type !== 'store') return res.status(401).json({ error: 'invalid_token_type' });
    req.storeId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// GET /stores/me — kendi bilgisi
router.get('/me', requireStoreAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, phone, location_city, is_email_verified, is_admin_approved, created_at
       FROM stores WHERE id = $1`,
      [req.storeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ store: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.requireStoreAuth = requireStoreAuth;
module.exports = router;
