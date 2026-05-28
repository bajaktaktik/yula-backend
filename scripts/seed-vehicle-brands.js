// Abadan - Vasıta > Otomobil ve Motosiklet altına Türkiye pazarındaki markalar.
// Kullanım: node scripts/seed-vehicle-brands.js
// (Önce seed-categories.js çalıştırılmış olmalı)

const pool = require('../src/db/pool');

// Türkiye'de yaygın otomobil markaları (alfabetik)
const CAR_BRANDS = [
  'Alfa Romeo', 'Aston Martin', 'Audi', 'Bentley', 'BMW', 'BYD',
  'Cadillac', 'Chery', 'Chevrolet', 'Chrysler', 'Citroën', 'Cupra',
  'Dacia', 'Daewoo', 'Daihatsu', 'Dodge', 'DR', 'DS', 'Ferrari',
  'Fiat', 'Ford', 'Geely', 'Honda', 'Hummer', 'Hyundai', 'Infiniti',
  'Isuzu', 'Iveco', 'Jaguar', 'Jeep', 'Kia', 'Lada', 'Lamborghini',
  'Lancia', 'Land Rover', 'Lexus', 'Lincoln', 'Lotus', 'Maserati',
  'Maybach', 'Mazda', 'McLaren', 'Mercedes-Benz', 'MG', 'Mini',
  'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Polestar', 'Pontiac',
  'Porsche', 'Proton', 'Renault', 'Rolls-Royce', 'Rover', 'Saab',
  'Seat', 'Škoda', 'Smart', 'SsangYong', 'Subaru', 'Suzuki',
  'Tata', 'Tesla', 'Tofaş', 'Togg', 'Toyota', 'Volkswagen', 'Volvo',
];

// Türkiye'de yaygın motosiklet markaları (alfabetik)
const MOTO_BRANDS = [
  'Aprilia', 'Arora', 'Bajaj', 'Benelli', 'Beta', 'BMW Motorrad',
  'Bordo', 'CFMoto', 'Daelim', 'Ducati', 'Falcon', 'GasGas',
  'Harley-Davidson', 'Hero', 'Honda', 'Husqvarna', 'Hyosung',
  'Indian', 'Italjet', 'Kanuni', 'Kawasaki', 'Keeway', 'KTM',
  'Kuba', 'Kymco', 'Lifan', 'Loncin', 'Mash', 'Mondial', 'MotoGuzzi',
  'MV Agusta', 'Mz', 'Norton', 'Peugeot Moto', 'Piaggio', 'Ramzey',
  'Regal Raptor', 'Rks', 'Royal Enfield', 'Senke', 'Sherco',
  'Suzuki', 'SYM', 'Triumph', 'TVS', 'Vespa', 'Volta', 'Yamaha',
  'Yuki', 'Zontes',
];

// Slug üretici — Türkçe karakterleri ASCII'ye çevir
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/é/g, 'e').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function getCategoryId(client, slug) {
  const r = await client.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  return r.rows[0]?.id || null;
}

async function insertBrand(client, parentId, name, parentSlug, ordering) {
  const slug = `${parentSlug}-${slugify(name)}`;
  await client.query(
    `INSERT INTO categories (parent_id, name, slug, ordering)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO NOTHING`,
    [parentId, name, slug, ordering]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const otomobilId = await getCategoryId(client, 'vasita-otomobil');
    const motoId = await getCategoryId(client, 'vasita-motosiklet');

    if (!otomobilId) {
      console.error('vasita-otomobil kategorisi bulunamadı. Önce seed-categories.js çalıştır.');
      process.exit(1);
    }
    if (!motoId) {
      console.error('vasita-motosiklet kategorisi bulunamadı. Önce seed-categories.js çalıştır.');
      process.exit(1);
    }

    let n = 0;
    for (const brand of CAR_BRANDS) {
      n++;
      await insertBrand(client, otomobilId, brand, 'oto', n);
    }
    console.log(`✓ ${CAR_BRANDS.length} otomobil markası eklendi`);

    n = 0;
    for (const brand of MOTO_BRANDS) {
      n++;
      await insertBrand(client, motoId, brand, 'moto', n);
    }
    console.log(`✓ ${MOTO_BRANDS.length} motosiklet markası eklendi`);

    await client.query('COMMIT');
    console.log(`\n🚗🏍 Toplam ${CAR_BRANDS.length + MOTO_BRANDS.length} marka kategorisi eklendi.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
