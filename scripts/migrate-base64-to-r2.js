// Base64 → R2 migration
//
// DB'deki listing_photos.url ve thumb_url alanlarında hala base64
// (data:image/... ile başlayan) veriler varsa, bunları R2'ye upload edip
// DB'deki URL'i public R2 URL'i ile değiştirir.
//
// KULLANIM:
//   Railway shell'de:   node scripts/migrate-base64-to-r2.js
//   Local'de:          .env doldur, sonra:  node scripts/migrate-base64-to-r2.js
//
// GÜVENLİK:
// - Idempotent: sadece base64 kayıtları alır, http:// URL'lere dokunmaz
// - Fail-safe: bir foto fail olsa da diğerleri devam eder
// - Progress log ile ilerleme görünür

require('dotenv').config();
const pool = require('../src/db/pool');
const storage = require('../src/services/storage');

async function main() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  Base64 → R2 Migration');
  console.log('═══════════════════════════════════════════════\n');

  // Önce R2 config'i doğrula
  if (!storage.isReady()) {
    console.error('❌ R2 config eksik. Gereken env: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_PUBLIC_URL');
    process.exit(1);
  }

  // Kaç kayıt var? Ön sorgu
  const countRes = await pool.query(`
    SELECT COUNT(*)::int AS n
    FROM listing_photos
    WHERE url LIKE 'data:image/%' OR thumb_url LIKE 'data:image/%'
  `);
  const total = countRes.rows[0].n;

  if (total === 0) {
    console.log('✓ Migrate edilecek base64 foto yok. Zaten hepsi R2\'de.');
    await pool.end();
    return;
  }

  console.log(`📦 ${total} base64 kayıt bulundu. Migration başlıyor...\n`);

  const { rows } = await pool.query(`
    SELECT lp.id, lp.listing_id, lp.url, lp.thumb_url, l.user_id
    FROM listing_photos lp
    LEFT JOIN listings l ON l.id = lp.listing_id
    WHERE lp.url LIKE 'data:image/%' OR lp.thumb_url LIKE 'data:image/%'
    ORDER BY lp.listing_id, lp.ordering
  `);

  let ok = 0, fail = 0;
  let processed = 0;

  for (const row of rows) {
    processed++;
    const prefix = `[${processed}/${total}] photo=${row.id.slice(0, 8)}`;

    try {
      let newUrl = row.url;
      let newThumbUrl = row.thumb_url;
      let uploadedBytes = 0;

      // Full url base64 ise upload et
      if (typeof row.url === 'string' && row.url.startsWith('data:image/')) {
        const parsed = storage.parseDataUrl(row.url);
        if (!parsed) {
          console.warn(`  ${prefix} skipped: full url parse fail`);
        } else {
          newUrl = await storage.uploadPhoto(parsed.buffer, parsed.contentType, {
            userId: row.user_id || 'migrated',
            prefix: 'listings',
          });
          uploadedBytes += parsed.buffer.length;
        }
      }

      // Thumb base64 ise upload et
      if (typeof row.thumb_url === 'string' && row.thumb_url.startsWith('data:image/')) {
        const parsed = storage.parseDataUrl(row.thumb_url);
        if (!parsed) {
          console.warn(`  ${prefix} skipped: thumb parse fail`);
        } else {
          newThumbUrl = await storage.uploadPhoto(parsed.buffer, parsed.contentType, {
            userId: row.user_id || 'migrated',
            prefix: 'listings',
          });
          uploadedBytes += parsed.buffer.length;
        }
      }

      // DB'yi güncelle
      if (newUrl !== row.url || newThumbUrl !== row.thumb_url) {
        await pool.query(
          'UPDATE listing_photos SET url = $1, thumb_url = $2 WHERE id = $3',
          [newUrl, newThumbUrl, row.id]
        );
        ok++;
        console.log(`  ${prefix} ✓ (${(uploadedBytes / 1024).toFixed(1)}KB)`);
      }
    } catch (err) {
      fail++;
      console.error(`  ${prefix} ✗`, err.message);
    }
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  ✓ Başarılı:  ${ok}`);
  console.log(`  ✗ Fail:      ${fail}`);
  console.log(`  Toplam:      ${total}`);
  console.log('═══════════════════════════════════════════════\n');

  // Doğrulama sorgusu
  const verifyRes = await pool.query(`
    SELECT COUNT(*)::int AS n
    FROM listing_photos
    WHERE url LIKE 'data:image/%' OR thumb_url LIKE 'data:image/%'
  `);
  const remaining = verifyRes.rows[0].n;
  if (remaining === 0) {
    console.log('🎉 Tüm base64 kayıtlar migrate edildi. DB temiz.');
  } else {
    console.log(`⚠️  ${remaining} kayıt hala base64 (fail'lı olabilir). Tekrar çalıştırabilirsin.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('\n[migrate] FATAL:', err);
  process.exit(1);
});
