// Apk/Cat1.xlsx dosyasındaki kategorileri DB'ye uygular.
// Mevcut tüm kategorileri siler, yenisini hiyerarşik ekler, ilanları
// isim eşleşmesiyle yeni kategorilere bağlar (eşleşmeyen → "Diğer Her Şey").
//
// Excel formatı: 3 sütun [Ana Kategori | Alt Kategori | 3. Seviye / Marka]
// L1/L2 sadece grup başında yazılır, alttaki satırlarda boş bırakılır (forward-fill).
//
// Kullanım: node scripts/seed-categories-from-xlsx.js [--file <path>]

const path = require('path');
const XLSX = require('xlsx');
const pool = require('../src/db/pool');

const DEFAULT_XLSX = path.join(__dirname, '..', '..', 'Cat1.xlsx');

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/é/g, 'e').replace(/ñ/g, 'n').replace(/&/g, 've')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function readTree(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath);
  const sheetName = wb.SheetNames.includes('Kategoriler') ? 'Kategoriler' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let curL1 = null;
  let curL2 = null;
  const tree = [];

  // İlk satır header — atla
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const l1 = row[0] && String(row[0]).trim();
    const l2 = row[1] && String(row[1]).trim();
    const l3 = row[2] && String(row[2]).trim();

    if (l1) {
      curL1 = { name: l1, children: [] };
      tree.push(curL1);
      curL2 = null;
    }
    if (l2 && curL1) {
      curL2 = { name: l2, children: [] };
      curL1.children.push(curL2);
    }
    if (l3 && curL2) {
      curL2.children.push({ name: l3 });
    }
  }
  return tree;
}

function buildKeyMaps(tree) {
  // L1 ve L2 için isim → mevcut tree node referansı
  const l1ByName = new Map();   // 'emlak' (lower) → l1Node
  const l2ByPath = new Map();   // 'emlak||konut' → l2Node
  const l3ByPath = new Map();   // 'emlak||konut||satılık' → l3Node
  for (const l1 of tree) {
    l1ByName.set(l1.name.toLowerCase(), l1);
    for (const l2 of l1.children) {
      l2ByPath.set(`${l1.name.toLowerCase()}||${l2.name.toLowerCase()}`, l2);
      for (const l3 of l2.children) {
        l3ByPath.set(`${l1.name.toLowerCase()}||${l2.name.toLowerCase()}||${l3.name.toLowerCase()}`, l3);
      }
    }
  }
  return { l1ByName, l2ByPath, l3ByPath };
}

async function main() {
  const args = process.argv.slice(2);
  const fIdx = args.indexOf('--file');
  const xlsxPath = fIdx >= 0 ? args[fIdx + 1] : DEFAULT_XLSX;

  console.log(`📂 Okunuyor: ${xlsxPath}`);
  const tree = readTree(xlsxPath);
  let totals = { l1: tree.length, l2: 0, l3: 0 };
  for (const a of tree) {
    totals.l2 += a.children.length;
    for (const b of a.children) totals.l3 += b.children.length;
  }
  console.log(`📊 Yeni hiyerarşi: ${totals.l1} ana, ${totals.l2} alt, ${totals.l3} marka/leaf`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Mevcut ilanların kategori bilgisini yedekle (isimle eşleştirmek için)
    const oldListings = await client.query(`
      SELECT l.id AS listing_id, l.title,
             c.name AS l_name, c.slug AS l_slug,
             p.name AS p_name, p.slug AS p_slug,
             gp.name AS gp_name, gp.slug AS gp_slug
      FROM listings l
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
      LEFT JOIN categories gp ON gp.id = p.parent_id
    `);
    console.log(`📝 ${oldListings.rows.length} ilan kayıtlı, kategori eşleşmesi sonra yapılacak`);

    // 2) Eski kategorileri sil (ON DELETE SET NULL → listings.category_id otomatik nullanır)
    const del = await client.query('DELETE FROM categories');
    console.log(`🗑  ${del.rowCount} eski kategori silindi`);

    // 3) Yeni hiyerarşiyi ekle ve slug → id map'i tut
    const idByPath = new Map(); // 'l1||l2||l3' (lower) → id
    let l1Ord = 1;
    for (const l1 of tree) {
      const l1Slug = slugify(l1.name);
      const r1 = await client.query(
        `INSERT INTO categories (parent_id, name, slug, ordering) VALUES (NULL, $1, $2, $3) RETURNING id`,
        [l1.name, l1Slug, l1Ord++]
      );
      const l1Id = r1.rows[0].id;
      idByPath.set(l1.name.toLowerCase(), l1Id);

      let l2Ord = 1;
      for (const l2 of l1.children) {
        const l2Slug = `${l1Slug}-${slugify(l2.name)}`;
        const r2 = await client.query(
          `INSERT INTO categories (parent_id, name, slug, ordering) VALUES ($1, $2, $3, $4) RETURNING id`,
          [l1Id, l2.name, l2Slug, l2Ord++]
        );
        const l2Id = r2.rows[0].id;
        idByPath.set(`${l1.name.toLowerCase()}||${l2.name.toLowerCase()}`, l2Id);

        let l3Ord = 1;
        for (const l3 of l2.children) {
          const l3Slug = `${l2Slug}-${slugify(l3.name)}`;
          const r3 = await client.query(
            `INSERT INTO categories (parent_id, name, slug, ordering) VALUES ($1, $2, $3, $4) RETURNING id`,
            [l2Id, l3.name, l3Slug, l3Ord++]
          );
          idByPath.set(
            `${l1.name.toLowerCase()}||${l2.name.toLowerCase()}||${l3.name.toLowerCase()}`,
            r3.rows[0].id
          );
        }
      }
    }
    console.log(`✓ ${idByPath.size} kategori eklendi`);

    // 4) İlanları yeni kategorilere bağla — derinden başlayarak eşle
    const fallback =
      idByPath.get('ikinci el ve sıfır alışveriş||diğer her şey') ||
      idByPath.get('i̇kinci el ve sıfır alışveriş||diğer her şey') ||
      idByPath.get('ikinci el ve sıfır alışveriş');

    let matched = 0, fellBack = 0, leftNull = 0;
    for (const l of oldListings.rows) {
      let newId = null;

      // 3. seviye: gp_name > p_name > l_name (gp=grandparent, p=parent, l=leaf)
      if (l.gp_name && l.p_name && l.l_name) {
        newId = idByPath.get(`${l.gp_name.toLowerCase()}||${l.p_name.toLowerCase()}||${l.l_name.toLowerCase()}`);
      }
      // 2. seviye: p_name > l_name
      if (!newId && l.p_name && l.l_name) {
        newId = idByPath.get(`${l.p_name.toLowerCase()}||${l.l_name.toLowerCase()}`);
      }
      // 1. seviye: sadece l_name (top-level)
      if (!newId && l.l_name) {
        newId = idByPath.get(l.l_name.toLowerCase());
      }

      if (newId) {
        await client.query('UPDATE listings SET category_id = $1 WHERE id = $2', [newId, l.listing_id]);
        matched++;
      } else if (fallback) {
        await client.query('UPDATE listings SET category_id = $1 WHERE id = $2', [fallback, l.listing_id]);
        fellBack++;
      } else {
        leftNull++;
      }
    }
    console.log(`🔗 İlanlar: ${matched} eşleşti, ${fellBack} fallback'a düştü, ${leftNull} null kaldı`);

    await client.query('COMMIT');
    console.log('\n✓ Tamamlandı. Uygulamada Kategoriler sekmesini yenile.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ Hata:', err);
    process.exit(1);
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
