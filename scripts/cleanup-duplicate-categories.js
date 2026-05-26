// Aynı isimli kategorilerden boş (alt kategorisi olmayan) olanları siler.
// Önceki seed'lerden kalan kalıntıları temizler.
// Kullanım: node scripts/cleanup-duplicate-categories.js

const pool = require('../src/db/pool');

async function main() {
  const client = await pool.connect();
  try {
    // Aynı isimden 2+ kayıt olan kategorileri bul
    const { rows: dupes } = await client.query(`
      SELECT name, COUNT(*) AS cnt
      FROM categories
      GROUP BY name
      HAVING COUNT(*) > 1
    `);

    if (dupes.length === 0) {
      console.log('Duplikate kategori yok.');
      return;
    }

    console.log(`${dupes.length} farklı isimde duplikate var:`);
    let totalDeleted = 0;

    for (const d of dupes) {
      // Bu isimle olan tüm satırları al, çocuk sayısıyla
      const { rows: items } = await client.query(`
        SELECT c.id, c.slug, c.parent_id,
               (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id = c.id) AS child_count,
               (SELECT COUNT(*) FROM listings l WHERE l.category_id = c.id) AS listing_count
        FROM categories c
        WHERE c.name = $1
        ORDER BY child_count DESC, listing_count DESC, id ASC
      `, [d.name]);

      // İlk satır en "iyi" (en çok çocuğu ve ilanı olan) — koru
      const keep = items[0];
      const drop = items.slice(1).filter((it) => it.child_count == 0 && it.listing_count == 0);

      if (drop.length === 0) {
        console.log(`  • "${d.name}": ${items.length} kayıt var ama hepsi dolu (silinmedi)`);
        continue;
      }

      for (const x of drop) {
        await client.query('DELETE FROM categories WHERE id = $1', [x.id]);
        totalDeleted++;
      }
      console.log(`  • "${d.name}": ${items.length} → ${items.length - drop.length} (${drop.length} boş silindi, slug=${keep.slug} kaldı)`);
    }

    console.log(`\n✓ Toplam ${totalDeleted} boş duplikate silindi.`);
  } catch (err) {
    console.error('Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
