// Fotoğraf upload endpoint'i. Mobile base64 data URL yollar, backend R2'ye kaydeder,
// public URL döner. Mobile bu URL'i listings.photos'a atar (base64 yerine).
//
// Rate limit: 60 upload / 5 dk / kullanıcı. Foto çekim yavaş, spam olası değil.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../auth/middleware');
const storage = require('../services/storage');

const router = express.Router();

// Rate limit — kullanıcı başına
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads', message: 'Çok fazla foto yükleme, biraz bekle.' },
});

// Maksimum foto boyutu (base64 encoded) — 8MB
// Mobile'da zaten expo-image-manipulator ile küçültülüyor, 8MB üst limit.
const MAX_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * POST /uploads/photo
 * Body: { dataUrl: "data:image/jpeg;base64,..." }
 * Response: { url: "https://pub-XXX.r2.dev/listings/.../abc.jpg" }
 */
router.post('/photo', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    if (!storage.isReady()) {
      return res.status(503).json({ error: 'storage_unavailable', message: 'Foto depolama şu anda hazır değil.' });
    }

    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'missing_dataUrl' });
    }
    if (dataUrl.length > MAX_SIZE_BYTES) {
      return res.status(413).json({
        error: 'file_too_large',
        message: 'Foto çok büyük. En fazla ~6MB olabilir (mobile app zaten küçültüyor).',
      });
    }

    const parsed = storage.parseDataUrl(dataUrl);
    if (!parsed) {
      return res.status(400).json({
        error: 'invalid_dataUrl',
        message: 'Geçersiz format. Beklenen: data:image/(jpeg|png|webp);base64,...',
      });
    }

    const url = await storage.uploadPhoto(parsed.buffer, parsed.contentType, {
      userId: req.userId,
      prefix: 'listings',
    });

    console.log(`[uploads] user=${req.userId} → ${url} (${(parsed.buffer.length / 1024).toFixed(1)}KB)`);
    res.status(201).json({ url });
  } catch (err) {
    console.error('[uploads] fail:', err.message);
    next(err);
  }
});

module.exports = router;
