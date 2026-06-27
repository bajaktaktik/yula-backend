// Şikayet endpoint'i — Apple Guideline 1.2 User-Generated Content gereği.
// Kullanıcılar uygunsuz ilan, mesaj veya kullanıcı davranışlarını şikayet eder.
// Moderasyon ekibi 24 saat içinde inceler.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

const reportSchema = Joi.object({
  targetType: Joi.string().valid('listing', 'message', 'user').required(),
  targetId: Joi.string().uuid().required(),
  reason: Joi.string().min(3).max(500).required(),
});

// POST /reports — yeni şikayet
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = reportSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Aynı kullanıcı aynı hedefi son 1 gün içinde tekrar şikayet etmesini önle
    const dup = await pool.query(
      `SELECT id FROM reports
       WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3
         AND created_at > now() - interval '1 day'`,
      [req.userId, value.targetType, value.targetId]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({
        error: 'already_reported',
        message: 'Bu içeriği zaten son 24 saatte şikayet etmişsin. İncelemedeyiz.',
      });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [req.userId, value.targetType, value.targetId, value.reason]
    );

    console.log(`[report] yeni: ${value.targetType}/${value.targetId} by user=${req.userId}`);

    res.status(201).json({
      id: ins.rows[0].id,
      created_at: ins.rows[0].created_at,
      message: 'Şikayetin alındı. 24 saat içinde inceleyeceğiz.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
