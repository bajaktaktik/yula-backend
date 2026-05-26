// Vasıta altındaki çift Otomobil/Motosiklet kategorilerini birleştirir.
// Doğru olan: vasita-otomobil, vasita-motosiklet (yulacat.txt'den gelen)
// Yanlış (eski seed kalıntısı): slug=otomobil, slug=motosiklet
//
// Yapılan:
//  1. Yanlış olanın ALT KATEGORİLERİ (marka vs.) doğru olana taşınır
//  2. Yanlış olana bağlı İLANLAR doğru olana yeniden bağlanır
//  3. Yanlış olan silinir
//  4. Mevcut durum raporlanır
//
// Kullanım: node scripts/dedupe-vehicle-categories.js

const pool = require('../src/db/pool');

async function reportState() {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug, c.parent_id,
           p.name AS parent_name,
           (SELECT COUNT(*)::int FROM categories WHERE parent_id = c.id) AS child_count,
           (SELECT COUNT(*)::int FROM listings WHERE category_id = c.id) AS listing_count
    FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE c.name IN ('Otomobil','Motosiklet')
    ORDER BY c.name, c.slug
  `);
  console.log('\n📋 Mevcut durum:');
  for (const r of rows) {
    console.log(`  [${r.id}] ${r.name} (slug=${r.slug}) → parent=${r.parent_name || 'YOK'} | ${r.child_count} alt, ${r.listing_count} ilan`);
  }
  return rows;
}

async function merge(correctSlug, wrongSlug) {
  // Doğru kategoriyi bul
  const right = await pool.query('SELECT id, name FROM categories WHERE slug = $1', [correctSlug]);
  if (right.rows.length === 0) {
    console.warn(`  ⚠ "${correctSlug}" bulunamadı, atlanıyor`);
    return;
  }
  const rightId = right.rows[0].id;
  const rightName = right.rows[0].name;

  // Yanlış kategorileri bul (slug=otomobil veya slug=motosiklet AMA aynı isimle başka kayıtlar da var olabilir)
  // Stratejimiz: aynı isimde olup slug doğru olmayan tüm kayıtları yanlış say
  const wrong = await pool.query(
    `SELECT id, slug FROM categories WHERE name = $1 AND slug <> $2`,
    [rightName, correctSlug]
  );
  if (wrong.rows.length === 0) {
    console.log(`  ✓ ${rightName}: çift kayıt yok`);
    return;
  }

  for (const w of wrong.rows) {
    console.log(`  ↪ ${rightName}: yanlış kayıt ${w.id} (slug=${w.slug}) birleştiriliyor → ${rightId}`);

    // Alt kategorileri (markalar vs.) doğruya taşı
    const childMv = await pool.query(
      `UPDATE categories SET parent_id = $1 WHERE parent_id = $2`,
      [rightId, w.id]
    );
    if (childMv.rowCount > 0) console.log(`    • ${childMv.rowCount} alt kategori taşındı`);

    // İlanları doğruya bağla
    const listingMv = await pool.query(
      `UPDATE listings SET category_id = $1 WHERE category_id = $2`,
      [rightId, w.id]
    );
    if (listingMv.rowCount > 0) console.log(`    • ${listingMv.rowCount} ilan yeniden bağlandı`);

    // Favorites/hidden ile referans yok (foreign key category_id sadece listings'te)

    // Yanlış kategoriyi sil
    await pool.query('DELETE FROM categories WHERE id = $1', [w.id]);
    console.log(`    • Yanlış kayıt silindi`);
  }
}

async function main() {
  console.log('🔧 Vasıta kategori temizliği başlıyor...\n');

  console.log('=== Önce ===');
  await reportState();

  console.log('\n=== Birleştirme ===');
  await merge('vasita-otomobil', 'otomobil');
  await merge('vasita-motosiklet', 'motosiklet');

  console.log('\n=== Sonra ===');
  await reportState();

  console.log('\n✓ Temizlik tamamlandı. Uygulamada kategori listesini yenile.');
  await pool.end();
}

main().catch((e) => {
  console.error('✗ Hata:', e);
  pool.end();
  process.exit(1);
});
