// OTP — iki yol:
//   1) Twilio Verify API (production önerilen): TWILIO_VERIFY_SID env'de varsa kullanılır
//   2) Manuel SMS + Redis (fallback): trial veya başka sağlayıcılar için
//
// Verify yolunda kod üretimi/doğrulaması Twilio'da; Redis'e dokunulmaz.

const crypto = require('crypto');
const redis = require('../cache/redis');
const sms = require('../services/sms');
const verify = require('../services/twilio-verify');

const OTP_TTL_SECONDS = 600; // 10 dakika
const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 5;

// ---- App Store/Google Play reviewer bypass ----
// Mağaza inceleyicisi (App Store / Play Store reviewer) gerçek SMS alamaz.
// Bu sabit numaralar için SMS gönderilmez ve OTP olarak "REVIEWER_OTP_CODE" sabit kabul edilir.
// Mağaza submission metadata'da bu numara + kod reviewer'a verilir.
// PRODUCTION'DA BU NUMARAYI KIMSEYE PAYLASMA.
const REVIEWER_PHONES = (process.env.REVIEWER_PHONES || '+905555555555')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REVIEWER_OTP_CODE = process.env.REVIEWER_OTP_CODE || '424242';

function isReviewerPhone(e164) {
  return REVIEWER_PHONES.includes(e164);
}

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
}

async function requestOtp(e164) {
  // Reviewer numarası — SMS gönderme, sessizce başarılı dön
  if (isReviewerPhone(e164)) {
    return { sentAt: Date.now(), provider: 'reviewer-bypass' };
  }
  // Önce Verify'a bak
  if (verify.isEnabled()) {
    await verify.startVerification(e164);
    return { sentAt: Date.now(), provider: 'twilio-verify' };
  }
  // Fallback: manuel kod + sms
  const code = generateOtp();
  const key = `otp:${e164}`;
  await redis.set(key, JSON.stringify({ code, attempts: 0 }), { EX: OTP_TTL_SECONDS });
  await sms.send(e164, `Abadan doğrulama kodu: ${code}`, { purpose: 'otp' });
  return { sentAt: Date.now(), provider: 'manual' };
}

async function verifyOtp(e164, code) {
  // Reviewer numarası — sadece sabit kodu kabul et
  if (isReviewerPhone(e164)) {
    if (String(code) === REVIEWER_OTP_CODE) return { ok: true };
    return { ok: false, reason: 'invalid' };
  }
  // Verify enabled ise Twilio'ya sor
  if (verify.isEnabled()) {
    const result = await verify.checkVerification(e164, code);
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.status === 'expired' ? 'expired' : 'invalid' };
  }

  // Fallback: Redis manuel doğrulama
  const key = `otp:${e164}`;
  const raw = await redis.get(key);
  if (!raw) return { ok: false, reason: 'expired' };

  const data = JSON.parse(raw);
  if (data.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (data.code !== String(code)) {
    data.attempts += 1;
    await redis.set(key, JSON.stringify(data), { EX: OTP_TTL_SECONDS });
    return { ok: false, reason: 'invalid' };
  }

  await redis.del(key);
  return { ok: true };
}

module.exports = { requestOtp, verifyOtp };
