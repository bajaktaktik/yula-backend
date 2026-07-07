// SMS gönderim servisi. NetGSM (Türkiye) ve Twilio destekli.
// Her gönderim sms_log tablosuna kaydedilir (phone maskeli, PII korumalı).
const axios = require('axios');
const config = require('../config');
const pool = require('../db/pool');

function maskPhone(phone) {
  if (!phone) return '?';
  const s = String(phone);
  if (s.length < 8) return s;
  return s.slice(0, 5) + '*****' + s.slice(-2);
}

async function logSms({ provider, phone, purpose, status, error, duration_ms }) {
  try {
    await pool.query(
      `INSERT INTO sms_log (provider, phone_masked, purpose, status, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [provider, maskPhone(phone), purpose || null, status, error || null, duration_ms || null]
    );
  } catch (e) {
    // Log tablosu yoksa (migration çalışmamış) veya DB hata → gönderimi bozma
    console.error('[sms] log fail:', e.message);
  }
}

async function sendNetgsm(to, text) {
  const params = new URLSearchParams({
    usercode: config.sms.netgsm.usercode,
    password: config.sms.netgsm.password,
    gsmno: to.replace('+', ''),
    message: text,
    msgheader: config.sms.netgsm.header,
  });
  const url = `https://api.netgsm.com.tr/sms/send/get?${params.toString()}`;
  const res = await axios.get(url);
  return res.data;
}

async function sendTwilio(to, text) {
  const twilio = require('twilio')(config.sms.twilio.sid, config.sms.twilio.token);
  return twilio.messages.create({ from: config.sms.twilio.from, to, body: text });
}

async function send(to, text, opts = {}) {
  const purpose = opts.purpose || null;
  // Dev modu VEYA SMS_DEBUG_LOG=1 ise → console'a yaz, SMS gönderme.
  const debugLog = process.env.SMS_DEBUG_LOG === '1' || process.env.SMS_DEBUG_LOG === 'true';
  if (config.env !== 'production' || debugLog) {
    console.log(`[SMS DEV] ${to}: ${text}`);
    await logSms({ provider: 'dev', phone: to, purpose, status: 'sent' });
    return { dev: true };
  }

  const provider = config.sms.provider === 'twilio' ? 'twilio' : 'netgsm';
  const start = Date.now();
  try {
    const result = provider === 'twilio' ? await sendTwilio(to, text) : await sendNetgsm(to, text);
    await logSms({ provider, phone: to, purpose, status: 'sent', duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    await logSms({
      provider,
      phone: to,
      purpose,
      status: 'failed',
      error: err?.message?.slice(0, 300),
      duration_ms: Date.now() - start,
    });
    throw err;
  }
}

module.exports = { send };
