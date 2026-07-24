// Sohbet REST endpointleri.
// Kullanıcılar bir ilan üzerinden konuşur. Satıcı-alıcı çifti UNIQUE.

const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const graph = require('../services/graph');
const push = require('../services/push');
const messageCrypto = require('../services/messageCrypto');

const router = express.Router();

// GET /conversations  →  kullanıcının tüm sohbetleri (son mesaj sırasında)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id, c.listing_id, c.buyer_id, c.seller_id, c.last_message_at,
         l.title AS listing_title, l.price AS listing_price,
         (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS listing_cover,
         other_u.id AS other_user_id,
         COALESCE(uc.contact_name, other_u.display_name) AS other_name,
         other_u.avatar_url AS other_avatar,
         other_u.ghost_mode AS other_user_ghost,
         -- Karşı taraf ilan sahibi VE ilan onaylı hayaletse → gizli
         (l.ghost_mode = true AND l.ghost_approval_status = 'approved' AND l.user_id = other_u.id) AS other_listing_ghost,
         -- Karşı taraf bu conversation'da hiç mesaj yazmış mı?
         EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = other_u.id) AS other_has_sent,
         (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
         (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_sender_id,
         (SELECT COUNT(*) FROM messages m
            WHERE m.conversation_id = c.id
              AND m.sender_id <> $1
              AND m.read_at IS NULL)::int AS unread_count
       FROM conversations c
       JOIN listings l ON l.id = c.listing_id
       JOIN users other_u ON other_u.id = (CASE WHEN c.buyer_id = $1 THEN c.seller_id ELSE c.buyer_id END)
       LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_phone_hash = other_u.phone_hash
       WHERE (c.buyer_id = $1 OR c.seller_id = $1)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
       ORDER BY c.last_message_at DESC`,
      [req.userId]
    );
    const result = rows.map((r) => {
      // HAYALET: user-level VEYA listing-level, + karşı taraf henüz mesaj yazmamışsa gizle
      const isOtherGhost = !!((r.other_user_ghost || r.other_listing_ghost) && !r.other_has_sent);
      return {
        ...r,
        other_name: isOtherGhost ? null : r.other_name,
        other_avatar: isOtherGhost ? null : r.other_avatar,
        other_is_ghost: isOtherGhost,
        last_message: messageCrypto.decrypt(r.last_message),
        listing_photos: r.listing_cover ? [r.listing_cover] : [],
      };
    });
    res.json({ conversations: result, count: result.length });
  } catch (err) {
    next(err);
  }
});

// POST /conversations  →  ilan için sohbet oluştur veya mevcut olanı döndür
const createSchema = Joi.object({
  listingId: Joi.string().uuid().required(),
  // 2. derece ilanları için opsiyonel: hangi aracı (via) ile mesajlaşacağını belirt.
  // Belirtilmezse alfabetik ilk mutual kullanılır.
  intermediaryId: Joi.string().uuid().optional(),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // ⚡ FAST PATH — mevcut sohbet varsa doğrudan döndür.
    // Network + graph + block kontrolü daha önce bu conversation açılırken yapılmış zaten.
    // Kullanıcı ilan detayından "Mesaj"a bastığında %90 durumda buraya girer.
    // İki türlü mevcut olabilir: (buyer=me) veya (seller=me), listing_id ile.
    if (!value.intermediaryId) {
      const fastCheck = await pool.query(
        `SELECT id, listing_id
         FROM conversations
         WHERE listing_id = $1 AND (buyer_id = $2 OR seller_id = $2)
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT 1`,
        [value.listingId, req.userId]
      );
      if (fastCheck.rows.length > 0) {
        return res.json({ conversation: fastCheck.rows[0] });
      }
    }

    // 1. Listing fetch
    const lres = await pool.query('SELECT id, user_id FROM listings WHERE id = $1', [value.listingId]);
    if (lres.rows.length === 0) return res.status(404).json({ error: 'listing_not_found' });
    const listing = lres.rows[0];
    if (listing.user_id === req.userId) {
      return res.status(400).json({ error: 'cannot_message_own_listing' });
    }

    // 2. Network kontrolü — 1. derece mi kontrol et
    const visibleRes = await pool.query(
      `SELECT 1 FROM user_contacts uc
       JOIN users u ON u.phone_hash = uc.contact_phone_hash
       WHERE uc.user_id = $1 AND u.id = $2 AND u.status = 'active'
       LIMIT 1`,
      [req.userId, listing.user_id]
    );

    // Chat hedefi: 1. derece ise satıcının kendisi;
    // 2. derece ise aracı (via) kullanıcı — kullanıcı doğrudan 3. şahısla konuşmaz
    let chatTargetId = listing.user_id;
    let isSecondDegree = false;
    if (visibleRes.rows.length === 0) {
      // Sadece spesifik satıcı için aracıları çek (hafif) — tüm 2. derece map'i değil
      const intermediaries = await graph.getIntermediariesFor(req.userId, listing.user_id);
      if (intermediaries.length === 0) {
        return res.status(403).json({ error: 'not_in_your_network' });
      }
      if (value.intermediaryId) {
        const chosen = intermediaries.find((i) => i.user_id === value.intermediaryId);
        if (!chosen) return res.status(403).json({ error: 'invalid_intermediary' });
        chatTargetId = chosen.user_id;
      } else {
        // Alfabetik ilk aracı (getIntermediariesFor zaten sıralı döndürür)
        chatTargetId = intermediaries[0].user_id;
      }
      isSecondDegree = true;
    }

    // Block kontrolü hedefe göre yap (aracı block'ta olabilir)
    const blockedRes = await pool.query(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [req.userId, chatTargetId]
    );
    if (blockedRes.rows.length > 0) {
      return res.status(403).json({ error: 'blocked' });
    }

    // Mevcut sohbet varsa döndür (buyer + hedef seller ile)
    const existingRes = await pool.query(
      'SELECT id FROM conversations WHERE listing_id = $1 AND buyer_id = $2 AND seller_id = $3 LIMIT 1',
      [value.listingId, req.userId, chatTargetId]
    );
    if (existingRes.rows.length > 0) {
      return res.json({ conversation: { id: existingRes.rows[0].id, listing_id: value.listingId } });
    }

    // 3. Yeni sohbet — seller_id chatTargetId (2. derece'de aracı user)
    const ins = await pool.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [value.listingId, req.userId, chatTargetId]
    );
    console.log(`[chat] user=${req.userId} → ${chatTargetId} (${isSecondDegree ? '2. derece via' : '1. derece'}) listing=${value.listingId}`);
    res.status(201).json({ conversation: { id: ins.rows[0].id, listing_id: value.listingId } });
  } catch (err) {
    next(err);
  }
});

// GET /conversations/:id/messages  →  sohbet mesajları
router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    // Sohbete erişim kontrolü
    const conv = await pool.query(
      'SELECT id, buyer_id, seller_id, listing_id FROM conversations WHERE id = $1',
      [req.params.id]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const c = conv.rows[0];
    if (c.buyer_id !== req.userId && c.seller_id !== req.userId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows } = await pool.query(
      `SELECT id, sender_id, content, sent_at, read_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY sent_at ASC`,
      [req.params.id]
    );

    // Karşı taraf bilgisi + HAYALET kontrolü
    // Kural: karşı taraf hayalet + bu chat'te hiç mesaj yazmamışsa → adı/avatarı gizle
    // Hayalet iki türlü: (a) user-level ghost_mode (b) ilan-bazlı ghost_mode + karşı taraf ilan sahibi
    const otherId = c.buyer_id === req.userId ? c.seller_id : c.buyer_id;
    const otherInfo = await pool.query(
      `SELECT
         other_u.id,
         COALESCE(uc.contact_name, other_u.display_name) AS name,
         other_u.avatar_url,
         other_u.ghost_mode AS user_ghost,
         -- Karşı taraf ilan sahibiyse VE ilan onaylı hayaletse → gizlenir
         (l.ghost_mode = true AND l.ghost_approval_status = 'approved' AND l.user_id = other_u.id) AS listing_ghost_for_other,
         EXISTS(SELECT 1 FROM messages WHERE conversation_id = $3 AND sender_id = other_u.id) AS has_sent
       FROM users other_u
       LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_phone_hash = other_u.phone_hash
       LEFT JOIN listings l ON l.id = $4
       WHERE other_u.id = $2`,
      [req.userId, otherId, req.params.id, c.listing_id]
    );
    const otherRow = otherInfo.rows[0];
    const otherIsGhostByAnything = otherRow && (otherRow.user_ghost || otherRow.listing_ghost_for_other);
    const isOtherGhost = !!(otherIsGhostByAnything && !otherRow.has_sent);
    const otherPayload = otherRow
      ? {
          id: otherRow.id,
          name: isOtherGhost ? null : otherRow.name,
          avatar_url: isOtherGhost ? null : otherRow.avatar_url,
          is_ghost: isOtherGhost,
        }
      : null;

    // BEN hayalet miyim? (user-level ghost VEYA bu ilan hayaletse + ben ilan sahibiyim)
    // Ve bu chat'te henüz mesaj yazmamış mıyım? Öyleyse cevap yazınca kimliğim iletilir → uyarı göster
    const meRes = await pool.query(
      `SELECT
         u.ghost_mode AS user_ghost,
         (l.ghost_mode = true AND l.user_id = $1 AND l.ghost_approval_status = 'approved') AS listing_ghost_and_mine,
         EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id = $3 AND m.sender_id = $1) AS me_has_sent
       FROM users u, listings l
       WHERE u.id = $1 AND l.id = $2`,
      [req.userId, c.listing_id, req.params.id]
    );
    const meGhostRow = meRes.rows[0];
    const meIsGhost = meGhostRow && (meGhostRow.user_ghost || meGhostRow.listing_ghost_and_mine);
    const meHasSent = meGhostRow && meGhostRow.me_has_sent;
    const showSelfGhostWarning = !!(meIsGhost && !meHasSent);

    // İlan bilgisi
    const listing = await pool.query(
      `SELECT id, title, price, is_negotiable,
              (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo
       FROM listings l WHERE id = $1`,
      [c.listing_id]
    );

    // Karşı tarafın gönderdiği mesajları okundu olarak işaretle
    await pool.query(
      `UPDATE messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
      [req.params.id, req.userId]
    );

    // ChatScreen photos[0] kullanıyor → backward-compat array sun
    const listingData = listing.rows[0]
      ? { ...listing.rows[0], photos: listing.rows[0].cover_photo ? [listing.rows[0].cover_photo] : [] }
      : null;
    res.json({
      messages: messageCrypto.decryptRows(rows, 'content'),
      conversation: { id: c.id, buyer_id: c.buyer_id, seller_id: c.seller_id },
      other: otherPayload,
      // Karşı taraf hayalet + ben henüz cevap yazmadım → o gizli, bilgi banner göster
      show_ghost_warning: isOtherGhost,
      // BEN hayalet + henüz mesaj yazmadım → cevap yazarsam kimliğim iletilir → uyarı
      show_self_ghost_warning: showSelfGhostWarning,
      listing: listingData,
    });
  } catch (err) {
    next(err);
  }
});

