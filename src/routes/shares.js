// İlan paylaşım linkleri — dış paylaşım (WhatsApp vs.) için tokenlı system.
//
// Akış:
//   1. Mobile: POST /listings/:id/share  → token + full share URL döner
//   2. Kullanıcı WhatsApp'a linki yollar: https://api.abadan.com.tr/i/<token>
//   3. Arkadaş linke tıklar → GET /i/<token> → HTML preview sayfası (1 foto + başlık + açıklama)
//       - view_count += 1
//       - Open Graph meta tag'leri ile WhatsApp preview görseli güzel görünür
//       - Uygulama indirme CTA + deep link
//   4. Arkadaş uygulamayı indirip kayıt olurken share_token gönderirse:
//       - signup_count += 1
//       - users.referred_by_share_id set edilir

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// Token üretimi — 16 karakter URL-safe
function generateToken() {
  return crypto.randomBytes(12).toString('base64url'); // ~16 karakter
}

// POST /listings/:id/share — kullanıcının ilanı için yeni share token üret veya mevcudu dön
router.post('/listings/:id/share', requireAuth, async (req, res, next) => {
  try {
    // Sahiplik kontrolü — sadece ilan sahibi paylaşım linki üretebilir
    const own = await pool.query(
      `SELECT id FROM listings WHERE id = $1 AND user_id = $2 AND admin_removed_at IS NULL`,
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'not_found_or_not_owner' });

    // Mevcut bir aktif link varsa yeniden kullan (spam oluşumunu engeller)
    const existing = await pool.query(
      `SELECT id, token FROM listing_shares
       WHERE listing_id = $1 AND user_id = $2
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.userId]
    );

    let token, shareId;
    if (existing.rows.length > 0) {
      token = existing.rows[0].token;
      shareId = existing.rows[0].id;
    } else {
      token = generateToken();
      const ins = await pool.query(
        `INSERT INTO listing_shares (listing_id, user_id, token)
         VALUES ($1, $2, $3) RETURNING id`,
        [req.params.id, req.userId, token]
      );
      shareId = ins.rows[0].id;
    }

    const baseUrl = process.env.PUBLIC_BASE_URL || `https://${req.get('host')}`;
    res.json({
      share_id: shareId,
      token,
      url: `${baseUrl}/i/${token}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /shares/:token — mobile için JSON (deep link akışı sonrası ilanı çözmek için)
router.get('/shares/:token', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.listing_id, s.user_id AS shared_by_user_id,
              l.title, l.admin_removed_at, l.status
       FROM listing_shares s
       JOIN listings l ON l.id = s.listing_id
       WHERE s.token = $1`,
      [req.params.token]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'token_not_found' });
    const s = r.rows[0];
    if (s.admin_removed_at || s.status !== 'active') {
      return res.status(410).json({ error: 'listing_not_available' });
    }

    // View count artır (mobile'dan da gelirse burdan sayılır) — bot değilse
    const ua = req.headers['user-agent'] || '';
    if (!isBot(ua)) {
      await pool.query(
        `UPDATE listing_shares SET view_count = view_count + 1, last_viewed_at = now() WHERE token = $1`,
        [req.params.token]
      );
    }

    res.json({
      share_id: s.id,
      listing_id: s.listing_id,
      title: s.title,
    });
  } catch (err) {
    next(err);
  }
});

// Bot / crawler tespiti — WhatsApp, Facebook, Twitter, Slack, LinkedIn, Google, Bing gibi
// preview crawler'ları view sayacına dahil edilmez. Aksi halde her paylaşımda 3-5 fake view olur.
const BOT_UA_REGEX = /(bot|crawler|spider|whatsapp|facebookexternalhit|twitterbot|slackbot|linkedinbot|discordbot|telegrambot|skypeuripreview|googleimageproxy|applebot|bingpreview|duckduckbot|yandeximages|preview|scrape|http-client|curl|wget|node-fetch|axios|python-requests|okhttp|java|go-http-client)/i;
function isBot(userAgent) {
  if (!userAgent) return true; // UA yoksa büyük ihtimalle bot
  return BOT_UA_REGEX.test(userAgent);
}

