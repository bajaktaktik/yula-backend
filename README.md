# Abadan Backend

Rehber tabanlı görünürlüğe sahip ikinci el alışveriş uygulamasının REST + WebSocket API'si.

## Hızlı Başlangıç

```bash
# Bağımlılıklar
npm install

# .env oluştur
cp .env.example .env
# .env dosyasındaki secretleri doldur

# PostgreSQL'i başlat (Docker ile)
docker run -d --name abadan-pg -p 5432:5432 \
  -e POSTGRES_USER=abadan -e POSTGRES_PASSWORD=abadan \
  -e POSTGRES_DB=abadan postgres:16

# Redis
docker run -d --name abadan-redis -p 6379:6379 redis:7

# Şemayı yükle
npm run migrate

# Sunucuyu başlat
npm run dev
```

## Klasör Yapısı

```
src/
├── server.js              # Express + Socket.io giriş noktası
├── config.js              # Ortam değişkenleri
├── db/
│   ├── pool.js            # PostgreSQL bağlantı havuzu
│   ├── migrate.js         # Şemayı kuran script
│   └── schema.sql         # Tüm tablolar
├── cache/
│   └── redis.js           # Redis bağlantısı
├── auth/
│   ├── jwt.js             # Token üret/doğrula
│   ├── otp.js             # OTP üret, gönder, doğrula
│   └── middleware.js      # Auth middleware
├── routes/
│   ├── auth.js            # /auth/* endpointleri
│   ├── users.js           # /users/* endpointleri
│   ├── contacts.js        # /contacts/sync
│   ├── listings.js        # /listings/* (akış filtreli)
│   ├── conversations.js   # /conversations/*
│   └── moderation.js      # /reports, /blocks
├── services/
│   ├── graph.js           # 1./2. derece bağlantı hesaplama
│   ├── sms.js             # NetGSM/Twilio entegrasyonu
│   ├── storage.js         # S3 presigned URL
│   └── push.js            # FCM bildirim
├── sockets/
│   └── chat.js            # Socket.io mesajlaşma
└── utils/
    ├── phone.js           # E.164 normalize + SHA-256 hash
    └── validation.js      # Joi şemaları
```

## Anahtar Endpointler

| Yöntem | Yol | Açıklama |
|--------|-----|----------|
| POST | /auth/request-otp | OTP gönder |
| POST | /auth/verify-otp | OTP doğrula → JWT |
| POST | /contacts/sync | Hashlenmiş rehberi yükle |
| GET  | /listings | Akış (1. ve 2. derece) |
| POST | /listings | İlan oluştur |
| GET  | /listings/:id | İlan detayı |

## Güvenlik

* Telefon numaraları **sunucuda hiçbir zaman ham olarak saklanmaz**.
* İstemci E.164 → SHA-256 hash uygular.
* Sunucu hashlenmiş değere ek olarak server-side pepper uygular: `HMAC-SHA-256(client_hash, PEPPER)`.
* JWT: access 15dk, refresh 30g.
* `helmet` + `cors` + `express-rate-limit` (Redis tabanlı).

## Görünürlük Algoritması

```sql
-- 1. ve 2. derece bağlantılar (PostgreSQL recursive CTE)
WITH RECURSIVE network AS (
  -- 1. derece
  SELECT u.id, 1 AS degree
  FROM user_contacts uc
  JOIN users u ON u.phone_hash = uc.contact_phone_hash
  WHERE uc.user_id = $1
  UNION
  -- 2. derece
  SELECT u2.id, 2 AS degree
  FROM network n
  JOIN user_contacts uc2 ON uc2.user_id = n.id
  JOIN users u2 ON u2.phone_hash = uc2.contact_phone_hash
  WHERE n.degree = 1 AND u2.id <> $1
)
SELECT DISTINCT id, MIN(degree) AS degree FROM network GROUP BY id;
```

Sonuç Redis'te `connections:{user_id}` anahtarıyla 24 saat önbelleğe alınır.
# abadan-backend
