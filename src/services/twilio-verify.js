// Twilio Verify API entegrasyonu.
// Manuel OTP üretimi yerine Twilio'nun managed verify servisini kullanır.
// - Kod üretimi, gönderimi, doğrulaması Twilio'da olur
// - Türkiye için optimize routing (A2P/local sender ID)
// - Rate limiting + brute-force koruması built-in
//
// NOT: Her gönderim sms_log tablosuna kaydedilir — panel'de takip için.

const config = require('../config');
const pool = require('../db/pool');

const SERVICE_SID = process.env.TWILIO_VERIFY_SID;

function maskPhone(phone) {
  if (!phone) return '?';
  const s = String(phone);
  if (s.length < 8) return s;
  return s.slice(0, 5) + '*****' + s.slice(-2);
}

async function logSms({ phone, purpose, status, error, duration_ms }) {
  try {
    await pool.query(
      `INSERT INTO sms_log (provider, phone_masked, purpose, status, error, duration_ms)
       VALUES ('twilio-verify', $1, $2, $3, $4, $5)`,
      [maskPhone(phone), purpose || null, status, error || null, duration_ms || null]
    );
  } catch (e) {
    console.error('[verify] log fail:', e.message);
  }
}

function getClient() {
  if (!config.sms.twilio.sid || !config.sms.twilio.token) {
    throw new Error('Twilio credentials missing');
  }
  return require('twilio')(config.sms.twilio.sid, config.sms.twilio.token);
}

async function startVerification(e164) {
  const start = Date.now();
  try {
    const client = getClient();
    const verification = await client.verify.v2
      .services(SERVICE_SID)
      .verifications
      .create({ to: e164, channel: 'sms', locale: 'tr' });
    await logSms({
      phone: e164,
      purpose: 'otp',
      status: 'sent',
      duration_ms: Date.now() - start,
    });
    return verification.status; // 'pending'
  } catch (err) {
    await logSms({
      phone: e164,
      purpose: 'otp',
      status: 'failed',
      error: err?.message?.slice(0, 300),
      duration_ms: Date.now() - start,
    });
    throw err;
  }
}

async function checkVerification(e164, code) {
  const client = getClient();
  try {
    const check = await client.verify.v2
      .services(SERVICE_SID)
      .verificationChecks
      .create({ to: e164, code });
    return { ok: check.status === 'approved', status: check.status };
  } catch (err) {
    // 60202 — kod yanlış, 20404 — verification bulunamadı/expired
    if (err.code === 20404) return { ok: false, status: 'expired' };
    if (err.code === 60202) return { ok: false, status: 'invalid', maxAttempts: true };
    return { ok: false, status: 'error', error: err.message };
  }
}

function isEnabled() {
  return !!SERVICE_SID;
}

module.exports = { startVerification, checkVerification, isEnabled };
