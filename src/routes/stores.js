// Mağaza (Store) auth endpoints
// Kullanıcı auth (SMS+PIN) sisteminden TAMAMEN bağımsız.
// Flow: register → email verify → admin approve → login
// JWT payload'da type='store' ile user JWT'sinden ayırt edilir.

const express = require('express');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const config = require('../config');
const email = require('../services/email');
const storage = require('../services/storage');

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

    // Email çakışması — soft-deleted olanlar hariç (30 gün sonra hard delete ile temizlenir)
    const existing = await pool.query(
      'SELECT id, is_email_verified FROM stores WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
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
       FROM stores WHERE verification_token = $1 AND deleted_at IS NULL`,
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
              is_email_verified, is_admin_approved, admin_rejection_reason, deleted_at
       FROM stores WHERE LOWER(email) = LOWER($1)`,
      [value.email]
    );
    if (r.rows.length === 0) {
      // Kimlik açığa çıkarmamak için genel hata
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const s = r.rows[0];

    // Soft-deleted hesap — 30 gün yasal saklamada, giriş yok
    if (s.deleted_at) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

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

    // Red durumu — girişe izin YOK, sebep ile bildir
    if (s.admin_rejection_reason) {
      return res.status(403).json({
        error: 'account_rejected',
        message: 'Başvurunuz onaylanmadı.',
        reason: s.admin_rejection_reason,
      });
    }

    // PILOT dönemi — admin onayı bekleyen mağazalar da giriş yapabilir.
    // Dashboard'da onay durumu banner ile gösterilir.
    // İleride kısıtlamak istenirse: !s.is_admin_approved kontrolü buraya eklenir.

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
async function requireStoreAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const payload = jwt.verify(token, config.jwt.accessSecret);
    if (payload.type !== 'store') return res.status(401).json({ error: 'invalid_token_type' });
    // Soft-deleted hesap kontrolü — JWT hala geçerli ama hesap silinmiş olabilir
    const chk = await pool.query(
      'SELECT 1 FROM stores WHERE id = $1 AND deleted_at IS NULL',
      [payload.sub]
    );
    if (chk.rows.length === 0) return res.status(401).json({ error: 'account_removed' });
    req.storeId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// GET /stores/me — kendi bilgisi (tüm profil alanları dahil)
router.get('/me', requireStoreAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, phone, location_city,
              description, logo_url, cover_url, address,
              website_url, instagram, whatsapp, working_hours,
              is_email_verified, is_admin_approved, created_at
       FROM stores WHERE id = $1`,
      [req.storeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ store: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /stores/me — profil güncelle
// Email + password buradan değişmez (ayrı endpoint gerekli).
const updateSchema = Joi.object({
  name:          Joi.string().min(2).max(120).trim().optional(),
  phone:         Joi.string().max(30).trim().allow('').optional(),
  location_city: Joi.string().max(80).trim().allow('').optional(),
  description:   Joi.string().max(2000).allow('').optional(),
  logo_url:      Joi.string().uri().max(500).allow('').optional(),
  cover_url:     Joi.string().uri().max(500).allow('').optional(),
  address:       Joi.string().max(500).allow('').optional(),
  website_url:   Joi.string().uri().max(300).allow('').optional(),
  instagram:     Joi.string().max(100).trim().allow('').optional(),
  whatsapp:      Joi.string().max(30).trim().allow('').optional(),
  working_hours: Joi.object().pattern(Joi.string(), Joi.string().allow('')).optional(),
});

router.patch('/me', requireStoreAuth, async (req, res, next) => {
  try {
    const { value, error } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    if (Object.keys(value).length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    // Dinamik SET klozu
    const fields = [];
    const params = [];
    let idx = 1;
    for (const [key, val] of Object.entries(value)) {
      fields.push(`${key} = $${idx}`);
      // working_hours JSON
      params.push(key === 'working_hours' ? JSON.stringify(val) : val);
      idx++;
    }
    params.push(req.storeId);

    const r = await pool.query(
      `UPDATE stores SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${idx}
       RETURNING id, email, name, phone, location_city,
                 description, logo_url, cover_url, address,
                 website_url, instagram, whatsapp, working_hours,
                 is_email_verified, is_admin_approved, created_at`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ store: r.rows[0] });
  } catch (err) {
    console.error('[store-patch] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// FOTO UPLOAD — /stores/me/photos (store auth)
// User uploads endpoint'ine paralel; store token için ayrı rate limit.
// ═══════════════════════════════════════════════════════════
const storeUploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,  // store için biraz daha yüksek (toplu ilan yükler)
  keyGenerator: (req) => req.storeId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads' },
});
const MAX_PHOTO_SIZE = 8 * 1024 * 1024;

router.post('/me/photos', requireStoreAuth, storeUploadLimiter, async (req, res, next) => {
  try {
    if (!storage.isReady()) {
      return res.status(503).json({ error: 'storage_unavailable' });
    }
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'missing_dataUrl' });
    }
    if (dataUrl.length > MAX_PHOTO_SIZE) {
      return res.status(413).json({ error: 'file_too_large', message: 'Foto çok büyük.' });
    }
    const parsed = storage.parseDataUrl(dataUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'invalid_dataUrl' });
    }

    // type ile R2 klasör ayrımı: store-listings/ | store-logos/ | store-covers/
    const rawType = String(req.query.type || 'listing').toLowerCase();
    const prefixMap = { listing: 'store-listings', logo: 'store-logos', cover: 'store-covers' };
    const prefix = prefixMap[rawType] || 'store-listings';

    const url = await storage.uploadPhoto(parsed.buffer, parsed.contentType, {
      userId: req.storeId,
      prefix,
    });
    console.log(`[store-uploads] store=${req.storeId} type=${rawType} → ${url} (${(parsed.buffer.length / 1024).toFixed(1)}KB)`);
    res.status(201).json({ url });
  } catch (err) {
    console.error('[store-uploads] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// STORE LISTINGS — CRUD (store auth)
// ═══════════════════════════════════════════════════════════

const createListingSchema = Joi.object({
  title:         Joi.string().min(2).max(200).trim().required(),
  description:   Joi.string().min(2).max(4000).trim().required(),
  category_id:   Joi.number().integer().positive().optional().allow(null),
  price:         Joi.number().min(0).max(9999999).required(),
  currency:      Joi.string().length(3).default('TRY'),
  is_negotiable: Joi.boolean().default(false),
  location_city: Joi.string().max(80).trim().allow('').optional(),
  photos:        Joi.array().items(Joi.string().uri().max(500)).max(8).default([]),
});

// POST /stores/me/listings — yeni ilan
router.post('/me/listings', requireStoreAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { value, error } = createListingSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Idempotency-Key header ile duplicate önle
    const idempotencyKey = (req.headers['idempotency-key'] || '').toString().slice(0, 128) || null;
    if (idempotencyKey) {
      const existing = await pool.query(
        `SELECT id FROM store_listings WHERE store_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [req.storeId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(201).json({ id: existing.rows[0].id, idempotent: true });
      }
    }

    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO store_listings
         (store_id, title, description, category_id, price, currency, is_negotiable, location_city, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [req.storeId, value.title, value.description, value.category_id || null,
       value.price, value.currency, value.is_negotiable,
       value.location_city || null, idempotencyKey]
    );
    const listingId = ins.rows[0].id;

    // Photos insert
    if (value.photos.length > 0) {
      for (let i = 0; i < value.photos.length; i++) {
        await client.query(
          `INSERT INTO store_listing_photos (listing_id, url, ordering) VALUES ($1, $2, $3)`,
          [listingId, value.photos[i], i]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[store-listing] created store=${req.storeId} id=${listingId} photos=${value.photos.length}`);
    res.status(201).json({ id: listingId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[store-listing-create] fail:', err.message);
    next(err);
  } finally {
    client.release();
  }
});

// GET /stores/me/listings — mağazanın kendi ilanları
router.get('/me/listings', requireStoreAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.title, l.description, l.price, l.currency, l.is_negotiable,
              l.location_city, l.status, l.view_count, l.sold_at, l.created_at, l.updated_at,
              l.category_id, c.name AS category_name,
              (SELECT COALESCE(p.thumb_url, p.url) FROM store_listing_photos p
               WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM store_listing_photos p WHERE p.listing_id = l.id) AS photo_count
       FROM store_listings l
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.store_id = $1 AND l.admin_removed_at IS NULL
       ORDER BY l.created_at DESC`,
      [req.storeId]
    );
    res.json({ listings: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /stores/me/listings/:id — tek ilan (fotolar dahil)
router.get('/me/listings/:id', requireStoreAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT l.*, c.name AS category_name,
              (SELECT json_agg(json_build_object('id', p.id, 'url', p.url, 'thumb_url', p.thumb_url, 'ordering', p.ordering) ORDER BY p.ordering)
               FROM store_listing_photos p WHERE p.listing_id = l.id) AS photos
       FROM store_listings l
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.id = $1 AND l.store_id = $2`,
      [req.params.id, req.storeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ listing: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /stores/me/listings/:id — ilanı sil (R2 fotoları da temizler)
router.delete('/me/listings/:id', requireStoreAuth, async (req, res, next) => {
  try {
    // Önce fotoları al (R2 cleanup için)
    const photosRes = await pool.query(
      `SELECT p.url FROM store_listing_photos p
       JOIN store_listings l ON l.id = p.listing_id
       WHERE p.listing_id = $1 AND l.store_id = $2`,
      [req.params.id, req.storeId]
    );

    const del = await pool.query(
      'DELETE FROM store_listings WHERE id = $1 AND store_id = $2 RETURNING id',
      [req.params.id, req.storeId]
    );
    if (del.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    // R2 cleanup — arka planda, response'u bekletmez
    if (photosRes.rows.length > 0 && storage.cleanupPhotoUrls) {
      const urls = photosRes.rows.map((r) => r.url);
      storage.cleanupPhotoUrls(urls).catch((e) => console.warn('[store-del] R2 cleanup fail:', e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /stores/me/listings/:id — sold/inactive işaretle
router.patch('/me/listings/:id', requireStoreAuth, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const allowed = ['active', 'sold', 'inactive'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    const soldAt = status === 'sold' ? 'now()' : 'NULL';
    const r = await pool.query(
      `UPDATE store_listings
       SET status = $1, sold_at = ${soldAt}, updated_at = now()
       WHERE id = $2 AND store_id = $3
       RETURNING id, status`,
      [status, req.params.id, req.storeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, listing: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// AYARLAR — parola değiştir, email değiştir, hesap sil
// ═══════════════════════════════════════════════════════════

// POST /stores/me/change-password
const changePwSchema = Joi.object({
  current_password: Joi.string().required(),
  new_password:     Joi.string().min(8).max(128).required(),
});
router.post('/me/change-password', requireStoreAuth, async (req, res, next) => {
  try {
    const { value, error } = changePwSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    if (value.current_password === value.new_password) {
      return res.status(400).json({ error: 'same_password', message: 'Yeni parola eskisiyle aynı olamaz.' });
    }

    const r = await pool.query('SELECT password_hash FROM stores WHERE id = $1', [req.storeId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const ok = await bcrypt.compare(value.current_password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'wrong_password', message: 'Mevcut parola hatalı.' });

    const newHash = await bcrypt.hash(value.new_password, 12);
    await pool.query(
      'UPDATE stores SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, req.storeId]
    );
    console.log(`[store-changepw] store=${req.storeId}`);
    res.json({ ok: true, message: 'Parola değiştirildi.' });
  } catch (err) {
    next(err);
  }
});

// POST /stores/me/change-email
// Yeni email adresine verify link gönderilir. Doğrulama sonrası aktif olur.
const changeEmailSchema = Joi.object({
  new_email: Joi.string().email().lowercase().trim().required(),
  password:  Joi.string().required(),
});
router.post('/me/change-email', requireStoreAuth, async (req, res, next) => {
  try {
    const { value, error } = changeEmailSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const r = await pool.query(
      'SELECT email, password_hash, name FROM stores WHERE id = $1',
      [req.storeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const s = r.rows[0];

    if (s.email.toLowerCase() === value.new_email) {
      return res.status(400).json({ error: 'same_email', message: 'Yeni email eskisiyle aynı.' });
    }

    // Parola kontrolü (güvenlik — email hijacking önlemi)
    const ok = await bcrypt.compare(value.password, s.password_hash);
    if (!ok) return res.status(401).json({ error: 'wrong_password' });

    // Email başka store'da var mı?
    const dup = await pool.query(
      'SELECT id FROM stores WHERE LOWER(email) = LOWER($1) AND id <> $2',
      [value.new_email, req.storeId]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'email_already_used' });
    }

    // Yeni email + verify pending — is_email_verified=false yap, yeni token üret
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE stores
       SET email = $1, is_email_verified = false,
           verification_token = $2, verification_sent_at = now(), updated_at = now()
       WHERE id = $3`,
      [value.new_email, token, req.storeId]
    );

    // Verify mail
    await email.sendStoreVerification(
      value.new_email,
      s.name,
      `${STORE_FRONTEND_URL}/verify.html?token=${token}`
    );

    console.log(`[store-changeemail] store=${req.storeId} old=${s.email} new=${value.new_email}`);
    res.json({
      ok: true,
      message: 'Yeni e-posta adresinize doğrulama linki gönderildi. Doğrulama sonrası email güncellenmiş olacak.',
    });
  } catch (err) {
    console.error('[store-changeemail] fail:', err.message);
    next(err);
  }
});

// DELETE /stores/me — SOFT DELETE (yasal saklama süresi 30 gün)
// Parola onayı zorunlu. Veri (ilanlar, mesajlar, fotolar) 30 gün korunur;
// yasal şikayet süresi sonunda cleanup job hard delete yapar.
router.delete('/me', requireStoreAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password_required' });

    const r = await pool.query('SELECT password_hash, email FROM stores WHERE id = $1', [req.storeId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'wrong_password' });

    // Soft delete — deleted_at set, veri KORUNUR (R2 fotoları da 30 gün duracak)
    await pool.query(
      'UPDATE stores SET deleted_at = now(), updated_at = now() WHERE id = $1',
      [req.storeId]
    );
    console.log(`[store-soft-delete] store=${req.storeId} email=${r.rows[0].email} (30 gün sonra hard delete)`);
    res.json({
      ok: true,
      message: 'Hesabınız silindi. Yasal yükümlülükler gereği veriler 30 gün saklanır, ardından tamamen kaldırılır.',
    });
  } catch (err) {
    console.error('[store-delete] fail:', err.message);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// MAĞAZA-KULLANICI CHAT — mağaza tarafı endpoint'leri
// ═══════════════════════════════════════════════════════════

// GET /stores/me/conversations — konuşma listesi
// Her satırda: karşı taraf (user) bilgisi, ilgili ilan, son mesaj, unread sayısı
router.get('/me/conversations', requireStoreAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id, c.store_id, c.user_id, c.store_listing_id, c.last_message_at, c.created_at,
         u.display_name AS user_name,
         u.avatar_url AS user_avatar,
         l.title AS listing_title,
         l.price AS listing_price,
         (SELECT COALESCE(p.thumb_url, p.url) FROM store_listing_photos p
          WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS listing_cover,
         (SELECT content FROM store_messages m WHERE m.conversation_id = c.id
          ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
         (SELECT sender_type FROM store_messages m WHERE m.conversation_id = c.id
          ORDER BY m.sent_at DESC LIMIT 1) AS last_sender_type,
         (SELECT COUNT(*)::int FROM store_messages m
          WHERE m.conversation_id = c.id
            AND m.sender_type = 'user'
            AND m.read_at IS NULL) AS unread_count
       FROM store_conversations c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN store_listings l ON l.id = c.store_listing_id
       WHERE c.store_id = $1
         AND EXISTS (SELECT 1 FROM store_messages m WHERE m.conversation_id = c.id)
       ORDER BY c.last_message_at DESC NULLS LAST`,
      [req.storeId]
    );
    res.json({ conversations: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /stores/me/conversations/:id/messages — bir konuşmanın mesajları
router.get('/me/conversations/:id/messages', requireStoreAuth, async (req, res, next) => {
  try {
    // Erişim kontrolü
    const conv = await pool.query(
      'SELECT id FROM store_conversations WHERE id = $1 AND store_id = $2',
      [req.params.id, req.storeId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const { rows } = await pool.query(
      `SELECT id, sender_type, sender_id, content, sent_at, read_at
       FROM store_messages
       WHERE conversation_id = $1
       ORDER BY sent_at ASC
       LIMIT 500`,
      [req.params.id]
    );

    res.json({ messages: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /stores/me/conversations/:id/messages — mağaza cevap yazar
const sendStoreMsgSchema = Joi.object({
  content: Joi.string().min(1).max(2000).trim().required(),
});
router.post('/me/conversations/:id/messages', requireStoreAuth, async (req, res, next) => {
  try {
    const { value, error } = sendStoreMsgSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const conv = await pool.query(
      'SELECT id FROM store_conversations WHERE id = $1 AND store_id = $2',
      [req.params.id, req.storeId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const ins = await pool.query(
      `INSERT INTO store_messages (conversation_id, sender_type, sender_id, content)
       VALUES ($1, 'store', $2, $3)
       RETURNING id, sender_type, sender_id, content, sent_at`,
      [req.params.id, req.storeId, value.content]
    );

    // last_message_at güncelle
    await pool.query(
      'UPDATE store_conversations SET last_message_at = now() WHERE id = $1',
      [req.params.id]
    );

    res.status(201).json({ message: ins.rows[0] });
  } catch (err) {
    console.error('[store-msg-send] fail:', err.message);
    next(err);
  }
});

// POST /stores/me/conversations/:id/read — kullanıcı mesajlarını okundu işaretle
router.post('/me/conversations/:id/read', requireStoreAuth, async (req, res, next) => {
  try {
    const conv = await pool.query(
      'SELECT id FROM store_conversations WHERE id = $1 AND store_id = $2',
      [req.params.id, req.storeId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `UPDATE store_messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_type = 'user' AND read_at IS NULL`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /stores/categories — kategori ağacı (dropdown için)
// Store auth şart değil — kategoriler zaten kamuya açık bilgi.
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, parent_id, name, slug, icon, ordering
       FROM categories
       ORDER BY parent_id NULLS FIRST, ordering, name`
    );
    // Ağaç yapısı
    const byId = new Map();
    const roots = [];
    rows.forEach((c) => byId.set(c.id, { ...c, children: [] }));
    rows.forEach((c) => {
      const node = byId.get(c.id);
      if (c.parent_id) byId.get(c.parent_id)?.children.push(node);
      else roots.push(node);
    });
    res.json({ tree: roots, flat: rows });
  } catch (err) {
    next(err);
  }
});

router.requireStoreAuth = requireStoreAuth;
module.exports = router;