// GET /i/:token — public HTML preview sayfası (WhatsApp'ta güzel görünsün diye OG meta ile)
router.get('/i/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.listing_id, s.token,
              l.title, l.description, l.price, l.currency, l.location_city,
              l.admin_removed_at, l.status,
              REGEXP_REPLACE(COALESCE(u.display_name, ''), '^\\[DEMO\\] ', '') AS seller_name,
              (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p
               WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover
       FROM listing_shares s
       JOIN listings l ON l.id = s.listing_id
       LEFT JOIN users u ON u.id = l.user_id
       WHERE s.token = $1`,
      [req.params.token]
    );

    // View count artır — SADECE gerçek kullanıcı ziyareti için (bot preview'ları hariç)
    const ua = req.headers['user-agent'] || '';
    const isRealVisitor = !isBot(ua);
    if (r.rows.length > 0 && isRealVisitor) {
      pool.query(
        `UPDATE listing_shares SET view_count = view_count + 1, last_viewed_at = now() WHERE token = $1`,
        [req.params.token]
      ).catch(() => {});
    }
    console.log(`[share] view token=${req.params.token} bot=${!isRealVisitor} ua="${ua.slice(0, 60)}"`);

    const notFound = r.rows.length === 0 || r.rows[0].admin_removed_at || r.rows[0].status !== 'active';
    const listing = r.rows[0];
    const html = notFound ? renderNotFoundHTML() : renderPreviewHTML(listing, req.params.token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // Google'a düşmesin
    res.status(notFound ? 410 : 200).send(html);
  } catch (err) {
    console.error('[i/:token] error:', err.message);
    res.status(500).send('Server error');
  }
});

// GET /i/:token/cover — kapak fotoğrafını public HTTPS image olarak serve eder
// WhatsApp/Facebook og:image bunu fetch edebilsin diye base64 data URL'i decode edip Image döner.
router.get('/i/:token/cover', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COALESCE(p.thumb_url, p.url) AS cover
       FROM listing_shares s
       JOIN listing_photos p ON p.listing_id = s.listing_id
       WHERE s.token = $1
       ORDER BY p.ordering ASC
       LIMIT 1`,
      [req.params.token]
    );
    if (r.rows.length === 0 || !r.rows[0].cover) return res.status(404).end();
    const cover = r.rows[0].cover;

    // Base64 data URL ise (data:image/jpeg;base64,...) → decode + binary olarak dön
    const m = String(cover).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (m) {
      const buffer = Buffer.from(m[2], 'base64');
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 1 hafta cache
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }
    // Zaten HTTPS URL ise → 302 redirect
    if (/^https?:\/\//i.test(cover)) return res.redirect(cover);
    return res.status(404).end();
  } catch (err) {
    console.error('[/i/:token/cover]', err.message);
    res.status(500).end();
  }
});

