// category_id=NULL olan mevcut ilanları title/açıklama anahtar kelimelerine göre
// yulacat.txt'deki yeni kategorilere eşleştirir.
//
// Kullanım: node scripts/fix-listing-categories.js

const pool = require('../src/db/pool');

// Title içinde bu kelimeler geçerse → şu slug'a ata (öncelik sırasına göre)
const KEYWORD_TO_SLUG = [
  { kw: ['iphone', 'samsung', 'telefon', 'cep telefonu'], slug: 'cep-telefonu-aksesuar' },
  { kw: ['macbook', 'laptop', 'dizüstü', 'masaüstü'], slug: 'bilgisayar' },
  { kw: ['tablet', 'ipad'], slug: 'bilgisayar' },
  { kw: ['canon', 'nikon', 'sony', 'fotoğraf makinesi', 'kamera'], slug: 'fotograf-kamera' },
  { kw: ['lamba', 'aydınlatma', 'çekyat', 'koltuk', 'mobilya', 'masa', 'sandalye'], slug: 'ev-dekorasyon' },
  { kw: ['saksı', 'toprak', 'bahçe'], slug: 'bahce-yapi-market' },
  { kw: ['tencere', 'tava', 'mutfak'], slug: 'ev-dekorasyon' },
  { kw: ['kindle', 'kitap'], slug: 'kitap-dergi-film' },
  { kw: ['plak', 'cd', 'dvd', 'film'], slug: 'kitap-dergi-film' },
  { kw: ['piyano', 'gitar', 'müzik aleti'], slug: 'muzik' },
  { kw: ['kulaklık', 'bose', 'jbl'], slug: 'ev-elektroniği' },
  { kw: ['tv', 'televizyon'], slug: 'ev-elektroniği' },
  { kw: ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo'], slug: 'oyunculara-ozel' },
  { kw: ['oyuncak', 'lego'], slug: 'hobi-oyuncak' },
  { kw: ['bisiklet', 'trek', 'spor'], slug: 'spor' },
  { kw: ['mama sandalyesi', 'puset', 'bebek', 'bebek bezi'], slug: 'anne-bebek' },
  { kw: ['ceket', 'ayakkabı', 'adidas', 'nike', 'giyim', 'tişört', 'pantolon'], slug: 'giyim-aksesuar' },
  { kw: ['kedi maması', 'köpek', 'kedi'], slug: 'hayvanlar-alemi' },
  { kw: ['tablo', 'sanat', 'el işi'], slug: 'ikinci-el-sifir-alisveris' },
];

async function main() {
  const client = await pool.connect();
  try {
    const slugMap = await client.query('SELECT id, slug FROM categories');
    const slugToId = new Map(slugMap.rows.map(r => [r.slug, r.id]));

    const { rows: nullListings } = await client.query(
      `SELECT id, title, description FROM listings WHERE category_id IS NULL`
    );
    console.log(`${nullListings.length} kategorisi NULL olan ilan bulundu.`);

    let updated = 0;
    let unmatched = 0;
    for (const l of nullListings) {
      const text = `${l.title} ${l.description || ''}`.toLowerCase();
      let matched = null;
      for (const rule of KEYWORD_TO_SLUG) {
        if (rule.kw.some(k => text.includes(k.toLowerCase()))) {
          matched = rule.slug;
          break;
        }
      }
      if (!matched) {
        unmatched++;
        continue;
      }
      const catId = slugToId.get(matched);
      if (!catId) continue;
      await client.query('UPDATE listings SET category_id = $1 WHERE id = $2', [catId, l.id]);
      updated++;
    }
    console.log(`✓ ${updated} ilan güncellendi`);
    if (unmatched > 0) console.log(`! ${unmatched} ilan eşleşmedi (Diğer Her Şey'e bırakıldı)`);

    // Eşleşmeyenleri Diğer Her Şey'e at
    const digerId = slugToId.get('diger-her-sey');
    if (digerId && unmatched > 0) {
      const r = await client.query(
        `UPDATE listings SET category_id = $1 WHERE category_id IS NULL`,
        [digerId]
      );
      console.log(`✓ ${r.rowCount} eşleşmeyen ilan "Diğer Her Şey"e atandı`);
    }
  } catch (err) {
    console.error('Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
