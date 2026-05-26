# Yula Backend → Railway Deploy Rehberi

Yaklaşık 30 dakika. Kredi kartı gerekmez (ilk $5 ücretsiz, ~1-2 ay yeterli).

## 1) GitHub'a yükle

```bash
cd ~/Documents/Claude/Projects/Apk/backend
git init
git add -A
git commit -m "Initial backend deploy"
```

GitHub'da boş bir `yula-backend` (private önerilir) repo aç, sonra:

```bash
git remote add origin git@github.com:KULLANICI/yula-backend.git
git branch -M main
git push -u origin main
```

## 2) Railway projesi

1. https://railway.app → **Login with GitHub**
2. **New Project** → **Deploy from GitHub repo** → `yula-backend`'i seç
3. Railway build başlar — ilk deploy başarısız olabilir (env yok), önemli değil

## 3) PostgreSQL + Redis ekle

- **+ New** → **Database** → **Add PostgreSQL**
- **+ New** → **Database** → **Add Redis**

Her ikisi 30 saniyede hazır olur.

## 4) Backend servisinin env değişkenleri

Backend servisine tıkla → **Variables** sekmesi → **Raw Editor** veya tek tek ekle:

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_ACCESS_SECRET=<openssl rand -hex 32 çıktısı>
JWT_REFRESH_SECRET=<farklı bir openssl rand -hex 32 çıktısı>
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=30d
PHONE_HASH_PEPPER=<başka rastgele uzun string>
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_FROM=+1xxxxxxxxxx
```

> 💡 `${{Postgres.DATABASE_URL}}` referansı yazınca Railway otomatik PG'ye bağlar.
> 💡 Twilio creds yoksa şimdilik boş bırak; OTP gönderim hata verir ama uygulama açılır.

## 5) Public domain

Backend servisi → **Settings** → **Networking** → **Generate Domain**

Örneğin: `yula-backend-production-abcd.up.railway.app`

## 6) DB Migration

Backend servisi → üstte üç nokta menü → **Open in CLI** (veya local `railway` cli):

```bash
# Local'de cli kurmak istersen:
brew install railway
railway login
railway link    # projeyi seç
railway run node src/db/migrate.js
```

VEYA Railway web arayüzünde **Settings → Deploy → Custom Start Command** geçici olarak `node src/db/migrate.js && node src/server.js` yap, bir kere deploy et, sonra geri `node src/server.js` yap.

## 7) Kategorileri seed et

```bash
railway run node scripts/seed-categories-from-xlsx.js
```

`Cat1.xlsx` repo'da olmalı (kontrol et: `git ls-files | grep Cat1`).

## 8) Test kullanıcıları seed et (opsiyonel — gerçek arkadaşlarla testte gerek yok)

```bash
railway run node scripts/reset-and-test-seed.js
```

## 9) Doğrula

Tarayıcıdan: `https://yula-backend-production-abcd.up.railway.app/healthz`

`{"ok":true}` görmelisin.

## 10) Mobil uygulamayı bağla

`~/Documents/Claude/Projects/Apk/mobile/.env`:

```
EXPO_PUBLIC_API_URL=https://yula-backend-production-abcd.up.railway.app
```

Sonra `npx expo start --clear` ile mobil yeniden başlat.
