// 4 test (robot) kullanıcısı oluşturur: 2 kadın + 2 erkek.
// Hepsini mevcut TÜM gerçek kullanıcıların rehberine ekler (karşılıklı).
// Cinsiyet değişikliği onay sürecini test etmek için tasarlanmıştır.
//
// Kullanım:
//   node scripts/create-test-users.js          → oluştur + bağla
//   node scripts/create-test-users.js --clean  → bu robot kullanıcıları sil

const crypto = require('crypto');
const pool = require('../src/db/pool');

const ROBOTS = [
  { name: 'Test Kadın Ayşe',   gender: 'female', seed: 'gender-test-female-1' },
  { name: 'Test Kadın Fatma',  gender: 'female', seed: 'gender-test-female-2' },
  { name: 'Test Erkek Ali',    gender: 'male',   seed: 'gender-test-male-1' },
  { name: 'Test Erkek Mehmet', gender: 'male',   seed: 'gender-test-male-2' },
];

function phoneHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

async function ensureRobot(client, robot) {
  const hash = phoneHash(robot.seed);
  const existing = await client.query('SELECT id FROM users WHERE phone_hash = $1', [hash]);
  if (existing.rows.length > 0) {
    // Cinsiyet/isim güncel mi emin ol
    await client.query(
      'UPDATE users SET display_name = $1, gender = $2 WHERE id = $3',
      [robot.name, robot.gender, existing.rows[0].id]
    );
    return { id: existing.rows[0].id, hash, created: false };
  }
  const ins = await client.query(
    `INSERT INTO users (phone_hash, display_name, gender, location_city)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [hash, robot.name, robot.gender, 'İstanbul']
  );
  return { id: ins.rows[0].id, hash, created: true };
}

async function linkUsers(client, robots) {
  // Tüm "gerçek" kullanıcıları al (robot hash'leri hariç)
  const robotHashes = robots.map((r) => r.hash);
  const realUsers = await client.query(
    `SELECT id, phone_hash, display_name FROM users
     WHERE phone_hash <> ALL($1::text[])`,
    [robotHashes]
  );
  if (realUsers.rows.length === 0) {
    console.log('  ⚠ Gerçek kullanıcı yok — sadece robotlar oluşturuldu, bağlanmadı');
    return 0;
  }

  let links = 0;
  for (const real of realUsers.rows) {
    for (const robot of robots) {
      // Gerçek kullanıcının rehberine robotu ekle
      const a = await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO UPDATE SET contact_name = EXCLUDED.contact_name`,
        [real.id, robot.hash, robot.name]
      );
      // Robot'un rehberine gerçek kullanıcıyı ekle (karşılıklı görünürlük için)
      const b = await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
        [robot.id, real.phone_hash, real.display_name || 'Test Hedef']
      );
      links += a.rowCount + b.rowCount;
    }
  }

  // Robot'ları da kendi aralarında bağla (talepte birbirini görebilsinler)
  for (let i = 0; i < robots.length; i++) {
    for (let j = 0; j < robots.length; j++) {
      if (i === j) continue;
      await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
        [robots[i].id, robots[j].hash, robots[j].name]
      );
    }
  }

  return links;
}

async function cleanupCache(client, robots) {
  // Redis bağlantı grafiği cache'i — gerçek kullanıcılar yeni rehberi tekrar göremezse
  try {
    const redis = require('../src/cache/redis');
    const allUsers = await client.query('SELECT id FROM users');
    for (const u of allUsers.rows) {
      await redis.del(`connections:${u.id}`);
    }
    console.log(`  ✓ ${allUsers.rows.length} kullanıcı için graph cache temizlendi`);
  } catch (e) {
    console.warn('  ⚠ Cache temizlenemedi:', e.message);
  }
}

async function deleteRobots() {
  const client = await pool.connect();
  try {
    const hashes = ROBOTS.map((r) => phoneHash(r.seed));
    const del = await client.query(
      `DELETE FROM users WHERE phone_hash = ANY($1::text[]) RETURNING display_name`,
      [hashes]
    );
    console.log(`✓ ${del.rowCount} robot silindi:`);
    for (const row of del.rows) console.log(`  • ${row.display_name}`);
  } finally {
    client.release();
  }
}

async function main() {
  const isClean = process.argv.includes('--clean');

  if (isClean) {
    console.log('🧹 Test robotları siliniyor...');
    await deleteRobots();
    await pool.end();
    return;
  }

  console.log('🤖 Test robotları oluşturuluyor...\n');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created = [];
    for (const robot of ROBOTS) {
      const r = await ensureRobot(client, robot);
      created.push({ ...robot, id: r.id, hash: r.hash });
      console.log(`  ${r.created ? '✓ Oluşturuldu' : '↻ Zaten var'}: ${robot.name} (${robot.gender}) → ${r.id}`);
    }

    console.log('\n🔗 Tüm gerçek kullanıcıların rehberine bağlanıyor...');
    const links = await linkUsers(client, created);
    console.log(`  ✓ ${links} bağlantı kuruldu/güncellendi`);

    await client.query('COMMIT');

    await cleanupCache(client, created);

    console.log('\n✓ Tamamlandı! Uygulamada Profil > Bilgilerimi Düzenle > Cinsiyeti değiştir ile test edebilirsin.');
    console.log('   Robotlar otomatik onay vermez — sen ve eşin diğer hesaplardan onay verebilirsiniz.');
    console.log('   Robotlardan birinin sana onay vermesini istersen, o robotun adına giriş yapıp');
    console.log('   notifications üzerinden oy verebilirsin (test için manuel yapılmalı).');
    console.log('\nTemizlemek için: node scripts/create-test-users.js --clean');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('✗ Hata:', e);
  pool.end();
  process.exit(1);
});
