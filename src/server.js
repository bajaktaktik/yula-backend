const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
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
app.use(helmet());
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

server.listen(config.port, () => {
  console.log(`Yula API ${config.port} portunda dinliyor (${config.env})`);
});
