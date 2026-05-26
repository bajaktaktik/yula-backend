// Yula - Tüm ilanları sil ve 20 yeni karışık ilan ekle.
// Otomobil ilanlarında 3'er fotoğraf, ücretsiz/ne verirsen ilanları dahil.
// Kullanım: node scripts/reset-and-seed-listings.js

const crypto = require('crypto');
const pool = require('../src/db/pool');
const redis = require('../src/cache/redis');

function fakeHash(seed) {
  return crypto.createHash('sha256').update('yula-seed:' + seed).digest('hex');
}

// Yeni 20 ilan — kategori slug'ları yulacat.txt'den
const LISTINGS = [
  // === OTOMOBİL (3 ilan, 3'er foto) ===
  {
    owner: 'mehmet',
    title: 'BMW 320d 2020 - 45.000 km Düzenli Bakımlı',
    description: 'F30 kasa, 190 hp dizel, otomatik. Servis bakımları düzenli, hasar kaydı yok. Takasa açığım.',
    price: 1250000, category: 'oto-bmw',
    city: 'İstanbul', district: 'Beşiktaş',
    photos: [
      'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800&q=80',
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80',
      'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=800&q=80',
    ],
  },
  {
    owner: 'elif',
    title: 'Tesla Model 3 Long Range 2023 - 12.000 km',
    description: 'Beyaz renk, premium interior, autopilot aktif. Garanti devam ediyor.',
    price: 2450000, category: 'oto-tesla',
    city: 'İstanbul', district: 'Şişli',
    photos: [
      'https://images.unsplash.com/photo-1560958089-b8a1929cea89?w=800&q=80',
      'https://images.unsplash.com/photo-1571127236794-81c0bbfe1ce3?w=800&q=80',
      'https://images.unsplash.com/photo-1617704548623-340376564e68?w=800&q=80',
    ],
  },
  {
    owner: 'ayse',
    title: 'Renault Clio Joy 1.0 SCe 2019 - Manuel',
    description: '78.000 km\'de, manuel vites. 1. el, hasar kaydı yok. Ekonomik şehir aracı.',
    price: 595000, category: 'oto-renault',
    city: 'İstanbul', district: 'Kadıköy',
    photos: [
      'https://images.unsplash.com/photo-1568844293986-8d0400bd4745?w=800&q=80',
      'https://images.unsplash.com/photo-1605559424843-9e4c228bf1c2?w=800&q=80',
      'https://images.unsplash.com/photo-1502877338535-766e1452684a?w=800&q=80',
    ],
  },

  // === ÜCRETSİZ (3 ilan) ===
  {
    owner: 'ayse',
    title: 'Bebek Bezi Paketi - Hediyem',
    description: 'Bebeğim büyüdü, kullanılmamış 2 paket bezim var (4 numara). İhtiyacı olana ücretsiz.',
    price: 0, category: 'anne-bebek',
    city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=80'],
  },
  {
    owner: 'zeynep',
    title: '10 Kitaplık Roman Seti',
    description: 'Okudum, gerek kalmadı. Türk ve dünya edebiyatı karışık. Toplu vermek istiyorum.',
    price: 0, category: 'kitap-dergi-film',
    city: 'Ankara', district: 'Çankaya',
    photos: ['https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=800&q=80'],
  },
  {
    owner: 'burak',
    title: 'Bahçe Saksıları (3 adet) + Toprak',
    description: 'Balkondan alabilirsiniz. 3 farklı boyda saksı, kullanışlı durumda.',
    price: 0, category: 'bahce-yapi-market',
    city: 'İstanbul', district: 'Beyoğlu',
    photos: ['https://images.unsplash.com/photo-1485955900006-10f4d324d411?w=800&q=80'],
  },

  // === NE VERİRSEN (3 ilan) ===
  {
    owner: 'ayse',
    title: 'Kendi Yaptığım Yağlı Boya Tablo (50x70)',
    description: 'Anılarımı saklamak istemiyorum. Sanata değer veren biri için. Ne verirsen.',
    price: 0, is_negotiable: true, category: 'ikinci-el-sifir-alisveris',
    city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=800&q=80'],
  },
  {
    owner: 'mehmet',
    title: 'Vintage Plak Koleksiyonu (10 adet)',
    description: '70-80\'ler Türk pop ve arabesk. Bazıları çizik. Koleksiyonere uygun fiyat, ne verirsen.',
    price: 0, is_negotiable: true, category: 'kitap-dergi-film',
    city: 'İstanbul', district: 'Beşiktaş',
    photos: ['https://images.unsplash.com/photo-1539375665275-f9de415ef9ac?w=800&q=80'],
  },
  {
    owner: 'elif',
    title: 'Antika Pirinç Cep Saati',
    description: 'Dededen kalma 50 yıllık antika cep saati. Çalışıyor. Değerini bilen alır.',
    price: 0, is_negotiable: true, category: 'saat',
    city: 'İstanbul', district: 'Şişli',
    photos: ['https://images.unsplash.com/photo-1509048191080-d2984bad6ae5?w=800&q=80'],
  },

  // === NORMAL FİYATLI (11 ilan) ===
  {
    owner: 'ayse',
    title: 'iPhone 13 Pro 256GB - Grafit',
    description: 'Kutusunda az kullanılmış iPhone. Aksesuarları içinde, garantisi devam ediyor.',
    price: 32500, category: 'cep-telefonu-aksesuar',
    city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=800&q=80'],
  },
  {
    owner: 'mehmet',
    title: 'MacBook Air M2 13" 8GB/256GB',
    description: '2023 model, gece yarısı rengi. ~80 şarj döngüsü. Apple Care 2026\'ya kadar.',
    price: 34500, category: 'bilgisayar',
    city: 'İstanbul', district: 'Beşiktaş',
    photos: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=80'],
  },
  {
    owner: 'emre',
    title: 'PlayStation 5 Disk + 2 Kol + 3 Oyun',
    description: 'PS5 disk versiyon, ek kol ve FIFA 24, Spider-Man 2, GoW Ragnarok dahil.',
    price: 21000, category: 'oyunculara-ozel',
    city: 'İzmir', district: 'Karşıyaka',
    photos: ['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=800&q=80'],
  },
  {
    owner: 'elif',
    title: 'Canon EOS R50 Aynasız Fotoğraf Makinesi',
    description: '18-45mm kit lens. 6 ay önce alındı, ~800 deklanşör. Çanta + 2 batarya hediye.',
    price: 27500, category: 'fotograf-kamera',
    city: 'İstanbul', district: 'Şişli',
    photos: ['https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=800&q=80'],
  },
  {
    owner: 'burak',
    title: 'Vintage Deri Bomber Ceket - L',
    description: 'Hakiki deri, 80\'ler model. 1-2 kere giyildi, neredeyse sıfır. Geniş kalıp.',
    price: 1850, category: 'giyim-aksesuar',
    city: 'İstanbul', district: 'Beyoğlu',
    photos: ['https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800&q=80'],
  },
  {
    owner: 'ayse',
    title: 'Stokke Tripp Trapp Mama Sandalyesi - Beyaz',
    description: 'Çocuk büyüdü diye satıyorum. Bebek seti dahil, çok temiz kullanıldı.',
    price: 3200, category: 'anne-bebek',
    city: 'İstanbul', district: 'Kadıköy',
    photos: ['https://images.unsplash.com/photo-1592838064575-70ed626d3a0e?w=800&q=80'],
  },
  {
    owner: 'zeynep',
    title: 'Kindle Paperwhite 11. Nesil 16GB',
    description: 'Su geçirmez, ışıklı ekran. Kılıfıyla birlikte. Yüklü 200+ kitap bonus.',
    price: 2750, category: 'kitap-dergi-film',
    city: 'Ankara', district: 'Çankaya',
    photos: ['https://images.unsplash.com/photo-1592434134753-a70baf7979d5?w=800&q=80'],
  },
  {
    owner: 'zeynep',
    title: 'IKEA Friheten Çekyat - Gri',
    description: '2 yaşında, evcil hayvan/sigara yok. Yatak olarak kullanılabilir, depolama bölmesi var.',
    price: 6500, category: 'ev-dekorasyon',
    city: 'Ankara', district: 'Çankaya',
    photos: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80'],
  },
  {
    owner: 'selin',
    title: 'Bose QuietComfort 45 Kulaklık',
    description: 'Active noise cancelling. 4 ay kullanıldı. Garanti devam, orijinal kutusunda.',
    price: 6800, category: 'ev-elektroniği',
    city: 'İstanbul', district: 'Üsküdar',
    photos: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80'],
  },
  {
    owner: 'mehmet',
    title: 'Trek Marlin 7 Dağ Bisikleti - 29 Jant',
    description: 'Shimano vites, hidrolik fren. 1 sezon kullanıldı, bakımları yapıldı.',
    price: 18750, category: 'spor',
    city: 'İstanbul', district: 'Beşiktaş',
    photos: ['https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=800&q=80'],
  },
  {
    owner: 'burak',
    title: 'Adidas Samba OG - 42 Numara',
    description: 'Klasik renk, 3-4 kere giyildi. Orijinal kutusunda, neredeyse sıfır.',
    price: 2200, category: 'giyim-aksesuar',
    city: 'İstanbul', district: 'Beyoğlu',
    photos: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=80'],
  },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Mevcut tüm ilanlar siliniyor...');
    const del = await client.query('DELETE FROM listings');
    console.log(`✓ ${del.rowCount} ilan silindi`);

    let inserted = 0;
    let skipped = 0;

    for (const l of LISTINGS) {
      // Sahte kullanıcıyı bul
      const ownerHash = fakeHash(l.owner);
      const u = await client.query('SELECT id FROM users WHERE phone_hash = $1', [ownerHash]);
      if (u.rows.length === 0) {
        console.warn(`⚠ Kullanıcı bulunamadı: ${l.owner} — atlandı`);
        skipped++;
        continue;
      }
      const userId = u.rows[0].id;

      // Kategori
      const cat = await client.query('SELECT id FROM categories WHERE slug = $1', [l.category]);
      const categoryId = cat.rows[0]?.id || null;
      if (!categoryId) {
        console.warn(`⚠ Kategori bulunamadı: ${l.category} (ilan: ${l.title})`);
      }

      // İlan
      const lr = await client.query(
        `INSERT INTO listings (user_id, title, description, category_id, price, is_negotiable, location_city, location_district)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [userId, l.title, l.description, categoryId, l.price, !!l.is_negotiable, l.city, l.district]
      );
      const listingId = lr.rows[0].id;

      // Fotoğraflar
      for (let i = 0; i < l.photos.length; i++) {
        await client.query(
          'INSERT INTO listing_photos (listing_id, url, ordering) VALUES ($1, $2, $3)',
          [listingId, l.photos[i], i]
        );
      }

      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\n🎉 ${inserted} ilan eklendi${skipped ? ` (${skipped} atlandı)` : ''}.`);

    // Tüm kullanıcıların Redis cache'ini temizle
    const allUsers = await client.query('SELECT id FROM users');
    for (const u of allUsers.rows) {
      await redis.del(`connections:${u.id}`);
    }
    console.log('✓ Redis cache temizlendi');

    // Özet
    const stats = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE price > 0 AND NOT is_negotiable) AS satilik,
        COUNT(*) FILTER (WHERE price = 0 AND NOT is_negotiable) AS ucretsiz,
        COUNT(*) FILTER (WHERE is_negotiable) AS ne_verirsen,
        COUNT(*) AS toplam
      FROM listings
    `);
    const s = stats.rows[0];
    console.log(`\n📊 Toplam: ${s.toplam}  |  Satılık: ${s.satilik}  |  Ücretsiz: ${s.ucretsiz}  |  Ne Verirsen: ${s.ne_verirsen}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    await redis.quit();
  }
}

main();
