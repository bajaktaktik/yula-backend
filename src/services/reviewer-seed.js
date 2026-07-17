// App Store / Play Store reviewer'ı için otomatik seed.
// Reviewer +905555555555 ile giriş yapınca rehberi boş — ana sayfada hiçbir şey görmez.
// Apple bunu "fonksiyonel olmayan uygulama" olarak reddedebilir (Guideline 4.2).
//
// Bu fonksiyon reviewer için arka planda 8 fake "tanıdık" + 13 demo ilan oluşturur,
// rehberine [DEMO] etiketiyle ekler. Reviewer login olur olmaz dolu bir feed görür.
//
// İdempotent: ON CONFLICT DO NOTHING + title bazlı duplicate check.
// Production'da kullanıcı görmez (sadece +905555555555 için).

const crypto = require('crypto');
const pool = require('../db/pool');

const FAKE_USERS = [
  { seed: 'ayse',    name: 'Ayşe Yılmaz',    avatar: 'https://i.pravatar.cc/200?img=47' },
  { seed: 'mehmet',  name: 'Mehmet Demir',   avatar: 'https://i.pravatar.cc/200?img=12' },
  { seed: 'zeynep',  name: 'Zeynep Kaya',    avatar: 'https://i.pravatar.cc/200?img=23' },
  { seed: 'emre',    name: 'Emre Çelik',     avatar: 'https://i.pravatar.cc/200?img=33' },
  { seed: 'elif',    name: 'Elif Şahin',     avatar: 'https://i.pravatar.cc/200?img=48' },
  { seed: 'burak',   name: 'Burak Öztürk',   avatar: 'https://i.pravatar.cc/200?img=14' },
  { seed: 'selin',   name: 'Selin Arslan',   avatar: 'https://i.pravatar.cc/200?img=49' },
  { seed: 'kerem',   name: 'Kerem Yıldız',   avatar: 'https://i.pravatar.cc/200?img=15' },
];

