const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server: SocketServer } = require('socket.io');
const config = require('./config');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const contactRoutes = require('./routes/contacts');
const listingRoutes = require('./routes/listings');
const categoryRoutes = require('./routes/categories');
const favoriteRoutes = require('./routes/favorites');
const hiddenRoutes = require('./routes/hidden');
const conversationRoutes = require('./routes/conversations');
const notificationRoutes = require('./routes/notifications');
const genderChangeRoutes = require('./routes/gender-change');
const { setupChat } = require('./sockets/chat');

const app = express();
// Railway / Netlify gibi reverse-proxy arkasında çalışıyoruz.
// trust proxy = 1 → X-Forwarded-For header'ı tek hop için güvenilir kabul edilir.
// Bu olmadan express-rate-limit ValidationError atıyor.
app.set('trust proxy', 1);
app.use(helmet());
// NOT: compression() middleware geçici olarak devre dışı.
// React Native axios bazı build'lerde gzip response'larda timeout/reject yaşıyor.
// /healthz küçük olduğu için sorunsuz, ama büyük response'lar (listings) mobile'da fail.
// app.use(compression());
app.use(cors());
// Fotoğraf base64 data URL'leri büyük olabilir → limit yüksek
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

// Genel rate limit
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// OTP istek limiti (kötüye kullanım önleme)
const otpLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, keyGenerator: (req) => req.body?.phone || req.ip });
app.use('/auth/request-otp', otpLimiter);

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/contacts', contactRoutes);
app.use('/listings', listingRoutes);
app.use('/categories', categoryRoutes);
app.use('/favorites', favoriteRoutes);
app.use('/hidden', hiddenRoutes);
app.use('/conversations', conversationRoutes);
app.use('/notifications', notificationRoutes);
app.use('/gender-change', genderChangeRoutes);

// Hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });
setupChat(io);

// Başlangıçta schema migration otomatik çalışır (idempotent — IF NOT EXISTS).
// Yeni column/index ekleyince ayrıca `npm run migrate` çalıştırmaya gerek yok.
(async () => {
  try {
    const fs = require('fs');
    const path = require('path');
    const pool = require('./db/pool');
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[migrate] Şema güncel.');
  } catch (e) {
    console.error('[migrate] Şema migration hatası:', e.message);
    // Migrate hatası fatal değil — server yine başlasın (eski schema ile çalışır)
  }

  server.listen(config.port, () => {
    console.log(`Abadan API ${config.port} portunda dinliyor (${config.env})`);
  });
})();
