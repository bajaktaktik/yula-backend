// SMS gönderim servisi. NetGSM (Türkiye) ve Twilio destekli.
const axios = require('axios');
const config = require('../config');

async function sendNetgsm(to, text) {
  // NetGSM SOAP/HTTP API'si: https://www.netgsm.com.tr/dokuman/
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

async function send(to, text) {
  // Dev modu VEYA SMS_DEBUG_LOG=1 ise → console'a yaz, SMS gönderme.
  // Production'da Twilio kurulmadan test etmek için: Railway env'e SMS_DEBUG_LOG=1 ekle.
  const debugLog = process.env.SMS_DEBUG_LOG === '1' || process.env.SMS_DEBUG_LOG === 'true';
  if (config.env !== 'production' || debugLog) {
    console.log(`[SMS DEV] ${to}: ${text}`);
    return { dev: true };
  }
  if (config.sms.provider === 'twilio') return sendTwilio(to, text);
  return sendNetgsm(to, text);
}

module.exports = { send };
