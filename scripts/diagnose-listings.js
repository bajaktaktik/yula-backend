// İlanların neden Abadan'da görünmediğini tanı et.
// Kullanım:
//   DATABASE_URL="..." node scripts/diagnose-listings.js <kullanıcı_e164>
//
// Örnek:
//   DATABASE_URL="postgresql://..." node scripts/diagnose-listings.js +905052328699

const crypto = require('crypto');
const { Pool } = require('pg');

const e164 = process.argv[2];
const pepper = process.env.PHONE_HASH_PEPPER;
if (!e164 || !pepper) {
  console.error('Kullanım: PHONE_HASH_PEPPER=... DATABASE_URL=... node scripts/diagnose-listings.js +905XXXXXXXX');
  process.exit(1);
}

function computeHash(e164) {
  const clientSha = crypto.createHash('sha256').update(e164).digest('hex');
  return crypto.createHmac('sha256', pepper).update(clientSha).digest('hex');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const myHash = computeHash(e164);

  // 1) Beni bul
  const me = await pool.query('SELECT id, display_name, gender FROM users WHERE phone_hash = $1', [myHash]);
  if (me.rows.length === 0) {
    console.log('❌ Kullanıcı bulunamadı.');
    return;
  }
  const myId = me.rows[0].id;
  console.log('✓ Ben:', me.rows[0].display_name || '(isim yok)', '— gender:', me.rows[0].gender || 'YOK', '— id:', myId);

  // 2) Rehberimdeki kişiler
  const contacts = await pool.query(
    `SELECT uc.contact_name, uc.contact_phone_hash,
            (SELECT id FROM users u WHERE u.phone_hash = uc.contact_phone_hash) AS matched_user_id,
            (SELECT display_name FROM users u WHERE u.phone_hash = uc.contact_phone_hash) AS matched_name
     FROM user_contacts uc
     WHERE uc.user_id = $1
     ORDER BY uc.contact_name`,
    [myId]
  );
  console.log(`\n📞 Rehberimde ${contacts.rows.length} kayıt:`);
  contacts.rows.forEach((c) => {
    const status = c.matched_user_id ? `✓ Abadan kullanıcısı: ${c.matched_name}` : "✗ Abadan'da kayıtlı değil";
    console.log(`  - ${c.contact_name.padEnd(20)} → ${status}`);
  });

  const visibleUserIds = contacts.rows.filter((c) => c.matched_user_id).map((c) => c.matched_user_id);
  console.log(`\n👥 Görünür olabilecek satıcı sayısı: ${visibleUserIds.length}`);

  // 3) Bu kullanıcıların ilanları
  if (visibleUserIds.length === 0) {
    console.log('❌ Görünür satıcı yok, hiç ilan gelmez.');
    return;
  }

  const listings = await pool.query(
    `SELECT l.id, l.title, l.status, l.restricted_to_gender, l.user_id,
            u.display_name AS seller_name
     FROM listings l
     JOIN users u ON u.id = l.user_id
     WHERE l.user_id = ANY($1::uuid[])
     ORDER BY l.created_at DESC`,
    [visibleUserIds]
  );
  console.log(`\n📦 Toplam ${listings.rows.length} ilan:`);
  listings.rows.forEach((l) => {
    const flag = l.status === 'active' ? '✓' : '⚠';
    const genderTag = l.restricted_to_gender ? ` [${l.restricted_to_gender} özel]` : '';
    console.log(`  ${flag} ${l.title.slice(0, 50).padEnd(50)} | ${l.seller_name.padEnd(15)} | ${l.status}${genderTag}`);
  });

  // 4) Gizlenmiş ilanlar
  const hidden = await pool.query(
    'SELECT COUNT(*)::int AS n FROM hidden_listings WHERE user_id = $1',
    [myId]
  );
  console.log(`\n👁  Senin gizlediğin ilan sayısı: ${hidden.rows[0].n}`);

  // 5) /listings endpoint'inin uygulayacağı tam filtre simülasyonu
  const myGender = me.rows[0].gender;
  const genderCond = (myGender === 'female' || myGender === 'male')
    ? `(l.restricted_to_gender IS NULL OR l.restricted_to_gender = '${myGender}')`
    : `(l.restricted_to_gender IS NULL)`;

  const filtered = await pool.query(
    `SELECT COUNT(*)::int AS n FROM listings l
     WHERE l.user_id = ANY($1::uuid[])
       AND l.user_id <> $2
       AND l.status = 'active'
       AND ${genderCond}
       AND l.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $2)`,
    [visibleUserIds, myId]
  );
  console.log(`\n🎯 /listings endpoint'inin döneceği ilan sayısı: ${filtered.rows[0].n}`);

  if (filtered.rows[0].n === 0 && listings.rows.length > 0) {
    console.log('\n⚠️ DB\'de ilan var ama filtre hepsini eliyor:');
    console.log('   - gender:', myGender, '— Cinsiyet kısıtlı ilan varsa elenmiş olabilir');
    console.log('   - status: sadece active sayılır, listing.status sütununa bak');
  }

  await pool.end();
}

main().catch((e) => { console.error('Hata:', e); pool.end(); });
