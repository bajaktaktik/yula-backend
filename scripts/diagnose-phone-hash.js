// Telefon hash uyuşmazlığı tanı scripti — geçici, sil/sakla.
// Kullanım:
//   DATABASE_URL="..." PHONE_HASH_PEPPER="..." node scripts/diagnose-phone-hash.js +905052328699

const crypto = require('crypto');
const { Pool } = require('pg');

const e164 = process.argv[2];
if (!e164) {
  console.error('Kullanım: node scripts/diagnose-phone-hash.js +905XXXXXXXX');
  process.exit(1);
}

const pepper = process.env.PHONE_HASH_PEPPER;
if (!pepper) {
  console.error('PHONE_HASH_PEPPER env yok!');
  process.exit(1);
}

const clientSha = crypto.createHash('sha256').update(e164).digest('hex');
const expectedWithPepper = crypto.createHmac('sha256', pepper).update(clientSha).digest('hex');
const expectedNoPepper = crypto.createHmac('sha256', 'no-pepper-set').update(clientSha).digest('hex');
const expectedEmptyPepper = crypto.createHmac('sha256', '').update(clientSha).digest('hex');

console.log('=== Tanı ===');
console.log('Aranılan e164      :', e164);
console.log('Pepper (ilk 8)     :', pepper.slice(0, 8) + '...');
console.log('Pepper uzunluğu    :', pepper.length, 'karakter');
console.log('Client SHA         :', clientSha);
console.log('Beklenen (verilen) :', expectedWithPepper);
console.log('Eğer no-pepper-set :', expectedNoPepper);
console.log('Eğer boş pepper    :', expectedEmptyPepper);
console.log('');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query('SELECT id, display_name, phone_hash, created_at FROM users ORDER BY created_at DESC LIMIT 10')
  .then((r) => {
    console.log('=== Son 10 kullanıcı (en yenisi üstte) ===');
    r.rows.forEach((u) => {
      const mark = u.phone_hash === expectedWithPepper ? '✓ EŞLEŞME' : '   ';
      console.log(
        mark,
        u.created_at?.toISOString().slice(0, 19),
        '|',
        (u.display_name || '(isimsiz)').padEnd(20),
        '|',
        u.phone_hash?.slice(0, 16) + '...'
      );
    });
    console.log('');
    const match = r.rows.find((u) => u.phone_hash === expectedWithPepper);
    const matchNoPepper = r.rows.find((u) => u.phone_hash === expectedNoPepper);
    const matchEmpty = r.rows.find((u) => u.phone_hash === expectedEmptyPepper);
    if (match) {
      console.log('✅ EŞLEŞME BULUNDU (verilen pepper) — user_id:', match.id);
    } else if (matchNoPepper) {
      console.log('⚠️ EŞLEŞME (no-pepper-set default) — Railway env yüklü değil!');
    } else if (matchEmpty) {
      console.log('⚠️ EŞLEŞME (boş pepper) — PHONE_HASH_PEPPER="" olarak set edilmiş.');
    } else {
      console.log('❌ Hiçbir pepper ile eşleşme yok.');
      console.log('Bu, Railway\'deki gerçek pepper değerinin verdiğin değerden farklı olduğu anlamına gelir.');
    }
    pool.end();
  })
  .catch((e) => {
    console.error('Hata:', e.message);
    pool.end();
  });
