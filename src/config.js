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
      header: process.env.NETGSM_HEADER || 'YULA',
    },
    twilio: {
      sid: process.env.TWILIO_ACCOUNT_SID,
      token: process.env.TWILIO_AUTH_TOKEN,
      from: process.env.TWILIO_FROM,
    },
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    bucket: process.env.S3_BUCKET,
  },
  fcmKey: process.env.FCM_SERVER_KEY,
};
