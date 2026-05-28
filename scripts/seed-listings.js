// Abadan - Demo ilan seed scripti
// Kullanım: node scripts/seed-listings.js +905XXXXXXXX
//   Verdiğin telefon ile uygulamada giriş yapmış olmalısın.
//   Script o kullanıcıyı bulup rehberine 8 sahte kullanıcı ekler ve onlara ilan oluşturur.

const crypto = require('crypto');
const pool = require('../src/db/pool');
const config = require('../src/config');
const redis = require('../src/cache/redis');

function computeMyPhoneHash(e164) {
  const clientSha = crypto.createHash('sha256').update(e164).digest('hex');
  return crypto.createHmac('sha256', config.phoneHashPepper || 'no-pepper-set').update(clientSha).digest('hex');
}

function fakeHash(seed) {
  return crypto.createHash('sha256').update('abadan-seed:' + seed).digest('hex');
}

// 8 sahte kullanıcı (rehberine eklenecek = 1. derece)
const USERS_1 = [
  { seed: 'ayse',    name: 'Ayşe Yılmaz',    avatar: 'https://i.pravatar.cc/200?img=47' },
  { seed: 'mehmet',  name: 'Mehmet Demir',   avatar: 'https://i.pravatar.cc/200?img=12' },
  { seed: 'zeynep',  name: 'Zeynep Kaya',    avatar: 'https://i.pravatar.cc/200?img=23' },
  { seed: 'emre',    name: 'Emre Çelik',     avatar: 'https://i.pravatar.cc/200?img=33' },
  { seed: 'elif',    name: 'Elif Şahin',     avatar: 'https://i.pravatar.cc/200?img=48' },
  { seed: 'burak',   name: 'Burak Öztürk',   avatar: 'https://i.pravatar.cc/200?img=14' },
];

// 2 kullanıcı 2. derece (Ayşe'nin rehberinde olacak, senin rehberinde değil)
const USERS_2 = [
  { seed: 'selin',   name: 'Selin Arslan',   avatar: 'https://i.pravatar.cc/200?img=49' },
  { seed: 'kerem',   name: 'Kerem Yıldız',   avatar: 'https://i.pravatar.cc/200?img=15' },
];

const LISTINGS = [
  {
    user: 'ayse',
    title: 'iPhone 13 Pro 256GB - Grafit',
    description: 'Hediyeden kalan kutusunda iPhone. Kullanılmadı, tüm aksesuarları içinde. Garantisi devam ediyor.',
    price: 32500, category: 'telefon-aksesuar', city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=800&q=80'],
  },
  {
    user: 'mehmet',
    title: 'Trek Marlin 7 Dağ Bisikleti',
    description: '29 jant, Shimano vites, hidrolik fren. 1 sezon kullanıldı, bakımları yapıldı. İstanbul içi elden teslim.',
    price: 18750, category: 'bisiklet', city: 'İstanbul', district: 'Beşiktaş',
    photos: ['https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=800&q=80'],
  },
  {
    user: 'zeynep',
    title: 'IKEA Friheten Çekyat - Gri',
    description: '2 yaşında, evcil hayvan ve sigara yok. Yatak olarak da kullanılabiliyor, depolama bölmesi var.',
    price: 6500, category: 'mobilya', city: 'Ankara', district: 'Çankaya',
    photos: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80'],
  },
  {
    user: 'emre',
    title: 'PlayStation 5 Disk Versiyon + 2 Kol',
    description: 'PS5 disk versiyon, ek bir DualSense kol ve 3 oyun (FIFA 24, Spider-Man 2, GoW Ragnarok) ile birlikte.',
    price: 21000, category: 'oyun-konsol', city: 'İzmir', district: 'Karşıyaka',
    photos: ['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=800&q=80'],
  },
  {
    user: 'elif',
    title: 'Canon EOS R50 Aynasız Fotoğraf Makinesi',
    description: '18-45mm kit lens dahil. 6 ay önce alındı, ~800 deklanşör. Çanta + 2 ekstra batarya hediye.',
    price: 27500, category: 'foto-kamera', city: 'İstanbul', district: 'Şişli',
    photos: ['https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=800&q=80'],
  },
  {
    user: 'burak',
    title: 'Vintage Deri Ceket - L',
    description: 'Hakiki deri, 80\'ler model bombardier ceket. 1-2 kere giyildi, yeni gibi. Geniş kalıp.',
    price: 1850, category: 'erkek-giyim', city: 'İstanbul', district: 'Beyoğlu',
    photos: ['https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800&q=80'],
  },
  {
    user: 'ayse',
    title: 'Stokke Tripp Trapp Mama Sandalyesi',
    description: 'Çocuk büyüdü diye satıyorum. Beyaz renk, bebek setiyle birlikte. Çok temiz.',
    price: 3200, category: 'mama-sandalyesi', city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1592838064575-70ed626d3a0e?w=800&q=80'],
  },
  {
    user: 'zeynep',
    title: 'Kindle Paperwhite 11. Nesil 16GB',
    description: 'Su geçirmez, ışıklı ekran. Kılıfıyla beraber, kutusunda. Yüklü kitaplar bonus.',
    price: 2750, category: 'kitap', city: 'Ankara', district: 'Çankaya',
    photos: ['https://images.unsplash.com/photo-1592434134753-a70baf7979d5?w=800&q=80'],
  },
  {
    user: 'mehmet',
    title: 'MacBook Air M2 13" 8GB / 256GB',
    description: '2023 model, gece yarısı rengi. ~80 şarj döngüsü. Apple Care 2026\'ya kadar geçerli.',
    price: 34500, category: 'bilgisayar-laptop', city: 'İstanbul', district: 'Beşiktaş',
    photos: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=80'],
  },
  {
    user: 'elif',
    title: 'Vintage Tabure Lamba - Pirinç',
    description: 'Ortaokul dönemi pirinç abajur. Çalışıyor, anahtarı yeni. Dekorasyonu seven biri için ideal.',
    price: 950, category: 'aydinlatma', city: 'İstanbul', district: 'Şişli',
    photos: ['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=80'],
  },
  {
    user: 'burak',
    title: 'Adidas Samba OG - 42 Numara',
    description: 'Trendy klasik. 3-4 kere giyildi, neredeyse yeni. Orijinal kutusunda.',
    price: 2200, category: 'ayakkabi', city: 'İstanbul', district: 'Beyoğlu',
    photos: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=80'],
  },
  // 2. derece - Selin (Ayşe'nin rehberinde)
  {
    user: 'selin',
    title: 'Bose QuietComfort 45 Kulaklık',
    description: 'Active noise cancelling. 4 ay kullanıldı, garantisi devam ediyor. Orijinal kutusunda.',
    price: 6800, category: 'tv-ses-sistemi', city: 'İstanbul', district: 'Üsküdar',
    photos: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80'],
  },
  // 2. derece - Kerem (Mehmet'in rehberinde)
  {
    user: 'kerem',
    title: 'Yamaha P-45 Dijital Piyano + Standı',
    description: '88 tuş, ağırlıklı tuşlar. Stand ve pedal dahil. Apartman daireye taşınıyorum, satmam gerekiyor.',
    price: 9500, category: 'muzik-aleti', city: 'İzmir', district: 'Bornova',
    photos: ['https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=800&q=80'],
  },
];

