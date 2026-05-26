// Telefon numarası işlemleri.
// İstemci zaten E.164 ve SHA-256 uyguluyor. Sunucuda ek olarak HMAC ile
// pepper karıştırıyoruz; böylece DB dump'ı sızsa bile rainbow table saldırısı zorlaşır.

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const config = require('../config');

/**
 * E.164 formatına normalize eder. Türkiye varsayılan ülke.
 */
function normalizePhone(input, defaultCountry = 'TR') {
  if (!input) return null;
  const phone = parsePhoneNumberFromString(String(input), defaultCountry);
  if (!phone || !phone.isValid()) return null;
  return phone.number; // +905321234567 gibi
}

/**
 * E.164 telefon numarasını HMAC-SHA-256 (pepper ile) hashler.
 */
function hashPhone(e164) {
  if (!e164) throw new Error('Geçersiz telefon');
  return crypto
    .createHmac('sha256', config.phoneHashPepper || 'no-pepper-set')
    .update(e164)
    .digest('hex');
}

/**
 * İstemcinin gönderdiği SHA-256 hash'i pepper ile yeniden hashler.
 * Bu sayede istemci bile gerçek numarayı bilse hash'i sunucu pepper'ı olmadan üretemez.
 */
function rehashClientHash(clientSha256Hex) {
  if (!clientSha256Hex) throw new Error('Geçersiz hash');
  return crypto
    .createHmac('sha256', config.phoneHashPepper || 'no-pepper-set')
    .update(clientSha256Hex.toLowerCase())
    .digest('hex');
}

module.exports = { normalizePhone, hashPhone, rehashClientHash };