// ─── HTML template'ler ───

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPreviewHTML(l, token) {
  const priceStr = Number(l.price) === 0
    ? 'ÜCRETSİZ'
    : Number(l.price).toLocaleString('tr-TR') + ' ₺';
  const shortDesc = (l.description || '').slice(0, 400);
  const title = escapeHtml(l.title);
  const desc = escapeHtml(shortDesc);
  const cover = l.cover || '';
  const city = escapeHtml(l.location_city || '');
  const sellerName = escapeHtml(l.seller_name || 'Abadan Kullanıcısı');
  const sellerInitial = (l.seller_name || '?').charAt(0).toUpperCase();
  // Kapak URL: her zaman public HTTPS endpoint (base64 ise decode, URL ise redirect)
  const baseUrlForCover = process.env.PUBLIC_BASE_URL || 'https://api.abadan.com.tr';
  const coverPublicUrl = cover ? `${baseUrlForCover}/i/${token}/cover` : '';
  const shareUrl = (process.env.PUBLIC_BASE_URL || 'https://api.abadan.com.tr') + '/i/' + token;

  // App Store / Play Store link'leri
  const iosUrl = process.env.IOS_APP_URL || 'https://apps.apple.com/tr/app/abadan/id6776988596';
  const androidUrl = process.env.ANDROID_APP_URL || 'https://play.google.com/store/apps/details?id=com.abadan.app';

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${title} - Abadan</title>

  <!-- Open Graph — WhatsApp/Facebook preview için -->
  <meta property="og:type" content="product" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${priceStr}${city ? ' · ' + city : ''} · ${desc.slice(0, 100)}" />
  ${coverPublicUrl ? `
  <meta property="og:image" content="${coverPublicUrl}" />
  <meta property="og:image:secure_url" content="${coverPublicUrl}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="800" />
  <meta property="og:image:height" content="600" />
  <meta property="og:image:alt" content="${title}" />
  ` : ''}
  <meta property="og:url" content="${shareUrl}" />
  <meta property="og:site_name" content="Abadan" />
  <meta property="og:locale" content="tr_TR" />

  <!-- Twitter card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${priceStr}${city ? ' · ' + city : ''}" />
  ${coverPublicUrl ? `<meta name="twitter:image" content="${coverPublicUrl}" />` : ''}

  <!-- Klasik image_src (bazı platformlar) -->
  ${coverPublicUrl ? `<link rel="image_src" href="${coverPublicUrl}" />` : ''}

  <!-- iOS App Universal Link -->
  <meta name="apple-itunes-app" content="app-id=6776988596, app-argument=${shareUrl}">

  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231F4E79'/><text x='50' y='68' text-anchor='middle' font-size='60' fill='white' font-family='sans-serif' font-weight='bold'>A</text></svg>" />

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      min-height: 100vh;
    }
    .container { max-width: 460px; margin: 0 auto; background: white; min-height: 100vh; }
    .header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; background: #1F4E79; color: white;
    }
    .logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: white; color: #1F4E79;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; font-weight: 800;
    }
    .brand-name { font-weight: 700; font-size: 15px; }
    .cover {
      width: 100%; max-height: 500px; background: #f1f5f9;
      object-fit: contain; display: block;
    }
    .cover-empty {
      width: 100%; aspect-ratio: 4/3; background: #e2e8f0;
      display: flex; align-items: center; justify-content: center;
      font-size: 64px; color: #94a3b8;
    }
    .content { padding: 20px 16px; }
    .title { font-size: 20px; font-weight: 700; line-height: 1.3; margin-bottom: 8px; }
    .meta-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .price {
      font-size: 22px; font-weight: 800; color: #1F4E79;
    }
    .price-free { color: #16a34a; }
    .city {
      font-size: 13px; color: #64748b;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .seller {
      display: flex; align-items: center; gap: 10px;
      padding: 12px; background: #f1f5f9; border-radius: 12px; margin-bottom: 16px;
    }
    .seller-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: #1F4E79; color: white;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 18px;
    }
    .seller-name { font-size: 14px; font-weight: 600; }
    .seller-hint { font-size: 12px; color: #64748b; margin-top: 2px; }
    .description {
      font-size: 14px; line-height: 1.5; white-space: pre-wrap;
      color: #334155; padding: 12px 0; border-top: 1px solid #e2e8f0;
      border-bottom: 1px solid #e2e8f0; margin-bottom: 20px;
    }
    .cta-box {
      background: linear-gradient(135deg, #1F4E79, #2d6bad);
      color: white; padding: 24px 16px; border-radius: 16px;
      text-align: center; margin-bottom: 16px;
    }
    .cta-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
    .cta-desc { font-size: 13px; opacity: 0.9; margin-bottom: 16px; line-height: 1.4; }
    .btn {
      display: inline-block; padding: 14px 20px; border-radius: 12px;
      font-weight: 700; text-decoration: none; font-size: 15px;
      transition: transform 0.15s;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: white; color: #1F4E79; }
    .btn-secondary {
      background: rgba(255,255,255,0.15); color: white;
      border: 1.5px solid rgba(255,255,255,0.4);
    }
    .store-row { display: flex; gap: 10px; justify-content: center; margin-top: 8px; }
    .store-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 14px; background: white; color: #0f172a;
      border-radius: 10px; text-decoration: none;
      font-size: 13px; font-weight: 600;
    }
    .footer {
      text-align: center; padding: 20px 16px 32px; color: #94a3b8; font-size: 12px;
    }
    .footer a { color: #64748b; text-decoration: none; }
    @media (min-width: 500px) {
      .container { margin: 20px auto; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); min-height: auto; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">A</div>
      <div class="brand-name">Abadan</div>
    </div>

    ${coverPublicUrl
      ? `<img class="cover" src="${coverPublicUrl}" alt="${title}" />`
      : '<div class="cover-empty">📦</div>'}

    <div class="content">
      <h1 class="title">${title}</h1>
      <div class="meta-row">
        <div class="price ${Number(l.price) === 0 ? 'price-free' : ''}">${priceStr}</div>
        ${city ? `<div class="city">📍 ${city}</div>` : ''}
      </div>

      <div class="seller">
        <div class="seller-avatar">${escapeHtml(sellerInitial)}</div>
        <div>
          <div class="seller-name">${sellerName}</div>
          <div class="seller-hint">Mesaj göndermek için uygulamaya kayıt ol</div>
        </div>
      </div>

      ${desc ? `<div class="description">${desc}</div>` : ''}

      <div class="cta-box">
        <div class="cta-title">Bu ilanla ilgileniyor musun?</div>
        <div class="cta-desc">Abadan'a kayıt ol, satıcıyla direkt mesajlaş.<br />Rehberdeki tanıdıklarınla güvenli alışveriş.</div>
        <div class="store-row">
          <a href="${iosUrl}" class="store-badge">📱 App Store</a>
          <a href="${androidUrl}" class="store-badge">▶️ Google Play</a>
        </div>
      </div>
    </div>

    <div class="footer">
      <a href="https://abadan.com.tr">abadan.com.tr</a>
    </div>
  </div>

  <script>
    // Auto deep link (iOS Universal Link + Android intent)
    // Kullanıcı zaten Abadan yüklüyse app'i açar; değilse store'a gider (yukarıdaki butonlar via meta)
    (function() {
      var ua = navigator.userAgent.toLowerCase();
      var isMobile = /iphone|ipad|android/.test(ua);
      if (!isMobile) return;
      // Universal Link — iOS otomatik yakalar; Android için intent scheme
      // (Şu an sadece store butonları, otomatik yönlendirme kullanıcıyı şaşırtabilir)
    })();
  </script>
</body>
</html>`;
}

function renderNotFoundHTML() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>İlan bulunamadı - Abadan</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f8fafc; padding: 20px;
    }
    .card {
      max-width: 400px; background: white; padding: 40px 30px;
      border-radius: 16px; text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #0f172a; margin-bottom: 8px; }
    p { color: #64748b; font-size: 14px; line-height: 1.5; }
    a { color: #1F4E79; font-weight: 600; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">😔</div>
    <h1>İlan artık mevcut değil</h1>
    <p>Bu ilan silinmiş veya satılmış olabilir.<br /><br /><a href="https://abadan.com.tr">Abadan'ı incele</a></p>
  </div>
</body>
</html>`;
}

module.exports = router;