async function upsertUser(u) {
  const ph = fakeHash(u.seed);
  const r = await pool.query(
    `INSERT INTO users (phone_hash, display_name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone_hash) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url
     RETURNING id`,
    [ph, u.name, u.avatar]
  );
  return { id: r.rows[0].id, phone_hash: ph };
}

async function addContact(ownerId, contactHash, contactName) {
  await pool.query(
    `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [ownerId, contactHash, contactName]
  );
}

async function insertListing(userId, l) {
  const cat = await pool.query('SELECT id FROM categories WHERE slug = $1', [l.category]);
  const categoryId = cat.rows[0]?.id || null;
  const lr = await pool.query(
    `INSERT INTO listings (user_id, title, description, category_id, price, location_city, location_district)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, l.title, l.description, categoryId, l.price, l.city, l.district]
  );
  const listingId = lr.rows[0].id;
  for (let i = 0; i < l.photos.length; i++) {
    await pool.query(
      'INSERT INTO listing_photos (listing_id, url, ordering) VALUES ($1, $2, $3)',
      [listingId, l.photos[i], i]
    );
  }
  return listingId;
}

async function main() {
  const phone = process.argv[2];
  if (!phone || !phone.startsWith('+')) {
    console.error('Kullanım: node scripts/seed-listings.js +905XXXXXXXX');
    console.error('  (Önce uygulamada bu numara ile giriş yapmış olmalısın.)');
    process.exit(1);
  }

  const myHash = computeMyPhoneHash(phone);
  const me = await pool.query('SELECT id, display_name FROM users WHERE phone_hash = $1', [myHash]);
  if (me.rows.length === 0) {
    console.error(`Bu telefonla (${phone}) giriş yapmış kullanıcı bulunamadı.`);
    console.error('Önce uygulamada bu numarayla OTP doğrulamasını tamamla, sonra scripti tekrar çalıştır.');
    process.exit(1);
  }
  const myId = me.rows[0].id;
  console.log(`✓ Kullanıcı bulundu: ${me.rows[0].display_name || '(isim yok)'} — ${myId}`);

  // 1. derece kullanıcıları oluştur ve rehberine ekle
  const created1 = {};
  for (const u of USERS_1) {
    const { id, phone_hash } = await upsertUser(u);
    created1[u.seed] = { id, phone_hash, name: u.name };
    await addContact(myId, phone_hash, u.name);
  }
  console.log(`✓ ${USERS_1.length} kişi rehberine eklendi (1. derece)`);

  // 2. derece kullanıcıları oluştur (senin rehberinde değil; ama Ayşe/Mehmet'in rehberinde)
  const created2 = {};
  for (const u of USERS_2) {
    const { id, phone_hash } = await upsertUser(u);
    created2[u.seed] = { id, phone_hash, name: u.name };
  }
  // Selin → Ayşe'nin rehberinde
  await addContact(created1.ayse.id, created2.selin.phone_hash, created2.selin.name);
  // Kerem → Mehmet'in rehberinde
  await addContact(created1.mehmet.id, created2.kerem.phone_hash, created2.kerem.name);
  console.log(`✓ ${USERS_2.length} kişi 2. derece bağlantı olarak ayarlandı`);

  // İlanları oluştur
  const allUsers = { ...created1, ...created2 };
  let count = 0;
  for (const l of LISTINGS) {
    const u = allUsers[l.user];
    if (!u) continue;
    await insertListing(u.id, l);
    count++;
  }
  console.log(`✓ ${count} ilan oluşturuldu`);

  // Redis cache invalidate (en önemli adım)
  await redis.del(`connections:${myId}`);
  console.log('✓ Redis cache temizlendi');

  console.log('\n🎉 Seed tamamlandı! Uygulamada akışı aşağı çekip yenile.');
  await pool.end();
  await redis.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed hatası:', err);
  process.exit(1);
});
