// Twilio Verify API entegrasyonu.
// Manuel OTP üretimi yerine Twilio'nun managed verify servisini kullanır.
// - Kod üretimi, gönderimi, doğrulaması Twilio'da olur
// - Türkiye için optimize routing (A2P/local sender ID)
// - Rate limiting + brute-force koruması built-in

const config = require('../config');

const SERVICE_SID = process.env.TWILIO_VERIFY_SID;

function getClient() {
  if (!config.sms.twilio.sid || !config.sms.twilio.token) {
    throw new Error('Twilio credentials missing');
  }
  return require('twilio')(config.sms.twilio.sid, config.sms.twilio.token);
}

async function startVerification(e164) {
  const client = getClient();
  const verification = await client.verify.v2
    .services(SERVICE_SID)
    .verifications
    .create({ to: e164, channel: 'sms', locale: 'tr' });
  return verification.status; // 'pending'
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
