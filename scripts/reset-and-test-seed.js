// TAM SIFIRLAMA + 10 test kullanıcısı + 20 ilan + fotoğraflar.
// Bu script çalıştıktan sonra sen telefonunla yeniden kayıt olursun (OTP).
// Daha sonra: node scripts/add-me-as-approver.js → kendini sahte bir kadın
// kullanıcının cinsiyet değişikliği talebine onaylayıcı olarak ekler.
//
// Kullanım: node scripts/reset-and-test-seed.js

const crypto = require('crypto');
const pool = require('../src/db/pool');

function h(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// 5 kadın + 5 erkek test kullanıcısı
const USERS = [
  // 5 kadın
  { gender: 'female', name: 'Ayşe Demir',   city: 'İstanbul', seed: 'test-f1' },
  { gender: 'female', name: 'Fatma Yılmaz', city: 'Ankara',   seed: 'test-f2' },
  { gender: 'female', name: 'Zeynep Kaya',  city: 'İzmir',    seed: 'test-f3' },
  { gender: 'female', name: 'Elif Şahin',   city: 'Bursa',    seed: 'test-f4' },
  // Bu kullanıcı YANLIŞLIKLA kadın olarak kayıtlı — sonra erkeğe geçmek isteyecek
  { gender: 'female', name: 'Murat Erdem',  city: 'İstanbul', seed: 'test-f5-misregistered' },
  // 5 erkek
  { gender: 'male', name: 'Ali Çelik',   city: 'İstanbul', seed: 'test-m1' },
  { gender: 'male', name: 'Mehmet Aslan', city: 'Ankara',   seed: 'test-m2' },
  { gender: 'male', name: 'Mustafa Doğan', city: 'İzmir',   seed: 'test-m3' },
  { gender: 'male', name: 'Hasan Yıldız',  city: 'Antalya', seed: 'test-m4' },
  { gender: 'male', name: 'Hüseyin Polat', city: 'Konya',   seed: 'test-m5' },
];

// 20 ilan — her kullanıcıdan 2 tane (sırayla USERS[i % 10] sahibi olur)
// 3 foto: Unsplash kalıcı linkleri
const LISTINGS = [
  { title: 'iPhone 13 128GB Mavi',          desc: 'Az kullanılmış, kutulu. Aksesuarları tam.', price: 22000, cat: 'cep-telefonu-aksesuar',
    photos: ['https://images.unsplash.com/photo-1632661674596-df8be070a5c5?w=800&q=70','https://images.unsplash.com/photo-1592286927505-1def25115558?w=800&q=70','https://images.unsplash.com/photo-1611078489935-0cb964de46d6?w=800&q=70'] },
  { title: 'MacBook Air M2 256GB',          desc: '2023 model, garantisi devam ediyor.', price: 38000, cat: 'bilgisayar',
    photos: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=70','https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=800&q=70','https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&q=70'] },
  { title: 'Yatak Odası Takımı',            desc: 'Karyola + 2 komidin + şifonyer + dolap.', price: 15000, cat: 'ev-dekorasyon',
    photos: ['https://images.unsplash.com/photo-1631679706909-1844bbd07221?w=800&q=70','https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=800&q=70','https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=800&q=70'] },
  { title: 'Bebek Beşiği — Bambu',          desc: 'Doğal bambu, sallanır model. Çok temiz.', price: 1800, cat: 'anne-bebek',
    photos: ['https://images.unsplash.com/photo-1568027762272-e4da8b386fe9?w=800&q=70','https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=70','https://images.unsplash.com/photo-1522771930-78848d9293e8?w=800&q=70'] },
  { title: 'Çocuk Bisikleti — 16 inç',      desc: 'Yardımcı tekerlekleri var, 5-8 yaş arası.', price: 1200, cat: 'spor',
    photos: ['https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=800&q=70','https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=800&q=70','https://images.unsplash.com/photo-1571068316344-75bc76f77890?w=800&q=70'] },
  { title: 'Spor Ayakkabı — 43 No',         desc: 'Birkaç kez giyilmiş Adidas.', price: 0, free: true, cat: 'giyim-aksesuar',
    photos: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=70','https://images.unsplash.com/photo-1600185365483-26d7a4cc7519?w=800&q=70','https://images.unsplash.com/photo-1539185441755-769473a23570?w=800&q=70'] },
  { title: 'PlayStation 5 + 2 Kol',         desc: '1 yıl kullanıldı, hasarsız. Oyunlar dahil.', price: 18000, cat: 'oyunculara-ozel',
    photos: ['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=800&q=70','https://images.unsplash.com/photo-1607853202273-797f1c22a38e?w=800&q=70','https://images.unsplash.com/photo-1605901309584-818e25960a8f?w=800&q=70'] },
  { title: 'Yemek Tarifi Kitabı Seti',      desc: '10 kitaplık set, neredeyse yeni.', price: 0, neg: true, cat: 'kitap-dergi-film',
    photos: ['https://images.unsplash.com/photo-1495640388908-05fa85288e61?w=800&q=70','https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=800&q=70','https://images.unsplash.com/photo-1512820790803-83ca734da794?w=800&q=70'] },
  { title: 'Akıllı Saat — Galaxy Watch',    desc: '5 nesil, 44mm. Şarjı dahil.', price: 3500, cat: 'saat',
    photos: ['https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=800&q=70','https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800&q=70','https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=800&q=70'] },
  { title: 'Bebek Bezi (4 numara)',         desc: '2 paket açılmamış, beden büyüdü.', price: 0, free: true, cat: 'anne-bebek',
    photos: ['https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=70','https://images.unsplash.com/photo-1522771930-78848d9293e8?w=800&q=70','https://images.unsplash.com/photo-1519689680058-324335c77eba?w=800&q=70'] },
  { title: 'Antika Daktilo',                desc: '1960 model, çalışır durumda.', price: 0, neg: true, cat: 'antika',
    photos: ['https://images.unsplash.com/photo-1505816014357-96b5ff457e9a?w=800&q=70','https://images.unsplash.com/photo-1503455637927-730bce8583c0?w=800&q=70','https://images.unsplash.com/photo-1481873577741-67aa6c4dc3d8?w=800&q=70'] },
  { title: 'Çekyat — 3 Kişilik',            desc: 'Açılır kapanır, depolu. Temiz.', price: 4500, cat: 'ev-dekorasyon',
    photos: ['https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=800&q=70','https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=70','https://images.unsplash.com/photo-1540574163026-643ea20ade25?w=800&q=70'] },
  { title: 'Elektrik Süpürgesi — Dyson',    desc: 'V11, kablosuz. Tüm aparatlar dahil.', price: 6500, cat: 'elektrikli-ev-aletleri',
    photos: ['https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=800&q=70','https://images.unsplash.com/photo-1558317374-067fb5f30001?w=800&q=70','https://images.unsplash.com/photo-1527515637462-cff94eecc1ac?w=800&q=70'] },
  { title: 'Bisiklet — Dağ Bisikleti',      desc: '26 inç, hidrolik fren, çok temiz.', price: 8500, cat: 'spor',
    photos: ['https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=800&q=70','https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=800&q=70','https://images.unsplash.com/photo-1502744688674-c619d1586c9e?w=800&q=70'] },
  { title: 'DJI Mini 3 Pro Drone',          desc: 'Kutusu, kumanda, 2 batarya. 5 saat uçurdum.', price: 16000, cat: 'fotograf-kamera',
    photos: ['https://images.unsplash.com/photo-1473968512647-3e447244af8f?w=800&q=70','https://images.unsplash.com/photo-1521405924368-64c5b84bec60?w=800&q=70','https://images.unsplash.com/photo-1508444845599-5c89863b1c44?w=800&q=70'] },
  { title: 'Klasik Gitar — Yamaha C40',     desc: 'Başlangıç gitarı, çantasıyla.', price: 1500, cat: 'muzik',
    photos: ['https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=800&q=70','https://images.unsplash.com/photo-1525201548942-d8732f6617a0?w=800&q=70','https://images.unsplash.com/photo-1556449895-a33c9dba33dd?w=800&q=70'] },
  { title: 'Mama Sandalyesi',               desc: 'Stokke marka, 6+ ay. Açılır kapanır.', price: 0, free: true, cat: 'anne-bebek',
    photos: ['https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?w=800&q=70','https://images.unsplash.com/photo-1519689680058-324335c77eba?w=800&q=70','https://images.unsplash.com/photo-1520923642038-b4259acecbd7?w=800&q=70'] },
  { title: 'Spor Çantası — Adidas',         desc: 'Büyük boy, hiç kullanılmamış.', price: 350, cat: 'giyim-aksesuar',
    photos: ['https://images.unsplash.com/photo-1547949003-9792a18a2601?w=800&q=70','https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&q=70','https://images.unsplash.com/photo-1568625365131-079e026a927d?w=800&q=70'] },
  { title: 'Tablet — iPad 10. Nesil',       desc: 'WiFi, 64GB. Cam çatlağı yok.', price: 12000, cat: 'bilgisayar',
    photos: ['https://images.unsplash.com/photo-1561154464-82e9adf32764?w=800&q=70','https://images.unsplash.com/photo-1585789575735-c8f33b2e9bcf?w=800&q=70','https://images.unsplash.com/photo-1546538915-a9e2c8d0d12d?w=800&q=70'] },
  { title: 'Eski LP Plak Koleksiyonu',      desc: '50+ plak, çoğu Türkçe. Ne verirsen.', price: 0, neg: true, cat: 'koleksiyon',
    photos: ['https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=800&q=70','https://images.unsplash.com/photo-1487537023671-8dce1a785863?w=800&q=70','https://images.unsplash.com/photo-1461360228754-6e81c478b882?w=800&q=70'] },
];

async function wipeAll(client) {
  console.log('🧹 Tüm veriler temizleniyor...');
  // CASCADE ile users silinince bağlı her şey de silinir (listings, photos, conversations, messages, favorites, hidden_listings, notifications, gender_change_requests, gender_change_votes, user_contacts, device_tokens)
  await client.query('DELETE FROM users');
  // Kategoriler kalsın
  console.log('  ✓ Users + cascade temizlendi');

  // Redis cache temizle
  try {
    const redis = require('../src/cache/redis');
    await redis.flushDb();
    console.log('  ✓ Redis cache temizlendi');
  } catch (e) {
    console.warn('  ⚠ Redis temizlenemedi:', e.message);
  }
}

async function findCategoryId(client, slug) {
  // Önce exact match
  let r = await client.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  if (r.rows.length > 0) return r.rows[0].id;
  // Endswith fallback (örn. 'cep-telefonu-aksesuar' yerine 'ikinci-el-ve-sifir-alisveris-cep-telefonu-aksesuar' bulunabilir)
  r = await client.query("SELECT id FROM categories WHERE slug LIKE $1 ORDER BY id LIMIT 1", ['%' + slug]);
  if (r.rows.length > 0) return r.rows[0].id;
  // Diğer Her Şey fallback
  r = await client.query("SELECT id FROM categories WHERE slug LIKE '%diger-her-sey' LIMIT 1");
  return r.rows[0]?.id || null;
}

async function createUsers(client) {
  console.log('\n👥 10 test kullanıcısı oluşturuluyor...');
  const out = [];
  for (const u of USERS) {
    const ins = await client.query(
      `INSERT INTO users (phone_hash, display_name, gender, location_city)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [h(u.seed), u.name, u.gender, u.city]
    );
    out.push({ ...u, id: ins.rows[0].id, hash: h(u.seed) });
    console.log(`  ✓ ${u.gender === 'female' ? '♀' : '♂'} ${u.name}`);
  }
  return out;
}

async function linkAllContacts(client, users) {
  console.log('\n🔗 Tüm test kullanıcıları birbirini rehberde görüyor...');
  let count = 0;
  for (let i = 0; i < users.length; i++) {
    for (let j = 0; j < users.length; j++) {
      if (i === j) continue;
      await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
        [users[i].id, users[j].hash, users[j].name]
      );
      count++;
    }
  }
  console.log(`  ✓ ${count} bağlantı kuruldu`);
}

async function createListings(client, users) {
  console.log('\n📝 20 ilan + 60 fotoğraf oluşturuluyor...');
  for (let i = 0; i < LISTINGS.length; i++) {
    const l = LISTINGS[i];
    const owner = users[i % users.length];
    const categoryId = await findCategoryId(client, l.cat);
    const price = l.free || l.neg ? 0 : l.price;
    const ins = await client.query(
      `INSERT INTO listings (user_id, title, description, category_id, price, currency, location_city, is_negotiable, status)
       VALUES ($1, $2, $3, $4, $5, 'TRY', $6, $7, 'active')
       RETURNING id`,
      [owner.id, l.title, l.desc, categoryId, price, owner.city, !!l.neg]
    );
    const listingId = ins.rows[0].id;
    for (let p = 0; p < l.photos.length; p++) {
      // Unsplash linkleri zaten küçük; thumb_url'i de aynı kullanıyoruz (HTTP URL, hızlı)
      await client.query(
        `INSERT INTO listing_photos (listing_id, url, thumb_url, ordering)
         VALUES ($1, $2, $3, $4)`,
        [listingId, l.photos[p], l.photos[p], p]
      );
    }
    const flag = l.free ? '🎁' : l.neg ? '💰' : ' ';
    console.log(`  ${flag} ${owner.name} → ${l.title}`);
  }
}

async function main() {
  console.log('🚀 Yula tam sıfırlama + test seed başlatılıyor...\n');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await wipeAll(client);
    const users = await createUsers(client);
    await linkAllContacts(client, users);
    await createListings(client, users);
    await client.query('COMMIT');

    console.log('\n✓ Tamamlandı!');
    console.log('  • 10 test kullanıcı (5♀ 5♂)');
    console.log('  • 20 ilan, her birinde 3 fotoğraf');
    console.log('  • Ücretsiz + Ne Verirsen ilanları dahil');
    console.log('  • "Murat Erdem" yanlışlıkla kadın olarak kayıtlı (sonra düzeltilecek)');
    console.log('\n→ ŞİMDİ:');
    console.log('   1. Uygulamada telefonunla kayıt ol (OTP)');
    console.log('   2. Onboarding\'de cinsiyetini "Erkek" seç');
    console.log('   3. Rehberi senkronize et (boş gelecek — sahte hashler eşleşmez)');
    console.log('   4. Terminale dön ve şunu çalıştır: node scripts/add-me-as-approver.js');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
