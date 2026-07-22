require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '30d',
  },
  phoneHashPepper: process.env.PHONE_HASH_PEPPER,
  sms: {
    provider: process.env.SMS_PROVIDER || 'netgsm',
    netgsm: {
      usercode: process.env.NETGSM_USERCODE,
      password: process.env.NETGSM_PASSWORD,
      header: process.env.NETGSM_HEADER || 'ABADAN',
    },
    twilio: {
      sid: process.env.TWILIO_ACCOUNT_SID,
      token: process.env.TWILIO_AUTH_TOKEN,
      from: process.env.TWILIO_FROM,
    },
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    // Cloudflare R2 sadece şu region değerlerini kabul eder:
    // auto | wnam | enam | weur | eeur | apac | oc
    // AWS region isimleri (eu-central-1 gibi) hata verir. Geçersizse "auto"'ya düş.
    region: (function () {
      const r = (process.env.S3_REGION || '').toLowerCase().trim();
      const valid = ['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'];
      return valid.includes(r) ? r : 'auto';
    })(),
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    bucket: process.env.S3_BUCKET,
    // Fotoğrafların mobile'a gösterileceği public base URL.
    // R2.dev subdomain: https://pub-XXXX.r2.dev
    // İleride custom domain: https://cdn.abadan.com.tr
    publicUrl: process.env.S3_PUBLIC_URL,
  },
  fcmKey: process.env.FCM_SERVER_KEY,
};
