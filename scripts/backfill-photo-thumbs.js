// Eski yüklenmiş foto kayıtları için thumb_url üretir.
// listing_photos tablosunda thumb_url IS NULL olan her satır için:
//  - url (data:image/...;base64,...) varsa decode → 400px'e küçült → q=0.4 JPEG → thumb_url'e yaz
//  - https URL ise dokunmaz (Unsplash gibi external linkleri zaten küçük varsay)
//
// Kullanım: node scripts/backfill-photo-thumbs.js

const Jimp = require('jimp');
const pool = require('../src/db/pool');

async function processOne(id, url) {
  if (!url) return null;

  // External URL ise (data: ile başlamıyorsa) — backend'in COALESCE'ı bunu zaten kullanır.
  // Boyutu kontrol etmek pahalı olur, geç.
  if (!url.startsWith('data:image')) {
    // Aynı url'i thumb olarak işaretle ki yine fallback olarak işe yarasın
    return url;
  }

  // base64 kısmını çıkar
  const m = url.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');

  const img = await Jimp.read(buf);
  img.scaleToFit(400, 400);
  img.quality(45);
  const outBuf = await img.getBufferAsync(Jimp.MIME_JPEG);
  return `data:image/jpeg;base64,${outBuf.toString('base64')}`;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, url FROM listing_photos WHERE thumb_url IS NULL`
  );
  console.log(`🖼  ${rows.length} foto işlenecek...`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const thumb = await processOne(r.id, r.url);
      if (thumb) {
        await pool.query('UPDATE listing_photos SET thumb_url = $1 WHERE id = $2', [thumb, r.id]);
        done++;
        if (done % 10 === 0) console.log(`  • ${done}/${rows.length} tamamlandı`);
      } else {
        skipped++;
      }
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${r.id} işlenemedi: ${e.message}`);
    }
  }

  console.log(`\n✓ Bitti — ${done} thumb üretildi, ${skipped} atlandı, ${failed} hatalı`);
  await pool.end();
}

main().catch((e) => {
  console.error('✗ Backfill hata:', e);
  pool.end();
  process.exit(1);
});
