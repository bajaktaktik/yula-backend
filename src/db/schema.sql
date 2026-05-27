-- Yula veritabani semasi
-- PostgreSQL 16

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Kullanicilar
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash    TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  bio           TEXT,
  gender        TEXT, -- 'female' | 'male' | NULL
  location_city TEXT, -- varsayilan il (ilanlarda kullanilir)
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash);
-- Migration: mevcut tablolara kolon ekle
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- Kullanicinin rehberi (hashlenmis)
CREATE TABLE IF NOT EXISTS user_contacts (
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_phone_hash   TEXT NOT NULL,
  contact_name         TEXT, -- opsiyonel, kullanicinin verdigi isim
  is_favorite          BOOLEAN NOT NULL DEFAULT FALSE, -- telefon rehberinde "favori" mi
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_phone_hash)
);
CREATE INDEX IF NOT EXISTS idx_user_contacts_hash ON user_contacts(contact_phone_hash);
-- Migration
ALTER TABLE user_contacts ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE;

-- Kategoriler (hiyerarsik)
CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  parent_id  INT REFERENCES categories(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  icon       TEXT,
  ordering   INT NOT NULL DEFAULT 0
);

-- Ilanlar
CREATE TABLE IF NOT EXISTS listings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  category_id           INT REFERENCES categories(id),
  price                 NUMERIC(12,2) NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'TRY',
  location_city         TEXT,
  location_district     TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  restricted_to_gender  TEXT, -- 'female' | 'male' | NULL (herkese acik)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category_id);
-- Migration: mevcut tabloya kolon ekle
ALTER TABLE listings ADD COLUMN IF NOT EXISTS restricted_to_gender TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_negotiable BOOLEAN DEFAULT FALSE;

-- Ilan fotograflari
CREATE TABLE IF NOT EXISTS listing_photos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,        -- tam boy (1000px) base64 — detayda + zoom için
  thumb_url  TEXT,                 -- thumbnail (400px) base64 — listelerde
  ordering   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_listing_photos_listing ON listing_photos(listing_id);
-- Migration
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS thumb_url TEXT;

-- Sohbet
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(listing_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_buyer ON conversations(buyer_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_seller ON conversations(seller_id, last_message_at DESC);

-- Mesajlar
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, sent_at);

-- Favoriler
CREATE TABLE IF NOT EXISTS favorites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

-- Gizlenmis ilanlar (kullanici akistan kaldirdiklarini)
CREATE TABLE IF NOT EXISTS hidden_listings (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

-- Sikayetler
CREATE TABLE IF NOT EXISTS reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  target_listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  detail            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | reviewed | resolved
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engelleme
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Cinsiyet değişikliği talepleri (karşı cinsten 3 onay gerekir)
CREATE TABLE IF NOT EXISTS gender_change_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_gender       TEXT NOT NULL,
  target_gender        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  approvals_needed     INT NOT NULL DEFAULT 3,
  approvals_received   INT NOT NULL DEFAULT 0,
  rejections_received  INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gender_req_user_status ON gender_change_requests(requester_id, status);

-- Onay/red oyları
CREATE TABLE IF NOT EXISTS gender_change_votes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES gender_change_requests(id) ON DELETE CASCADE,
  voter_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote        TEXT NOT NULL,  -- 'approve' | 'reject'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(request_id, voter_id)
);

-- Genel bildirim tablosu (fiyat değişikliği, gelecekte yeni tipler eklenebilir)
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                          -- 'price_change' | gelecekteki türler
  listing_id  UUID REFERENCES listings(id) ON DELETE CASCADE,
  payload     JSONB,                                  -- { old_price, new_price } gibi
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at, created_at DESC);

