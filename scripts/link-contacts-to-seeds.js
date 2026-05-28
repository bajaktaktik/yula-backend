// Yeni test kullanıcısının rehberine TÜM seed kullanıcılarını ekler.
// Aksi halde yeni kullanıcı rehberinde Abadan'lı kimse olmadığı için ilan göremez.
//
// Kullanım:
//   node scripts/link-contacts-to-seeds.js              → en son aktif kullanıcı için
//   node scripts/link-contacts-to-seeds.js --all        → tüm kullanıcıları birbiriyle eşle
//   node scripts/link-contacts-to-seeds.js --user <id>  → belirli kullanıcı için

const pool = require('../src/db/pool');
const redis = require('../src/cache/redis');

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { all: false, user: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--user') out.user = argv[++i];
  }
  return out;
}

async function linkUserToAll(userId) {
  // Hedef kullanıcı dışındaki herkesin phone_hash'ini ve adını al
  const others = await pool.query(
    `SELECT id, phone_hash, display_name FROM users WHERE id <> $1`,
    [userId]
  );

  let added = 0;
  for (const u of others.rows) {
    // Hedef kullanıcının rehberine ekle (karşılıklı)
    const r1 = await pool.query(
      `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
      [userId, u.phone_hash, u.display_name || 'Kullanıcı']
    );
    added += r1.rowCount;

    // Karşılıklı (diğer kullanıcı da bunu rehberine eklesin → karşı taraf da bu kullanıcının ilanını görür)
    const me = await pool.query('SELECT phone_hash, display_name FROM users WHERE id = $1', [userId]);
    await pool.query(
      `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
      [u.id, me.rows[0].phone_hash, me.rows[0].display_name || 'Kullanıcı']
    );
  }

  // Cache temizle (graph cache 24 saat tutuyor)
  try {
    await redis.del(`connections:${userId}`);
    for (const u of others.rows) {
      await redis.del(`connections:${u.id}`);
    }
  } catch (e) {
    console.warn('  ⚠ Redis temizlenemedi:', e.message);
  }

  return added;
}

async function main() {
  const args = parseArgs();

  let targets;
  if (args.user) {
    targets = [args.user];
  } else if (args.all) {
    const { rows } = await pool.query('SELECT id, display_name FROM users');
    targets = rows.map((r) => r.id);
    console.log(`🔗 Tüm kullanıcıları (${targets.length}) birbiriyle eşleştiriyorum...`);
  } else {
    const { rows } = await pool.query(
      `SELECT id, display_name FROM users ORDER BY last_active_at DESC NULLS LAST, created_at DESC LIMIT 1`
    );
    if (rows.length === 0) {
      console.log('⚠ Hiç kullanıcı yok.');
      await pool.end();
      return;
    }
    targets = [rows[0].id];
    console.log(`🎯 En son aktif kullanıcı: ${rows[0].display_name} (${rows[0].id})`);
  }

  for (const t of targets) {
    const added = await linkUserToAll(t);
    const me = await pool.query('SELECT display_name FROM users WHERE id = $1', [t]);
    console.log(`  ✓ ${me.rows[0]?.display_name || t}: ${added} yeni rehber kişisi eklendi`);
  }

  console.log('\n✓ Bitti. Uygulamayı yenile (pull-to-refresh veya çıkış-giriş) → ilanlar görünmeli.');
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ Hata:', e);
  pool.end();
  process.exit(1);
});
