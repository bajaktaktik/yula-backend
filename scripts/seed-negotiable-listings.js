// Abadan - "Ne Verirsen" ilan seed scripti.
// 4 adet is_negotiable=true ilan ekler. Sahipler mevcut sahte kullanıcılardır.
// Kullanım: node scripts/seed-negotiable-listings.js

const crypto = require('crypto');
const pool = require('../src/db/pool');
const redis = require('../src/cache/redis');

function fakeHash(seed) {
  return crypto.createHash('sha256').update('abadan-seed:' + seed).digest('hex');
}

const NEG_LISTINGS = [
  {
    owner: 'ayse',
    title: 'Boyalı Tablo - Yağlı Boya (50x70)',
    description: 'Kendi yaptığım bir tablo, fiyatına karışmıyorum. Ne verirsen, alıp götüren götürsün.',
    category: 'ikinci-el-sifir-alisveris',
    city: 'İstanbul', district: 'Kadıköy',
    photo: 'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=800&q=80',
  },
  {
    owner: 'mehmet',
    title: 'Eski Plak Koleksiyonu (10 adet)',
    description: '70-80 dönemi Türk pop ve arabesk plakları. Bazıları çizik, bazıları kıymetli. Sanata değer veren bilir, sen söyle fiyatı.',
    category: 'kitap-dergi-film',
    city: 'İstanbul', district: 'Beşiktaş',
    photo: 'https://images.unsplash.com/photo-1539375665275-f9de415ef9ac?w=800&q=80',
  },
  {
    owner: 'zeynep',
    title: 'Ahşap Çocuk Oyuncağı Seti',
    description: 'Marangoz dedem yapmıştı, çocukluğumda oynadım. Saklamak yerine seven birine gitsin. Ne verirsen.',
    category: 'hobi-oyuncak',
    city: 'Ankara', district: 'Çankaya',
    photo: 'https://images.unsplash.com/photo-1558060370-d644479cb6f7?w=800&q=80',
  },
  {
    owner: 'elif',
    title: 'Eski Türk Filmleri DVD Seti (15 film)',
    description: '90\'lardan kalma orijinal DVD\'ler. Bazı kutuları yıpranmış ama hepsi çalışıyor. Nostaljik koleksiyon için.',
    category: 'kitap-dergi-film',
    city: 'İstanbul', district: 'Şişli',
    photo: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=800&q=80',
  },
];

async function upsertUser(seed, name, avatar) {
  const ph = fakeHash(seed);
  const r = await pool.query(
    `INSERT INTO users (phone_hash, display_name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone_hash) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [ph, name, avatar]
  );
  return r.rows[0].id;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;

    for (const l of NEG_LISTINGS) {
      const ownerHash = fakeHash(l.owner);
      const u = await client.query('SELECT id FROM users WHERE phone_hash = $1', [ownerHash]);
      if (u.rows.length === 0) {
        console.warn(`⚠ Kullanıcı bulunamadı: ${l.owner} — atlandı`);
        skipped++;
        continue;
      }
      const userId = u.rows[0].id;

      const cat = await client.query('SELECT id FROM categories WHERE slug = $1', [l.category]);
      const categoryId = cat.rows[0]?.id || null;

      const lr = await client.query(
        `INSERT INTO listings (user_id, title, description, category_id, price, is_negotiable, location_city, location_district)
         VALUES ($1, $2, $3, $4, 0, TRUE, $5, $6) RETURNING id`,
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
    console.log(`\n💰 ${inserted} "Ne Verirsen" ilanı eklendi${skipped ? ` (${skipped} atlandı)` : ''}.`);

    // Tüm kullanıcıların Redis cache'ini temizle
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
