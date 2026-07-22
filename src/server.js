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
const reportRoutes = require('./routes/reports');
const blockRoutes = require('./routes/blocks');
const adminRoutes = require('./routes/admin');
const sharesRoutes = require('./routes/shares');
const requestsRoutes = require('./routes/requests');
const { setupChat } = require('./sockets/chat');

const app = express();
// Railway / Netlify gibi reverse-proxy arkasında çalışıyoruz.
// trust proxy = 1 → X-Forwarded-For header'ı tek hop için güvenilir kabul edilir.
// Bu olmadan express-rate-limit ValidationError atıyor.
app.set('trust proxy', 1);
// ETag header'ı kapat. iOS URLCache If-None-Match yolluyor, backend 304 dönüyor,
// axios default validateStatus 304'ü hata sayıyor → mobile spinner takılıyor.
// Tutarlı 200 + body için etag'i devre dışı bırak (bandwidth küçük, UX kritik).
app.set('etag', false);
app.use(helmet());
// NOT: compression() middleware geçici olarak devre dışı.
// React Native axios bazı build'lerde gzip response'larda timeout/reject yaşıyor.
// /healthz küçük olduğu için sorunsuz, ama büyük response'lar (listings) mobile'da fail.
// app.use(compression());
app.use(cors());
// Fotoğraf base64 data URL'leri büyük olabilir → limit yüksek
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

// API response time izleme — her request kayıt altına alınır (in-memory ring buffer)
const apiMetrics = require('./services/api-metrics');
app.use(apiMetrics.middleware);

// Genel rate limit
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Public /stats — website hero'da gösterilen istatistikler.
// Auth gerektirmez, 5 dakika in-memory cache ile Railway'de DB yükü minimal.
// Metrikler: kayıtlı kullanıcı, potansiyel erişim (rehberlerdeki henüz kayıtsız kişiler), toplam ilan.
const pool = require('./db/pool');
let publicStatsCache = { data: null, ts: 0 };
const PUBLIC_STATS_TTL = 5 * 60 * 1000; // 5 dakika

app.get('/public/stats', async (req, res) => {
  try {
    // Cache hit
    if (publicStatsCache.data && Date.now() - publicStatsCache.ts < PUBLIC_STATS_TTL) {
      return res.json(publicStatsCache.data);
    }
    const r = await pool.query(`
      SELECT
        -- Kayıtlı aktif kullanıcı
        (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users,
        -- Potansiyel erişim: rehberlerde bulunan ama henüz kayıtsız unique kişi sayısı
        -- user_contacts.contact_phone_hash → unique count, users.phone_hash'e denk olanlar hariç
        (SELECT COUNT(DISTINCT uc.contact_phone_hash)::int
         FROM user_contacts uc
         WHERE NOT EXISTS (
           SELECT 1 FROM users u WHERE u.phone_hash = uc.contact_phone_hash AND u.status = 'active'
         )) AS potential,
        -- Toplam aktif ilan
        (SELECT COUNT(*)::int FROM listings WHERE status = 'active') AS listings
    `);
    publicStatsCache = { data: r.rows[0], ts: Date.now() };
    // 5 dk client-side cache
    res.set('Cache-Control', 'public, max-age=300');
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[public/stats] fail:', err.message);
    // Hata durumunda son cache dön (varsa) — website hero'da hiç sayı olmasın diye
    if (publicStatsCache.data) return res.json(publicStatsCache.data);
    res.status(503).json({ error: 'stats_unavailable' });
  }
});

// Web Admin Paneli (macOS/tarayıcı için) — backend/public/panel/index.html
// GİZLİ URL: ADMIN_PANEL_PATH env değişkeni ile ayarlanır (Railway env).
// Env boşsa varsayılan /panel — ama prod'da MUTLAKA random string ile değiştir.
// Örnek: ADMIN_PANEL_PATH=x9k7m2q3f5 → https://api.abadan.com.tr/x9k7m2q3f5/
const path = require('path');
const rawPanelPath = (process.env.ADMIN_PANEL_PATH || 'panel').trim();
const panelPath = '/' + rawPanelPath.replace(/^\/+|\/+$/g, ''); // /x9k7m2q3f5

// Panel yükleme sırasında CSP'yi gevşet (Tailwind + unpkg CDN erişimi için)
app.use(panelPath, (req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; " +
    "connect-src 'self' https:; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data:;"
  );
  // Arama motorları hiç indexlemesin
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}, express.static(path.join(__dirname, '..', 'public', 'panel'), {
  maxAge: '1h',
  index: 'index.html',
}));
// Trailing slash olmayan istekler için de aç
app.get(panelPath, (req, res) => res.redirect(panelPath + '/'));

