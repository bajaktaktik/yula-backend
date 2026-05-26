// Cinsiyet değişikliği talebi + 3 onay süreci.
// Kurallar:
//  - Kullanıcı M'den F'ye veya F'den M'ye geçmek isterse talep oluşturulur.
//  - Talep, kullanıcının rehberindeki TARGET cinsten 3 kişiye gönderilir.
//  - 3 onay → cinsiyet güncellenir; 1 red → talep reddedilir.
//  - Her oylama bir notifications kaydı oluşturur, oy verince işlem yapılır.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const graph = require('../services/graph');

const router = express.Router();

// GET /gender-change/eligible-approvers?targetGender=female
// Kullanıcının rehberinden hedef cinsten kişileri listele (kullanıcı 3'ünü kendi seçer)
router.get('/eligible-approvers', requireAuth, async (req, res, next) => {
  try {
    const targetGender = String(req.query.targetGender || '');
    if (targetGender !== 'female' && targetGender !== 'male') {
      return res.status(400).json({ error: 'invalid_target_gender' });
    }
    const visible = await graph.getVisibleUserIds(req.userId);
    const ids = [...visible.keys()];
    if (ids.length === 0) return res.json({ approvers: [] });

    // Onaylayıcının rehberindeki ad öncelikli — privacy korunur
    const { rows } = await pool.query(
      `SELECT u.id,
              COALESCE(uc.contact_name, u.display_name, 'Kullanıcı') AS name,
              u.avatar_url
       FROM users u
       LEFT JOIN user_contacts uc ON uc.user_id = $3 AND uc.contact_phone_hash = u.phone_hash
       WHERE u.id = ANY($1::uuid[]) AND u.gender = $2 AND u.id <> $3
       ORDER BY name ASC`,
      [ids, targetGender, req.userId]
    );
    res.json({ approvers: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /gender-change  →  yeni talep oluştur
// approverIds: kullanıcının seçtiği 3 kişi (target gender, rehberinde)
const createSchema = Joi.object({
  targetGender: Joi.string().valid('female', 'male').required(),
  approverIds: Joi.array().items(Joi.string().uuid()).length(3).required(),
});

router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { value, error } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    await client.query('BEGIN');

    // Mevcut cinsiyet
    const me = await client.query('SELECT id, gender FROM users WHERE id = $1', [req.userId]);
    if (me.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user_not_found' });
    }
    const currentGender = me.rows[0].gender;
    if (currentGender === value.targetGender) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'already_that_gender' });
    }
    if (!currentGender) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'set_initial_gender_first' });
    }

    // Mevcut bekleyen talep varsa engelle
    const pending = await client.query(
      `SELECT id FROM gender_change_requests
       WHERE requester_id = $1 AND status = 'pending'`,
      [req.userId]
    );
    if (pending.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'request_already_pending', requestId: pending.rows[0].id });
    }

    // Kullanıcının seçtiği 3 ID'yi doğrula:
    //  1) Hepsi rehberinde olmalı (network)
    //  2) Hepsi target gender olmalı
    //  3) Kendi ID'sini seçemez
    //  4) Tekrar olmamalı
    const uniqueIds = [...new Set(value.approverIds)];
    if (uniqueIds.length !== 3) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'duplicate_approver_ids' });
    }
    if (uniqueIds.includes(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot_pick_self' });
    }
    const visible = await graph.getVisibleUserIds(req.userId);
    const visibleSet = new Set(visible.keys());
    for (const id of uniqueIds) {
      if (!visibleSet.has(id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'approver_not_in_network', approverId: id });
      }
    }
    const eligible = await client.query(
      `SELECT id, display_name FROM users
       WHERE id = ANY($1::uuid[]) AND gender = $2`,
      [uniqueIds, value.targetGender]
    );
    if (eligible.rows.length !== 3) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'approver_gender_mismatch',
        message: `Seçtiğin 3 kişiden ${eligible.rows.length} tanesi ${value.targetGender} cinsiyetinde`,
      });
    }

    // Talep oluştur
    const ins = await client.query(
      `INSERT INTO gender_change_requests (requester_id, current_gender, target_gender)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.userId, currentGender, value.targetGender]
    );
    const requestId = ins.rows[0].id;

    // Seçilen 3 onaylayıcıya bildirim
    for (const v of eligible.rows) {
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'gender_change_request', $2)`,
        [
          v.id,
          JSON.stringify({
            request_id: requestId,
            requester_id: req.userId,
            current_gender: currentGender,
            target_gender: value.targetGender,
          }),
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      requestId,
      voters: eligible.rows.map((r) => ({ id: r.id })), // isim göstermiyoruz mahremiyet için
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /gender-change/mine  →  kullanıcının kendi talebinin durumu
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, current_gender, target_gender, status,
              approvals_needed, approvals_received, rejections_received,
              created_at, resolved_at
       FROM gender_change_requests
       WHERE requester_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.userId]
    );
    res.json({ request: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// POST /gender-change/:id/vote  →  onaylayıcı oy verir
const voteSchema = Joi.object({
  vote: Joi.string().valid('approve', 'reject').required(),
});

router.post('/:id/vote', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { value, error } = voteSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    await client.query('BEGIN');

    // Talebi bul
    const reqRow = await client.query(
      `SELECT id, requester_id, current_gender, target_gender, status,
              approvals_needed, approvals_received, rejections_received
       FROM gender_change_requests WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (reqRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'request_not_found' });
    }
    const r = reqRow.rows[0];
    if (r.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'request_already_resolved', status: r.status });
    }
    if (r.requester_id === req.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot_vote_self' });
    }

    // Oy veren TARGET cinsten olmalı
    const voter = await client.query('SELECT gender FROM users WHERE id = $1', [req.userId]);
    if (voter.rows[0]?.gender !== r.target_gender) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'voter_gender_mismatch' });
    }

    // Oy ekle (idempotent değil — UNIQUE constraint zaten ikinci defayı engeller)
    try {
      await client.query(
        `INSERT INTO gender_change_votes (request_id, voter_id, vote) VALUES ($1, $2, $3)`,
        [r.id, req.userId, value.vote]
      );
    } catch (e) {
      if (e.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'already_voted' });
      }
      throw e;
    }

    // Sayaçları güncelle
    if (value.vote === 'approve') {
      await client.query(
        `UPDATE gender_change_requests SET approvals_received = approvals_received + 1 WHERE id = $1`,
        [r.id]
      );
    } else {
      await client.query(
        `UPDATE gender_change_requests SET rejections_received = rejections_received + 1 WHERE id = $1`,
        [r.id]
      );
    }

    // Yeniden çek (taze sayaçlar için)
    const fresh = await client.query(
      `SELECT status, approvals_needed, approvals_received, rejections_received
       FROM gender_change_requests WHERE id = $1`,
      [r.id]
    );
    const f = fresh.rows[0];

    let resolution = null;
    // Onay eşiği aşıldıysa → ONAY: cinsiyeti güncelle, talebi kapat
    if (f.approvals_received >= f.approvals_needed) {
      await client.query(
        `UPDATE gender_change_requests SET status = 'approved', resolved_at = now() WHERE id = $1`,
        [r.id]
      );
      await client.query(
        `UPDATE users SET gender = $1 WHERE id = $2`,
        [r.target_gender, r.requester_id]
      );
      // İsteyen kullanıcıya bildirim
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'gender_change_approved', $2)`,
        [
          r.requester_id,
          JSON.stringify({
            request_id: r.id,
            target_gender: r.target_gender,
          }),
        ]
      );
      resolution = 'approved';
    }
    // Bir red bile geldi → talep reddedilir
    else if (f.rejections_received >= 1) {
      await client.query(
        `UPDATE gender_change_requests SET status = 'rejected', resolved_at = now() WHERE id = $1`,
        [r.id]
      );
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'gender_change_rejected', $2)`,
        [
          r.requester_id,
          JSON.stringify({
            request_id: r.id,
            target_gender: r.target_gender,
          }),
        ]
      );
      resolution = 'rejected';
    }

    // Oy verilen bildirim listeden tamamen kaldırılsın (sadece okundu işaretleme yerine sil)
    await client.query(
      `DELETE FROM notifications
       WHERE user_id = $1
         AND type = 'gender_change_request'
         AND (payload->>'request_id')::uuid = $2`,
      [req.userId, r.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, resolution, approvals: f.approvals_received, rejections: f.rejections_received });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