const LISTINGS = [
  { user: 'ayse', title: 'iPhone 13 Pro 256GB - Grafit', description: 'Hediyeden kalan kutusunda iPhone. Kullanılmadı, tüm aksesuarları içinde. Garantisi devam ediyor.', price: 32500, category: 'telefon-aksesuar', city: 'İstanbul', district: 'Kadıköy', photos: ['https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=800&q=80'] },
  { user: 'mehmet', title: 'Trek Marlin 7 Dağ Bisikleti', description: '29 jant, Shimano vites, hidrolik fren. 1 sezon kullanıldı, bakımları yapıldı.', price: 18750, category: 'bisiklet', city: 'İstanbul', district: 'Beşiktaş', photos: ['https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=800&q=80'] },
  { user: 'zeynep', title: 'IKEA Friheten Çekyat - Gri', description: '2 yaşında, evcil hayvan ve sigara yok. Yatak olarak da kullanılabiliyor.', price: 6500, category: 'mobilya', city: 'Ankara', district: 'Çankaya', photos: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80'] },
  { user: 'emre', title: 'PlayStation 5 Disk Versiyon + 2 Kol', description: 'PS5 disk versiyon, ek bir DualSense kol ve 3 oyun (FIFA 24, Spider-Man 2, GoW Ragnarok).', price: 21000, category: 'oyun-konsol', city: 'İzmir', district: 'Karşıyaka', photos: ['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=800&q=80'] },
  { user: 'elif', title: 'Canon EOS R50 Aynasız Fotoğraf Makinesi', description: '18-45mm kit lens dahil. 6 ay önce alındı, ~800 deklanşör.', price: 27500, category: 'foto-kamera', city: 'İstanbul', district: 'Şişli', photos: ['https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=800&q=80'] },
  { user: 'burak', title: 'Vintage Deri Ceket - L', description: 'Hakiki deri, 80\'ler model bombardier ceket. 1-2 kere giyildi.', price: 1850, category: 'erkek-giyim', city: 'İstanbul', district: 'Beyoğlu', photos: ['https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800&q=80'] },
  { user: 'ayse', title: 'Stokke Tripp Trapp Mama Sandalyesi', description: 'Çocuk büyüdü diye satıyorum. Beyaz renk, bebek setiyle birlikte.', price: 3200, category: 'mama-sandalyesi', city: 'İstanbul', district: 'Kadıköy', photos: ['https://images.unsplash.com/photo-1592838064575-70ed626d3a0e?w=800&q=80'] },
  { user: 'zeynep', title: 'Kindle Paperwhite 11. Nesil 16GB', description: 'Su geçirmez, ışıklı ekran. Kılıfıyla beraber, kutusunda.', price: 2750, category: 'kitap', city: 'Ankara', district: 'Çankaya', photos: ['https://images.unsplash.com/photo-1592434134753-a70baf7979d5?w=800&q=80'] },
  { user: 'mehmet', title: 'MacBook Air M2 13" 8GB / 256GB', description: '2023 model, gece yarısı rengi. ~80 şarj döngüsü. Apple Care 2026\'ya kadar geçerli.', price: 34500, category: 'bilgisayar-laptop', city: 'İstanbul', district: 'Beşiktaş', photos: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=80'] },
  { user: 'elif', title: 'Vintage Tabure Lamba - Pirinç', description: 'Ortaokul dönemi pirinç abajur. Çalışıyor, anahtarı yeni.', price: 950, category: 'aydinlatma', city: 'İstanbul', district: 'Şişli', photos: ['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=80'] },
  { user: 'burak', title: 'Adidas Samba OG - 42 Numara', description: 'Trendy klasik. 3-4 kere giyildi, neredeyse yeni.', price: 2200, category: 'ayakkabi', city: 'İstanbul', district: 'Beyoğlu', photos: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=80'] },
  { user: 'selin', title: 'Bose QuietComfort 45 Kulaklık', description: 'Active noise cancelling. 4 ay kullanıldı, garantisi devam ediyor.', price: 6800, category: 'tv-ses-sistemi', city: 'İstanbul', district: 'Üsküdar', photos: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80'] },
  { user: 'kerem', title: 'Yamaha P-45 Dijital Piyano + Standı', description: '88 tuş, ağırlıklı tuşlar. Stand ve pedal dahil.', price: 9500, category: 'muzik-aleti', city: 'İzmir', district: 'Bornova', photos: ['https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=800&q=80'] },
];

function fakeHash(seed) {
  return crypto.createHash('sha256').update('abadan-seed:' + seed).digest('hex');
}

/**
 * Reviewer login olduğunda çağrılır. Async ve fire-and-forget olabilir
 * (login response'unu beklemesin diye).
 *
 * ÖNEMLİ: Sadece reviewer'ın rehberi tamamen boşsa çalışır.
 * - Rehberde daha önce eklenmiş demo tanıdıklar varsa (hatta silinip kaldırıldıysa da) → çalışmaz
 * - Reviewer manuel silme yaparsa, tekrar seed yapılmaz
 * Bu sayede admin panelden demo ilanları kalıcı olarak silebilir.
 *
 * REVIEWER_SEED_DISABLE=true env değeri ile tamamen kapatılabilir.
 */
async function ensureReviewerSeed(reviewerUserId) {
  try {
    // Env ile tamamen kapatılabilir
    if (process.env.REVIEWER_SEED_DISABLE === 'true' || process.env.REVIEWER_SEED_DISABLE === '1') {
      return;
    }

    // Rehber daha önce doldurulmuş mu? (herhangi bir contact varsa seed atlanır)
    // Bu sayede reviewer bir kez giriş yaptıktan sonra tekrar demo veriler oluşturulmaz.
    // Admin panelden ilan/kullanıcı silmek isterse, sonraki loginlerde geri gelmez.
    const existingContacts = await pool.query(
      'SELECT COUNT(*)::int AS n FROM user_contacts WHERE user_id = $1',
      [reviewerUserId]
    );
    if (existingContacts.rows[0].n > 0) {
      console.log(`[reviewer-seed] user=${reviewerUserId} — rehber zaten dolu, seed atlandı`);
      return;
    }

    // 1) Fake users — varsa atla, yoksa yarat
    const userIds = {};
    for (const u of FAKE_USERS) {
      const ph = fakeHash(u.seed);
      const r = await pool.query(
        `INSERT INTO users (phone_hash, display_name, avatar_url, onboarded_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (phone_hash) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [ph, u.name, u.avatar]
      );
      userIds[u.seed] = { id: r.rows[0].id, hash: ph };

      // 2) Reviewer'ın rehberine ekle (idempotent, [DEMO] prefix)
      await pool.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO UPDATE
           SET contact_name = EXCLUDED.contact_name`,
        [reviewerUserId, ph, '[DEMO] ' + u.name]
      );
    }

    // 3) İlanlar — yoksa yarat, varsa created_at'i tazele (Vitrin son 7 günü gösterir)
    for (let i = 0; i < LISTINGS.length; i++) {
      const l = LISTINGS[i];
      const fake = userIds[l.user];
      if (!fake) continue;

      // Random olarak son 6 gün içine dağıt — Vitrin sürekli dolu görünür
      const randomDaysAgo = (i % 6); // 0-5 gün
      const createdAt = `now() - interval '${randomDaysAgo} days' - interval '${i * 3} hours'`;

      const existing = await pool.query(
        'SELECT id FROM listings WHERE user_id = $1 AND title = $2 LIMIT 1',
        [fake.id, l.title]
      );

      if (existing.rows.length > 0) {
        // Var → dokunma. Admin silmiş olabilir, tekrar oluşturma veya taze göster yok.
        continue;
      }

      const cat = await pool.query('SELECT id FROM categories WHERE slug = $1', [l.category]);
      const categoryId = cat.rows[0]?.id || null;

      const lr = await pool.query(
        `INSERT INTO listings (user_id, title, description, category_id, price, location_city, location_district, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${createdAt}) RETURNING id`,
        [fake.id, l.title, l.description, categoryId, l.price, l.city, l.district]
      );
      const listingId = lr.rows[0].id;

      for (let j = 0; j < l.photos.length; j++) {
        await pool.query(
          'INSERT INTO listing_photos (listing_id, url, ordering) VALUES ($1, $2, $3)',
          [listingId, l.photos[j], j]
        );
      }
    }

    console.log(`[reviewer-seed] ${FAKE_USERS.length} fake user + ${LISTINGS.length} ilan reviewer için hazır`);
  } catch (err) {
    console.error('[reviewer-seed] hata:', err.message);
    // sessiz geç — kritik değil
  }
}

module.exports = { ensureReviewerSeed };
