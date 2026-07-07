const express = require('express');
const Joi = require('joi');
const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');
const pool = require('../db/pool');
const { normalizePhone, rehashClientHash } = require('../utils/phone');
const { requestOtp, verifyOtp } = require('../auth/otp');
const { signAccess, signRefresh, verifyRefresh, verifyAccess } = require('../auth/jwt');
const { ensureReviewerSeed } = require('../services/reviewer-seed');
const { requireAuth } = require('../auth/middleware');

const REVIEWER_PHONES = (process.env.REVIEWER_PHONES || '+905555555555')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ADMIN_USER_IDS_SET = new Set(
  (process.env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
// TOTP: tolerans ±1 pencere (30sn öncesi/sonrası kabul) — cihaz saati kaymalarına dayanıklı
authenticator.options = { window: 1, step: 30 };

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

// Demo/Reviewer PIN — Apple/Play Store reviewer'ı ve testler için sabit PIN.
// Kullanım: REVIEWER_PHONES env'indeki numaralar ile PIN=DEMO_PIN → direkt giriş.
// (SMS OTP veya gerçek PIN kaydı gerekmez; hesap yoksa otomatik oluşturulur.)
const DEMO_PIN = process.env.DEMO_PIN || '4242';

// POST /auth/login-pin → mevcut hesap girişi (telefon + PIN)
router.post('/login-pin', async (req, res, next) => {
  try {
    const { value, error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const e164 = normalizePhone(value.phone);
    const phoneHash = rehashClientHash(value.phoneSha256);

    // ─── DEMO BYPASS ───
    // Reviewer telefonu + DEMO PIN → hesap yoksa oluştur, direkt token dön
    if (e164 && REVIEWER_PHONES.includes(e164) && value.pin === DEMO_PIN) {
      let user;
      const existing = await pool.query(
        'SELECT id, display_name, avatar_url, bio, gender, location_city FROM users WHERE phone_hash = $1',
        [phoneHash]
      );
      if (existing.rows.length > 0) {
        user = existing.rows[0];
      } else {
        const ins = await pool.query(
          `INSERT INTO users (phone_hash, display_name, onboarded_at)
           VALUES ($1, 'Demo Kullanıcı', now())
           RETURNING id, display_name, avatar_url, bio, gender, location_city`,
          [phoneHash]
        );
        user = ins.rows[0];
      }
      await pool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [user.id]);
      // Demo hesap için seed'i tetikle (feed dolu görünsün)
      ensureReviewerSeed(user.id).catch((e) => console.error('[demo-seed]', e.message));
      console.log(`[auth] demo login bypass user=${user.id} phone=${e164}`);
      return res.json({
        user,
        tokens: { access: signAccess(user.id), refresh: signRefresh(user.id) },
      });
    }

    // ─── NORMAL PIN GİRİŞİ ───
    const q = await pool.query(
      'SELECT id, display_name, avatar_url, bio, gender, location_city, pin_hash, status FROM users WHERE phone_hash = $1',
      [phoneHash]
    );
    if (q.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'Hesap yok — önce kayıt ol.' });

    const u = q.rows[0];
    // Yasaklı hesap girişi tamamen kapatılır
    if (u.status === 'banned') {
      return res.status(403).json({ error: 'user_banned', message: 'Hesabınız yasaklanmıştır.' });
    }
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

    // App Store / Play Store reviewer ise demo content seed et (idempotent, fire-and-forget).
    // Reviewer login olduğunda ana sayfa dolu görür → "boş uygulama" reject riski biter.
    if (REVIEWER_PHONES.includes(e164)) {
      // await etmeden çalıştır — login response'unu beklemesin
      ensureReviewerSeed(user.id).catch((e) => console.error('[reviewer-seed]', e.message));
    }

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

// ──── PIN değiştirme (auth gerekli, eski PIN doğrulanır) ────
const changePinSchema = Joi.object({
  oldPin: Joi.string().pattern(/^\d{4,8}$/).required(),
  newPin: Joi.string().pattern(/^\d{4,8}$/).required(),
});

router.post('/change-pin', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = changePinSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    if (value.oldPin === value.newPin) {
      return res.status(400).json({ error: 'same_pin', message: 'Yeni PIN eski PIN ile aynı olamaz.' });
    }
    const q = await pool.query('SELECT pin_hash FROM users WHERE id = $1', [req.userId]);
    if (q.rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
    const ok = await bcrypt.compare(value.oldPin, q.rows[0].pin_hash);
    if (!ok) return res.status(401).json({ error: 'wrong_pin', message: 'Eski PIN hatalı.' });
    const newHash = await bcrypt.hash(value.newPin, 10);
    await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [newHash, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──── PIN sıfırlama (SMS OTP ile, auth gerekmez) ────
// Akış: client önce /auth/request-otp ile kod ister; sonra bu endpoint'e
// telefon + kod + yeni PIN yollar. Kod doğruysa yeni PIN kaydedilir.
const resetPinSchema = Joi.object({
  phone: Joi.string().required(),
  phoneSha256: Joi.string().length(64).required(),
  code: Joi.string().length(6).required(),
  newPin: Joi.string().pattern(/^\d{4,8}$/).required(),
});

router.post('/reset-pin', async (req, res, next) => {
  try {
    const { value, error } = resetPinSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const e164 = normalizePhone(value.phone);
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });

    // SMS doğrulaması — kod yanlışsa sıfırlama YOK
    const v = await verifyOtp(e164, value.code);
    if (!v.ok) return res.status(401).json({ error: 'otp_' + v.reason });

    const phoneHash = rehashClientHash(value.phoneSha256);
    const q = await pool.query('SELECT id FROM users WHERE phone_hash = $1', [phoneHash]);
    if (q.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'Bu numaraya kayıtlı hesap yok.' });

    const newHash = await bcrypt.hash(value.newPin, 10);
    await pool.query('UPDATE users SET pin_hash = $1, last_active_at = now() WHERE id = $2', [newHash, q.rows[0].id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// WEB ADMIN PANEL LOGIN — TOTP (Google Authenticator) 2FA zorunlu
// ═══════════════════════════════════════════════════════════════
// Mobile app değişmez, /auth/login-pin kullanır.
// Web panel /auth/panel/login kullanır ve is_admin + TOTP zorunludur.

const panelLoginSchema = Joi.object({
  phone: Joi.string().required(),
  phoneSha256: Joi.string().length(64).required(),
  pin: Joi.string().pattern(/^\d{4,8}$/).required(),
  totp: Joi.string().length(6).pattern(/^\d{6}$/).optional(),
});

router.post('/panel/login', async (req, res, next) => {
  try {
    const { value, error } = panelLoginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const phoneHash = rehashClientHash(value.phoneSha256);
    const q = await pool.query(
      `SELECT id, display_name, avatar_url, bio, gender, location_city, pin_hash, status,
              admin_totp_secret, admin_totp_verified_at
       FROM users WHERE phone_hash = $1`,
      [phoneHash]
    );
    if (q.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'Hesap yok.' });
    const u = q.rows[0];
    if (u.status === 'banned') return res.status(403).json({ error: 'user_banned', message: 'Hesabınız yasaklanmıştır.' });
    if (!ADMIN_USER_IDS_SET.has(u.id)) {
      return res.status(403).json({ error: 'not_admin', message: 'Panel erişimi reddedildi.' });
    }

    // PIN doğrula
    if (!u.pin_hash) return res.status(400).json({ error: 'no_pin_set' });
    const okPin = await bcrypt.compare(value.pin, u.pin_hash);
    if (!okPin) return res.status(401).json({ error: 'wrong_pin', message: 'PIN hatalı.' });

    // TOTP durumu
    const hasVerifiedTotp = u.admin_totp_secret && u.admin_totp_verified_at;

    if (!hasVerifiedTotp) {
      // Setup gerekli — geçici token (kısa ömürlü) döndür, kullanıcı /panel/totp-setup çağıracak
      // Bu geçici token'ın scope'u sadece TOTP kurulumu; genel access gibi kullanılamaz
      const setupToken = signAccess(u.id, { scope: 'totp_setup', expiresIn: '10m' });
      return res.status(200).json({
        setup_required: true,
        setup_token: setupToken,
        message: 'İlk giriş — Google Authenticator kurulumu gerekli.',
      });
    }

    // TOTP zorunlu
    if (!value.totp) {
      return res.status(400).json({ error: 'totp_required', message: 'Google Authenticator kodu gerekli.' });
    }
    const okTotp = authenticator.check(value.totp, u.admin_totp_secret);
    if (!okTotp) {
      return res.status(401).json({ error: 'wrong_totp', message: 'Doğrulama kodu hatalı.' });
    }

    // Başarılı — normal token dön
    await pool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [u.id]);
    delete u.pin_hash;
    delete u.admin_totp_secret;
    delete u.admin_totp_verified_at;
    u.is_admin = true;
    console.log(`[auth] panel login user=${u.id}`);
    res.json({
      user: u,
      tokens: { access: signAccess(u.id), refresh: signRefresh(u.id) },
    });
  } catch (err) {
    next(err);
  }
});

// Kullanıcı setup_token ile bu endpoint'i çağırır — QR + secret döner
// Frontend kullanıcıya QR kodu gösterir, kullanıcı Google Authenticator'a ekler.
router.post('/panel/totp-setup', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let payload;
    try { payload = verifyAccess(token); } catch { return res.status(401).json({ error: 'invalid_token' }); }
    if (payload.scope !== 'totp_setup') return res.status(403).json({ error: 'wrong_scope' });

    const userId = payload.sub;
    if (!ADMIN_USER_IDS_SET.has(userId)) return res.status(403).json({ error: 'not_admin' });

    // Yeni secret üret + DB'ye ilk kez yaz (verified_at = null)
    // Eğer önceden bir secret varsa (partial setup) üzerine yazılır — kullanıcı yeni QR kodu görür.
    const secret = authenticator.generateSecret();
    await pool.query(
      `UPDATE users SET admin_totp_secret = $1, admin_totp_verified_at = NULL WHERE id = $2`,
      [secret, userId]
    );

    // Kullanıcıya gösterilecek isim (Authenticator uygulamasında görünür)
    const u = await pool.query('SELECT display_name FROM users WHERE id = $1', [userId]);
    const label = 'Abadan Admin (' + (u.rows[0]?.display_name || userId.slice(0, 8)) + ')';
    const issuer = 'Abadan';
    const otpauthUri = authenticator.keyuri(label, issuer, secret);

    console.log(`[auth] totp setup started for admin=${userId}`);
    res.json({ secret, otpauth_uri: otpauthUri });
  } catch (err) {
    next(err);
  }
});

// Kullanıcı Google Authenticator'a eklediği ilk kodu bu endpoint'te doğrular
// Doğruysa verified_at = now() olur; sonraki loginlerde TOTP zorunlu.
router.post('/panel/totp-enable', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let payload;
    try { payload = verifyAccess(token); } catch { return res.status(401).json({ error: 'invalid_token' }); }
    if (payload.scope !== 'totp_setup') return res.status(403).json({ error: 'wrong_scope' });

    const userId = payload.sub;
    if (!ADMIN_USER_IDS_SET.has(userId)) return res.status(403).json({ error: 'not_admin' });

    const { code } = req.body || {};
    if (!code || !/^\d{6}$/.test(String(code))) return res.status(400).json({ error: 'invalid_code' });

    const u = await pool.query(
      'SELECT id, display_name, avatar_url, bio, gender, location_city, admin_totp_secret FROM users WHERE id = $1',
      [userId]
    );
    if (u.rows.length === 0 || !u.rows[0].admin_totp_secret) {
      return res.status(400).json({ error: 'setup_missing', message: 'Önce TOTP setup çağır.' });
    }

    const ok = authenticator.check(String(code), u.rows[0].admin_totp_secret);
    if (!ok) return res.status(401).json({ error: 'wrong_code', message: 'Kod hatalı.' });

    await pool.query('UPDATE users SET admin_totp_verified_at = now() WHERE id = $1', [userId]);
    console.log(`[auth] totp verified & enabled for admin=${userId}`);

    // Setup tamamlandı — normal token'ları dön (kullanıcı hemen giriş yapmış olur)
    const user = { ...u.rows[0], is_admin: true };
    delete user.admin_totp_secret;
    res.json({
      user,
      tokens: { access: signAccess(userId), refresh: signRefresh(userId) },
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