// GÜVENLİK — env'de custom path AYARLANDIYSA, eski /panel URL'ini kilitle
if (panelPath !== '/panel') {
  app.get('/panel', (req, res) => res.status(404).end());
  app.get('/panel/*', (req, res) => res.status(404).end());
}
console.log(`[panel] Admin paneli URL: ${panelPath}/`);

// OTP istek limiti (kötüye kullanım önleme)
const otpLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, keyGenerator: (req) => req.body?.phone || req.ip });
app.use('/auth/request-otp', otpLimiter);

// PIN girişi brute-force koruması — hem panel hem mobile için geçerli.
// 5 dakika içinde IP başına max 6 deneme; başarısızlar sayılır, başarılı denemede sayaç sıfırlanır.
// Bir kullanıcı PIN'i unutup birkaç yanlış giriş yapabilir → 6 makul; bot deneyen ise 5 dk beklemek zorunda.
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  keyGenerator: (req) => (req.body?.phone || '') + '|' + req.ip,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'too_many_attempts',
    message: 'Çok fazla hatalı giriş. 5 dakika sonra tekrar dene.',
  },
});
app.use('/auth/login-pin', loginLimiter);

// Bakım modu middleware — admin endpoint'leri + panel + auth hariç normal isteklere 503
// Bakım açık iken mobile app'ler bir maintenance mesajı görebilir
const settingsService = require('./services/settings');
app.use(async (req, res, next) => {
  // Her zaman açık path'ler: healthz, admin paneli, auth (giriş kırılmasın), /admin API'leri
  if (req.path === '/healthz') return next();
  if (req.path.startsWith(panelPath + '/') || req.path === panelPath) return next();
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/admin')) return next();
  if (req.path.startsWith('/i/')) return next(); // public paylaşım linki

  try {
    const info = await settingsService.getMaintenanceInfo();
    if (info?.enabled) {
      return res.status(503).json({
        error: 'maintenance_mode',
        message: info.message || 'Uygulama şu an bakımda. Kısa süre sonra tekrar dene.',
      });
    }
  } catch {}
  next();
});

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
app.use('/reports', reportRoutes);
app.use('/blocks', blockRoutes);
app.use('/admin', adminRoutes);
app.use('/requests', requestsRoutes);
// Share endpoint'leri: /listings/:id/share (auth), /shares/:token (public), /i/:token (public HTML)
app.use('/', sharesRoutes);

// Hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });
setupChat(io);

// Başlangıçta schema migration otomatik çalışır (idempotent — IF NOT EXISTS).
// Tek pool.query(multi-statement) hata atınca tüm batch fail oluyor → her komutu
// AYRI çalıştırıyoruz, hata olunca diğerleri durmaz.
(async () => {
  try {
    const fs = require('fs');
    const path = require('path');
    const pool = require('./db/pool');
    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    // Yorumları temizle, semicolon ile böl
    const statements = sql
      .replace(/--[^\n]*\n/g, '\n')
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let ok = 0, fail = 0;
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
        ok++;
      } catch (e) {
        fail++;
        // İlk 80 karakter komutu logla — hangi komut fail etti görelim
        console.warn(`[migrate] komut fail: ${e.message} → ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...`);
      }
    }
    console.log(`[migrate] tamamlandı: ${ok} OK, ${fail} fail`);

    // ADMIN_USER_IDS env → DB'ye seed (backward compat)
    // İlk deploy'da bu ID'lerin role'lerini admin yapar. Sonra panelden yönetilebilir.
    const seedIds = (process.env.ADMIN_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (seedIds.length > 0) {
      try {
        const r = await pool.query(
          `UPDATE users SET role = 'admin' WHERE id = ANY($1::uuid[]) AND role != 'admin' RETURNING id`,
          [seedIds]
        );
        if (r.rowCount > 0) {
          console.log(`[migrate] admin seed: ${r.rowCount} kullanıcı admin yapıldı`);
        }
      } catch (seedErr) {
        console.error('[migrate] admin seed hatası:', seedErr.message);
      }
    }
  } catch (e) {
    console.error('[migrate] Şema migration hatası:', e.message);
    // Migrate hatası fatal değil — server yine başlasın (eski schema ile çalışır)
  }

  server.listen(config.port, () => {
    console.log(`Abadan API ${config.port} portunda dinliyor (${config.env})`);
  });
})();
