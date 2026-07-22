// Cloudflare R2 (S3-compatible) fotoğraf storage servisi.
// AWS SDK v3 (@aws-sdk/client-s3) — modüler, hafif, güncel.
//
// Kullanım:
//   const storage = require('./services/storage');
//   const url = await storage.uploadPhoto(buffer, 'image/jpeg', { userId });
//   await storage.deletePhoto(url);

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const config = require('../config');

let s3 = null;
let ready = false;

function getClient() {
  if (s3) return s3;
  const { endpoint, accessKey, secretKey, bucket, publicUrl } = config.s3;
  if (!endpoint || !accessKey || !secretKey || !bucket || !publicUrl) {
    console.warn('[storage] R2 config eksik, upload servisi devre dışı. Gereken env: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_PUBLIC_URL');
    return null;
  }
  s3 = new S3Client({
    endpoint,
    region: config.s3.region || 'auto',
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true, // R2 için gerekli
  });
  ready = true;
  console.log('[storage] R2 client hazır (SDK v3), bucket=' + bucket);
  return s3;
}

function isReady() {
  getClient();
  return ready;
}

/**
 * Fotoğraf yükle. Buffer + content-type verirsin, public URL döner.
 * @param {Buffer} buffer - Fotoğraf içeriği
 * @param {string} contentType - 'image/jpeg' | 'image/png' | 'image/webp'
 * @param {object} opts - { userId, listingId?, prefix? }
 * @returns {Promise<string>} Public URL
 */
async function uploadPhoto(buffer, contentType, opts = {}) {
  const client = getClient();
  if (!client) throw new Error('r2_not_configured');

  // Path pattern: listings/{userId}/{timestamp}-{random}.jpg
  const ext = contentTypeToExt(contentType);
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  const prefix = opts.prefix || 'listings';
  const userPart = opts.userId ? `${opts.userId}/` : '';
  const key = `${prefix}/${userPart}${timestamp}-${random}.${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Fotolar sabit — 1 yıl agressive CDN cache
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${config.s3.publicUrl}/${key}`;
}

/**
 * Public URL'den fotoğrafı sil. R2'de dosyayı kaldırır.
 * URL formatı: https://pub-XXX.r2.dev/listings/userId/1234-abc.jpg
 */
async function deletePhoto(url) {
  const client = getClient();
  if (!client) return; // Sessizce geç (silme kritik değil, cron temizler)
  const prefix = config.s3.publicUrl;
  if (!url || !url.startsWith(prefix)) return;
  const key = url.slice(prefix.length + 1); // +1 için "/"
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
  } catch (err) {
    console.warn('[storage] delete fail:', key, err.message);
  }
}

function contentTypeToExt(ct) {
  if (ct === 'image/jpeg' || ct === 'image/jpg') return 'jpg';
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  return 'jpg'; // default fallback
}

/**
 * Base64 data URL'den buffer çıkar. Mobile'dan gelen "data:image/jpeg;base64,..." formatı.
 * @returns {{ buffer: Buffer, contentType: string } | null}
 */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const buffer = Buffer.from(match[2], 'base64');
  return { buffer, contentType };
}

/**
 * URL listesini R2'den arka planda topluca temizle. Fire-and-forget.
 * DB DELETE'ten ÖNCE URL'leri toplayıp bu fonksiyona vermek gerekir
 * (listing_photos cascade ile silinirse URL'ler kaybolur).
 *
 * Kullanım:
 *   const { rows } = await pool.query('SELECT url, thumb_url FROM listing_photos WHERE listing_id = $1', [id]);
 *   const urls = rows.flatMap(r => [r.url, r.thumb_url]).filter(Boolean);
 *   await pool.query('DELETE FROM listings WHERE id = $1', [id]);
 *   storage.cleanupPhotoUrls(urls, `listing ${id}`);
 */
function cleanupPhotoUrls(urls, contextLabel = '') {
  if (!Array.isArray(urls) || urls.length === 0) return;
  (async () => {
    let ok = 0;
    for (const url of urls) {
      try {
        await deletePhoto(url);
        ok++;
      } catch (e) {
        console.warn('[storage] cleanup fail for', url, e.message);
      }
    }
    console.log(`[storage] R2 cleanup: ${ok}/${urls.length} foto silindi${contextLabel ? ' (' + contextLabel + ')' : ''}`);
  })();
}

module.exports = {
  isReady,
  uploadPhoto,
  deletePhoto,
  parseDataUrl,
  cleanupPhotoUrls,
};
