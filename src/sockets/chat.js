// Socket.io tabanlı gerçek zamanlı sohbet (basitleştirilmiş iskelet)
const { verifyAccess } = require('../auth/jwt');
const pool = require('../db/pool');
const graph = require('../services/graph');

function setupChat(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = verifyAccess(token);
      socket.userId = payload.sub;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);

    socket.on('message:send', async ({ conversationId, content }, cb) => {
      try {
        // Sohbet kullanıcıya ait mi?
        const c = await pool.query(
          'SELECT id, buyer_id, seller_id, listing_id FROM conversations WHERE id = $1',
          [conversationId]
        );
        if (c.rows.length === 0) return cb?.({ error: 'not_found' });
        const conv = c.rows[0];
        if (conv.buyer_id !== socket.userId && conv.seller_id !== socket.userId) {
          return cb?.({ error: 'forbidden' });
        }

        // Görünürlük: alıcı ile satıcı birbirinin ağında olmalı
        const visible = await graph.getVisibleUserIds(socket.userId);
        const other = conv.buyer_id === socket.userId ? conv.seller_id : conv.buyer_id;
        if (!visible.has(other)) return cb?.({ error: 'not_in_network' });

        const ins = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)
           RETURNING id, sent_at`,
          [conversationId, socket.userId, content]
        );
        await pool.query(
          'UPDATE conversations SET last_message_at = now() WHERE id = $1',
          [conversationId]
        );

        const msg = {
          id: ins.rows[0].id,
          conversationId,
          senderId: socket.userId,
          content,
          sentAt: ins.rows[0].sent_at,
        };
        io.to(`user:${other}`).emit('message:new', msg);
        io.to(`user:${socket.userId}`).emit('message:new', msg);
        cb?.({ ok: true, message: msg });
      } catch (err) {
        console.error(err);
        cb?.({ error: 'server_error' });
      }
    });
  });
}

module.exports = { setupChat };
