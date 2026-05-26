// OTP üretme, kaydetme ve doğrulama. Redis'te tutulur.
const crypto = require('crypto');
const redis = require('../cache/redis');
const sms = require('../services/sms');

const OTP_TTL_SECONDS = 600; // 10 dakika
const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6 haneli, baştaki 0'ları koruyan rastgele kod
  return crypto.randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
}

async function requestOtp(e164) {
  const code = generateOtp();
  const key = `otp:${e164}`;
  await redis.set(key, JSON.stringify({ code, attempts: 0 }), { EX: OTP_TTL_SECONDS });
  // Kısa mesaj — trial'da prefix eklenecek, toplam 160 karakteri geçmesin (tek SMS olsun)
  await sms.send(e164, `Yula kod: ${code}`);
  return { sentAt: Date.now() };
}

async function verifyOtp(e164, code) {
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