// POST /conversations/:id/messages  →  yeni mesaj gönder
const msgSchema = Joi.object({
  content: Joi.string().min(1).max(2000).required(),
});

router.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { value, error } = msgSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const conv = await pool.query(
      'SELECT id, buyer_id, seller_id FROM conversations WHERE id = $1',
      [req.params.id]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const c = conv.rows[0];
    if (c.buyer_id !== req.userId && c.seller_id !== req.userId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // At-rest şifreleme: DB'ye şifreli yaz, response'ta düz metin dön
    const ciphertext = messageCrypto.encrypt(value.content);
    const ins = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3) RETURNING id, sent_at`,
      [req.params.id, req.userId, ciphertext]
    );
    await pool.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [req.params.id]);

    res.status(201).json({
      message: {
        id: ins.rows[0].id,
        conversation_id: req.params.id,
        sender_id: req.userId,
        content: value.content,
        sent_at: ins.rows[0].sent_at,
      },
    });

    // Push bildirimi — alıcıya gönder (response döndükten sonra, fire-and-forget)
    const recipientId = c.buyer_id === req.userId ? c.seller_id : c.buyer_id;
    setImmediate(async () => {
      try {
        // Gönderici ismini alıcının rehberindeki ada göre çek
        const meta = await pool.query(
          `SELECT
             COALESCE(uc.contact_name, sender.display_name, 'Abadan kullanıcısı') AS sender_name,
             l.title AS listing_title
           FROM users sender
           LEFT JOIN user_contacts uc
             ON uc.user_id = $1 AND uc.contact_phone_hash = sender.phone_hash
           JOIN conversations c ON c.id = $3
           JOIN listings l ON l.id = c.listing_id
           WHERE sender.id = $2`,
          [recipientId, req.userId, req.params.id]
        );
        const senderName = meta.rows[0]?.sender_name || 'Yeni mesaj';
        const listingTitle = meta.rows[0]?.listing_title || '';
        await push.sendToUser(recipientId, {
          title: senderName,
          body: value.content.length > 100 ? value.content.slice(0, 97) + '…' : value.content,
          data: {
            type: 'new_message',
            conversationId: req.params.id,
            listingTitle,
          },
        });
      } catch (e) {
        console.error('[push] mesaj bildirimi gönderilemedi:', e.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /conversations/:id  →  sadece taraflardan biri silebilir; CASCADE mesajları da siler
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `DELETE FROM conversations
       WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
      [req.params.id, req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
