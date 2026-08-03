// Mağaza soft-delete cleanup job
// 30 gün önce soft-deleted olan mağazaları hard delete eder + R2 fotoları temizler.
// Server startup'ta setInterval ile çalışır (24 saatte bir).

const pool = require('../db/pool');
const storage = require('./storage');

const RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24 saatte bir

/**
 * Silinmeye hazır mağazaları bul, R2 fotolarını temizle, hard delete.
 * Idempotent — birden fazla çalışmada duplicate cleanup yapmaz.
 */
async function cleanupExpiredStores() {
  try {
    // 30 günden eski soft-deleted mağazalar
    const expiredRes = await pool.query(
      `SELECT id, email FROM stores
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - interval '${RETENTION_DAYS} days'
       ORDER BY deleted_at
       LIMIT 100`  // güvenlik — bir seferde max 100
    );

    if (expiredRes.rows.length === 0) {
      // Log sadece bir şey silinirse — normal koşulda sessiz
      return { cleaned: 0 };
    }

    let cleaned = 0;
    for (const store of expiredRes.rows) {
      try {
        // R2 fotoları topla — ilan fotoları + mağaza logo/cover
        const photoUrls = [];

        // İlan fotoları
        const listingPhotos = await pool.query(
          `SELECT p.url FROM store_listing_photos p
           JOIN store_listings l ON l.id = p.listing_id
           WHERE l.store_id = $1`,
          [store.id]
        );
        photoUrls.push(...listingPhotos.rows.map((r) => r.url));

        // Mağaza logo/cover (opsiyonel — R2 URL ise)
        const profilePhotos = await pool.query(
          'SELECT logo_url, cover_url FROM stores WHERE id = $1',
          [store.id]
        );
        if (profilePhotos.rows[0]) {
          const { logo_url, cover_url } = profilePhotos.rows[0];
          if (logo_url) photoUrls.push(logo_url);
          if (cover_url) photoUrls.push(cover_url);
        }

        // R2 cleanup (async, hata olsa da devam)
        if (photoUrls.length > 0 && storage.cleanupPhotoUrls) {
          await storage.cleanupPhotoUrls(photoUrls, `store ${store.id}`).catch((e) =>
            console.warn(`[store-cleanup] R2 cleanup fail store=${store.id}:`, e.message)
          );
        }

        // Hard delete (CASCADE ile store_listings, store_conversations, store_messages siler)
        await pool.query('DELETE FROM stores WHERE id = $1', [store.id]);

        console.log(`[store-cleanup] HARD DELETE store=${store.id} email=${store.email} (${photoUrls.length} foto R2'den silindi)`);
        cleaned++;
      } catch (err) {
        console.error(`[store-cleanup] fail store=${store.id}:`, err.message);
      }
    }

    return { cleaned };
  } catch (err) {
    console.error('[store-cleanup] job fail:', err.message);
    return { cleaned: 0, error: err.message };
  }
}

let _intervalHandle = null;

function start() {
  if (_intervalHandle) return;  // önceden başlatılmış
  // Startup'tan 5 dk sonra ilk çalıştırma (server ayakta oldu emin ol)
  setTimeout(() => {
    cleanupExpiredStores().then((r) => {
      if (r.cleaned > 0) console.log(`[store-cleanup] boot run: ${r.cleaned} store cleaned`);
    });
  }, 5 * 60 * 1000);

  // Sonra 24 saatte bir
  _intervalHandle = setInterval(() => {
    cleanupExpiredStores().then((r) => {
      if (r.cleaned > 0) console.log(`[store-cleanup] daily run: ${r.cleaned} store cleaned`);
    });
  }, CLEANUP_INTERVAL_MS);
  _intervalHandle.unref();  // process exit'i engellemesin

  console.log(`[store-cleanup] scheduled — retention: ${RETENTION_DAYS} days, interval: 24h`);
}

function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = { start, stop, cleanupExpiredStores };