-- Cihaz tokenlari (push bildirimi icin)
CREATE TABLE IF NOT EXISTS device_tokens (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   TEXT NOT NULL, -- ios | android
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

-- =====================================================================
-- Seed kategoriler (sahibinden.com tarzı, 2 seviyeli hiyerarsi)
-- =====================================================================

-- Üst kategoriler
INSERT INTO categories (name, slug, icon, ordering) VALUES
  ('Elektronik',        'elektronik',       'cpu',      1),
  ('Ev & Yaşam',        'ev-yasam',         'home',     2),
  ('Giyim & Aksesuar',  'giyim-aksesuar',   'shirt',    3),
  ('Anne & Bebek',      'anne-bebek',       'baby',     4),
  ('Hobi & Spor',       'hobi-spor',        'activity', 5),
  ('Vasıta',            'vasita',           'car',      6),
  ('Emlak',             'emlak',            'building', 7),
  ('Diğer',             'diger',            'box',     99)
ON CONFLICT (slug) DO NOTHING;

-- Alt kategoriler (parent_id slug üzerinden bulunur)
INSERT INTO categories (parent_id, name, slug, icon, ordering)
SELECT p.id, v.name, v.slug, v.icon, v.ordering FROM (VALUES
  -- Elektronik
  ('elektronik', 'Telefon & Aksesuar',      'telefon-aksesuar',     'smartphone',  1),
  ('elektronik', 'Bilgisayar & Laptop',     'bilgisayar-laptop',    'laptop',      2),
  ('elektronik', 'Tablet',                  'tablet',               'tablet',      3),
  ('elektronik', 'TV & Ses Sistemi',        'tv-ses-sistemi',       'tv',          4),
  ('elektronik', 'Fotoğraf & Kamera',       'foto-kamera',          'camera',      5),
  ('elektronik', 'Oyun & Konsol',           'oyun-konsol',          'gamepad',     6),
  ('elektronik', 'Beyaz Eşya',              'beyaz-esya',           'refrigerator',7),
  ('elektronik', 'Küçük Ev Aletleri',       'kucuk-ev-aletleri',    'blender',     8),
  ('elektronik', 'Giyilebilir Teknoloji',   'giyilebilir-teknoloji','watch',       9),

  -- Ev & Yaşam
  ('ev-yasam', 'Mobilya',                   'mobilya',              'sofa',        1),
  ('ev-yasam', 'Dekorasyon',                'dekorasyon',           'frame',       2),
  ('ev-yasam', 'Mutfak Eşyaları',           'mutfak',               'utensils',    3),
  ('ev-yasam', 'Aydınlatma',                'aydinlatma',           'lamp',        4),
  ('ev-yasam', 'Ev Tekstili',               'ev-tekstili',          'pillow',      5),
  ('ev-yasam', 'Bahçe & Yapı Market',       'bahce-yapi',           'tool',        6),

  -- Giyim & Aksesuar
  ('giyim-aksesuar', 'Kadın Giyim',         'kadin-giyim',          'dress',       1),
  ('giyim-aksesuar', 'Erkek Giyim',         'erkek-giyim',          'shirt',       2),
  ('giyim-aksesuar', 'Çocuk Giyim',         'cocuk-giyim',          'shirt',       3),
  ('giyim-aksesuar', 'Ayakkabı',            'ayakkabi',             'footprints',  4),
  ('giyim-aksesuar', 'Çanta & Cüzdan',      'canta-cuzdan',         'bag',         5),
  ('giyim-aksesuar', 'Saat & Takı',         'saat-taki',            'watch',       6),

  -- Anne & Bebek
  ('anne-bebek', 'Bebek Arabası & Oto Koltuğu', 'bebek-arabasi',    'stroller',    1),
  ('anne-bebek', 'Bebek Mobilyası',         'bebek-mobilyasi',      'cradle',      2),
  ('anne-bebek', 'Bebek Giyim',             'bebek-giyim',          'shirt',       3),
  ('anne-bebek', 'Mama Sandalyesi',         'mama-sandalyesi',      'chair',       4),
  ('anne-bebek', 'Oyuncak',                 'oyuncak',              'puzzle',      5),

  -- Hobi & Spor
  ('hobi-spor', 'Kitap & Dergi',            'kitap',                'book',        1),
  ('hobi-spor', 'Müzik Aleti',              'muzik-aleti',          'music',       2),
  ('hobi-spor', 'Bisiklet',                 'bisiklet',             'bike',        3),
  ('hobi-spor', 'Fitness & Kondisyon',      'fitness',              'dumbbell',    4),
  ('hobi-spor', 'Outdoor & Kamp',           'outdoor-kamp',         'tent',        5),
  ('hobi-spor', 'Su Sporları',              'su-sporlari',          'wave',        6),
  ('hobi-spor', 'Kış Sporları',             'kis-sporlari',         'snowflake',   7),
  ('hobi-spor', 'Koleksiyon & Antika',      'koleksiyon-antika',    'gem',         8),

  -- Vasıta
  ('vasita', 'Otomobil',                    'otomobil',             'car',         1),
  ('vasita', 'Motosiklet',                  'motosiklet',           'motorcycle',  2),
  ('vasita', 'Ticari Araç',                 'ticari-arac',          'truck',       3),
  ('vasita', 'Yedek Parça & Aksesuar',      'yedek-parca',          'wrench',      4),

  -- Emlak
  ('emlak', 'Satılık Konut',                'satilik-konut',        'house',       1),
  ('emlak', 'Kiralık Konut',                'kiralik-konut',        'key',         2),
  ('emlak', 'İşyeri',                       'isyeri',               'briefcase',   3),
  ('emlak', 'Arsa',                         'arsa',                 'map',         4),

  -- Diğer
  ('diger',  'Hizmetler',                   'hizmet',               'briefcase',   1),
  ('diger',  'Hayvanlar Alemi',             'hayvan',               'paw',         2),
  ('diger',  'Diğer',                       'diger-diger',          'box',        99)
) AS v(parent_slug, name, slug, icon, ordering)
JOIN categories p ON p.slug = v.parent_slug
ON CONFLICT (slug) DO NOTHING;

-- Eski (v1) artık-kullanılmayan top-level slug'ları temizle (DB henüz ilan içermiyor varsayımıyla)
DELETE FROM categories
WHERE parent_id IS NULL
  AND slug IN ('giyim','bebek-cocuk','kitap-hobi','spor-outdoor');

-- Eski 'otomobil' top-level varsa, yeni 'vasita' altına taşı
UPDATE categories
SET parent_id = (SELECT id FROM categories WHERE slug = 'vasita' AND parent_id IS NULL),
    ordering = 1
WHERE slug = 'otomobil' AND parent_id IS NULL;
