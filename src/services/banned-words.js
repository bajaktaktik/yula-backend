// Yasak kelime kontrolü — servis.
// - DB'den periyodik olarak yükler (60 saniye cache)
// - checkText(text) → { blocked: bool, matched_pattern?, message? }
// - Preset seeds — TR yaygın örnekler (whatsapp numarası, para transferi vb.)
//
// Admin panelde eklenip silinen kelimeler DB'ye gider; cache max 60 saniye sonra yenilenir.

const pool = require('../db/pool');

let cache = { words: [], loadedAt: 0 };
const CACHE_TTL_MS = 60 * 1000; // 60 sn

async function loadWords() {
  const now = Date.now();
  if (now - cache.loadedAt < CACHE_TTL_MS && cache.words.length > 0) return cache.words;
  try {
    const r = await pool.query(
      'SELECT id, pattern, is_regex, category, message FROM banned_words'
    );
    const compiled = r.rows.map((w) => {
      let regex;
      try {
        if (w.is_regex) {
          regex = new RegExp(w.pattern, 'i');
        } else {
          // Kelime olarak eşle — Unicode-safe. TR harfleri regex'te sorun çıkarmaz.
          // Word boundary yerine "arada whitespace/punctuation" kullan çünkü \b TR harflerinde tutarsız.
          const escaped = w.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          regex = new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '($|[^\\p{L}\\p{N}])', 'iu');
        }
      } catch {
        return null;
      }
      return { id: w.id, regex, pattern: w.pattern, category: w.category, message: w.message };
    }).filter(Boolean);
    cache = { words: compiled, loadedAt: now };
    return compiled;
  } catch (err) {
    console.error('[banned-words] load fail:', err.message);
    return cache.words; // eski cache'i döndür
  }
}

// Metinde yasak kelime var mı kontrol et; ilki matched olarak döndürülür
async function checkText(text) {
  if (!text) return { blocked: false };
  const words = await loadWords();
  for (const w of words) {
    if (w.regex.test(text)) {
      return {
        blocked: true,
        matched_pattern: w.pattern,
        category: w.category,
        message: w.message || getDefaultMessage(w.category),
      };
    }
  }
  return { blocked: false };
}

function getDefaultMessage(category) {
  const msgs = {
    iletisim: 'İlan içeriği doğrudan iletişim bilgisi içeremez. Sohbet uygulama içinde yapılır.',
    yasadisi: 'Yasal olmayan içerik yayınlayamazsın.',
    dolandiricilik: 'Bu tür ifadeler dolandırıcılık şüphesi taşıyor ve yayınlanamaz.',
    spam: 'Bu içerik spam olarak işaretlendi.',
  };
  return msgs[category] || 'İlan içeriği kabul edilmedi.';
}

// Cache'i temizle (admin banned-word ekleyip/silince çağrılabilir)
function invalidateCache() {
  cache = { words: [], loadedAt: 0 };
}

module.exports = { checkText, invalidateCache, loadWords };
