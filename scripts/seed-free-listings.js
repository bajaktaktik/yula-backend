// Yula - Ücretsiz (hibe) ilan seed scripti.
// 7-8 adet "fiyat = 0" ilan ekler. Sahipler mevcut sahte kullanıcılardır.
// Kullanım: node scripts/seed-free-listings.js

const crypto = require('crypto');
const pool = require('../src/db/pool');
const redis = require('../src/cache/redis');

function fakeHash(seed) {
  return crypto.createHash('sha256').update('yula-seed:' + seed).digest('hex');
}

const FREE_LISTINGS = [
  {
    owner: 'ayse',
    title: 'Bebek Bezi Paketi (kullanılmamış)',
    description: 'Bebeğim büyüdü, kullanılmamış 2 paket bedek bezi (4 numara). Alıp götüren götürsün.',
    category: 'anne-bebek',
    city: 'İstanbul', district: 'Kadıköy',
    photo: 'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=80',
  },
  {
    owner: 'mehmet',
    title: 'Eski Spor Ayakkabı (43 numara)',
    description: 'Birkaç kez giyilmiş Adidas spor ayakkabı, üst durumda ama tabanı eskimiş. Bahçe/atölye işi için iyi.',
    category: 'giyim-aksesuar',
    city: 'İstanbul', district: 'Beşiktaş',
    photo: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=80',
  },
  {
    owner: 'zeynep',
    title: 'Kitap Seti (10 adet roman)',
    description: 'Okudum, gerek kalmadı. 10 adet Türk ve dünya edebiyatından roman. Lütfen toplu alın.',
    category: 'kitap-dergi-film',
    city: 'Ankara', district: 'Çankaya',
    photo: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=800&q=80',
  },
  {
    owner: 'emre',
    title: 'IKEA Lack Yan Sehpa (beyaz)',
    description: 'Taşınıyorum, alacak yer yok. Bir kenarı çizilmiş, yoksa sağlam. Gelip alacak biri için ücretsiz.',
    category: 'ev-dekorasyon',
    city: 'İzmir', district: 'Karşıyaka',
    photo: 'https://images.unsplash.com/photo-1581539250439-c96689b516dd?w=800&q=80',
  },
  {
    owner: 'elif',
    title: 'Kedi Maması (yarım çuval)',
    description: 'Kedim alerji yaptığı için bu marka ile vedalaştık. Yarım çuval kaldı, sağlam ambalajda.',
    category: 'hayvanlar-alemi',
    city: 'İstanbul', district: 'Şişli',
    photo: 'https://images.unsplash.com/photo-1592194996308-7b43878e84a6?w=800&q=80',
  },
  {
    owner: 'burak',
    title: 'Saksı + Toprak (3 adet)',
    description: 'Bitki yetiştirmeye başlayacak biri için ideal. 3 farklı boyda saksı + biraz toprak. Balkondan alabilirsiniz.',
    category: 'bahce-yapi-market',
    city: 'İstanbul', district: 'Beyoğlu',
    photo: 'https://images.unsplash.com/photo-1485955900006-10f4d324d411?w=800&q=80',
  },
  {
    owner: 'ayse',
    title: 'Çocuk Oyuncak Kutusu (karışık)',
    description: 'Çocuğum büyüdü, oyuncaklar artık ona ait değil. Bir kutu dolusu lego, peluş, küçük araba.',
    category: 'hobi-oyuncak',
    city: 'İstanbul', district: 'Kadıköy',
    photo: 'https://images.unsplash.com/photo-1558877385-8c1eef739d11?w=800&q=80',
  },
  {
    owner: 'zeynep',
    title: 'Kullanılmış Tencere (3 adet)',
    description: 'Yeni set aldım, eskilerini lazım olana vermek istiyorum. Tabanları sağlam, kapakları var.',
    category: 'ev-dekorasyon',
    city: 'Ankara', district: 'Çankaya',
    photo: 'https://images.unsplash.com/photo-1584990347449-a4d3df9b66c3?w=800&q=80',
  },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;

    for (const l of FREE_LISTINGS) {
      // Sahte kullanıcıyı bul (fakeHash ile)
      const ownerHash = fakeHash(l.owner);
      const u = await client.query('SELECT id FROM users WHERE phone_hash = $1', [ownerHash]);
      if (u.rows.length === 0) {
        console.warn(`⚠ Kullanıcı bulunamadı: ${l.owner} — atlandı (önce seed-listings.js çalıştır)`);
        skipped++;
        continue;
      }
      const userId = u.rows[0].id;

      const cat = await client.query('SELECT id FROM categories WHERE slug = $1', [l.category]);
      const categoryId = cat.rows[0]?.id || null;

      const lr = await client.query(
        `INSERT INTO listings (user_id, title, description, category_id, price, location_city, location_district)
         VALUES ($1, $2, $3, $4, 0, $5, $6) RETURNING id`,
        [userId, l.title, l.description, categoryId, l.city, l.district]
      );
      const listingId = lr.rows[0].id;

      await client.query(
        'INSERT INTO listing_photos (listing_id, url, ordering) VALUES ($1, $2, 0)',
        [listingId, l.photo]
      );

      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\n🎁 ${inserted} ücretsiz ilan eklendi${skipped ? ` (${skipped} atlandı)` : ''}.`);

    // Tüm kullanıcıların Redis cache'ini temizle (yeni ilanları görsünler)
    const allUsers = await client.query('SELECT id FROM users');
    for (const u of allUsers.rows) {
      await redis.del(`connections:${u.id}`);
    }
    console.log('✓ Redis cache temizlendi');
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
