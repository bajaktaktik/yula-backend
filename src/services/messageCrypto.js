// Mesaj içeriği için AES-256-GCM at-rest şifreleme.
//
// Tasarım:
//   - Anahtar:   MESSAGE_ENCRYPTION_KEY env'den 32 byte (64 hex char) okunur.
//                Yoksa şifreleme PAS GEÇİLİR — encrypt input'u olduğu gibi
//                döner; decrypt input'u olduğu gibi döner. Bu, lokal geliştirme
//                ve eski mesajların (plaintext) bozulmadan görünmesi için.
//   - Format:    "v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
//                Tüm yeni mesajlar bu prefix ile yazılır.
//   - Okumada:   String "v1:" ile başlıyorsa AES-GCM ile çöz, başlamıyorsa
//                eski plaintext kabul et ve olduğu gibi döndür.
//   - Avantaj:   Migration gerektirmez; eski mesajlar okunur, yeni mesajlar
//                ileride otomatik şifrelenir.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM önerilen
const PREFIX = 'v1:';

function getKey() {
  const hex = process.env.MESSAGE_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    console.warn('[messageCrypto] MESSAGE_ENCRYPTION_KEY 64 hex karakter olmalı; şifreleme devre dışı.');
    return null;
  }
  return Buffer.from(hex, 'hex');
}

function isEnabled() {
  return getKey() !== null;
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) return plaintext; // şifreleme yok → düz metin
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext;

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return stored;
  // Eski (şifrelenmemiş) mesajlar — olduğu gibi döndür
  if (!stored.startsWith(PREFIX)) return stored;

  const key = getKey();
  if (!key) {
    // Anahtar yoksa ama mesaj şifreli — çözemeyiz, kullanıcıya placeholder göster
    return '[mesaj çözülemedi]';
  }

  try {
    const parts = stored.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return '[bozuk mesaj]';
    const [ivHex, tagHex, ctHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    console.error('[messageCrypto] decrypt hatası:', err.message);
    return '[mesaj çözülemedi]';
  }
}

// Yardımcı: bir mesaj dizisinde content alanını yerinde çöz
function decryptRows(rows, field = 'content') {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => ({ ...r, [field]: decrypt(r[field]) }));
}

module.exports = { encrypt, decrypt, decryptRows, isEnabled };
