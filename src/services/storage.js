// Cloudflare R2 (S3-compatible) fotoğraf storage servisi.
// aws-sdk v2 kullanıyoruz (package.json'da hazır zaten).
//
// Kullanım:
//   const storage = require('./services/storage');
//   const url = await storage.uploadPhoto(buffer, 'image/jpeg', { userId, listingId });
//   await storage.deletePhoto(url);

const AWS = require('aws-sdk');
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
  s3 = new AWS.S3({
    endpoint,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    region: config.s3.region || 'auto',
    s3ForcePathStyle: true, // R2 için gerekli
    signatureVersion: 'v4',
  });
  ready = true;
  console.log('[storage] R2 client hazır, bucket=' + bucket);
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
  // ListingId üretilmeden önce upload olabiliyor (yeni ilan akışı) — userId yeter
  const ext = contentTypeToExt(contentType);
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  const prefix = opts.prefix || 'listings';
  const userPart = opts.userId ? `${opts.userId}/` : '';
  const key = `${prefix}/${userPart}${timestamp}-${random}.${ext}`;

  await client.upload({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Fotolar sabit — 1 yıl agressive CDN cache
    CacheControl: 'public, max-age=31536000, immutable',
  }).promise();

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
    await client.deleteObject({
      Bucket: config.s3.bucket,
      Key: key,
    }).promise();
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

module.exports = {
  isReady,
  uploadPhoto,
  deletePhoto,
  parseDataUrl,
};
