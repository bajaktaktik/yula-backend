// Yula - Kategorileri yulacat.txt (sahibinden.com formatı) dosyasından kurar.
// Kullanım: node scripts/seed-categories.js
//
// Bu script:
//   1. categories tablosunu temizler
//   2. listings.category_id'leri NULL'lar (FK kırılmasın)
//   3. yulacat.txt'yi okur, recursive olarak hiyerarşik kategori ağacını oluşturur

const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

const CAT_FILE = path.join(__dirname, '..', '..', 'yulacat.txt');

// Ana kategori slug'larına emoji ikonları
const TOP_ICONS = {
  'emlak': 'home',
  'vasita': 'car',
  'yedek-parca-aksesuar': 'wrench',
  'ikinci-el-sifir-alisveris': 'shopping',
  'is-makineleri-sanayi': 'factory',
  'ustalar-ve-hizmetler': 'tools',
  'ozel-ders-verenler': 'book',
  'is-ilanlari': 'briefcase',
  'hayvanlar-alemi': 'paw',
  'yardimci-arayanlar': 'helping',
};

async function insertNode(client, node, parentId, ordering) {
  const icon = parentId === null ? (TOP_ICONS[node.id] || 'box') : null;
  const r = await client.query(
    `INSERT INTO categories (parent_id, name, slug, icon, ordering) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [parentId, node.name, node.id, icon, ordering]
  );
  const id = r.rows[0].id;

  // Çocukları recursive olarak ekle
  if (Array.isArray(node.subCategories) && node.subCategories.length > 0) {
    let childOrder = 0;
    for (const child of node.subCategories) {
      childOrder++;
      await insertNode(client, child, id, childOrder);
    }
  }
}

function countAll(nodes) {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (Array.isArray(node.subCategories)) n += countAll(node.subCategories);
  }
  return n;
}

async function main() {
  if (!fs.existsSync(CAT_FILE)) {
    console.error(`Dosya bulunamadı: ${CAT_FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CAT_FILE, 'utf8');
  const tree = JSON.parse(raw);
  if (!Array.isArray(tree)) {
    console.error('Geçersiz format: dizi bekleniyor');
    process.exit(1);
  }

  const total = countAll(tree);
  console.log(`Toplam ${tree.length} ana kategori, ${total} toplam düğüm.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Mevcut ilanların category_id\'si NULL\'lanıyor...');
    await client.query('UPDATE listings SET category_id = NULL');

    console.log('Eski kategoriler temizleniyor...');
    await client.query('DELETE FROM categories');
    await client.query('ALTER SEQUENCE categories_id_seq RESTART WITH 1');

    let order = 0;
    for (const top of tree) {
      order += 10;
      await insertNode(client, top, null, order);
    }

    await client.query('COMMIT');
    console.log(`\n🎉 ${total} kategori başarıyla yüklendi (${tree.length} ana + alt + alt-alt).`);
    console.log('   Mevcut ilanların kategorisi NULL — gerekirse seed-listings/free/negotiable\'ı tekrar çalıştır.');
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
