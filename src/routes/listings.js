const express = require('express');
const Joi = require('joi');
const pool = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const graph = require('../services/graph');

const router = express.Router();

const createSchema = Joi.object({
  // Min 2: "TV", "PC", "Ev" gibi kısa isimler yaygın. Matlub ile de tutarlı.
  title: Joi.string().min(2).max(120).required(),
  // Açıklama min kısıtı yok — kısa veya boş bile olabilir
  description: Joi.string().max(4000).allow('').default(''),
  categoryId: Joi.number().integer().required(),
  // 0 = ücretsiz (hibe) veya "ne verirsen"
  price: Joi.number().min(0).required(),
  currency: Joi.string().valid('TRY', 'USD', 'EUR').default('TRY'),
  locationCity: Joi.string().max(80).optional(),
  locationDistrict: Joi.string().max(80).optional(),
  photoUrls: Joi.array().items(Joi.string()).max(8).default([]),
  // Mobil tarafında her foto için 1000px full + 400px thumb üretiliyor;
  // ikincisi listelerde hızlı yüklenmek için. Şemada açıkça izin ver, yoksa Joi "not allowed".
  photoThumbs: Joi.array().items(Joi.string()).max(8).default([]),
  restrictedToGender: Joi.string().valid('female', 'male').allow(null).optional(),
  isNegotiable: Joi.boolean().default(false),
  ghostMode: Joi.boolean().default(false), // ilan-bazlı hayalet — kullanıcı normal olsa da bu ilan hayalet
});

// Kullanıcının cinsiyetini DB'den çek (route handler'lar için yardımcı)
async function getMyGender(userId) {
  const { rows } = await pool.query('SELECT gender FROM users WHERE id = $1', [userId]);
  return rows[0]?.gender || null;
}

// SQL parçası: bu kullanıcının cinsiyet kısıtlı ilanları görme kuralı.
// MAHREMİYET: kısıtlı ilanlar opposite cinsiyete ve cinsiyetsiz kullanıcılara
// HİÇ görünmez — varlıklarından dahi haberdar olmazlar.
function genderFilter(viewerGender) {
  if (viewerGender === 'female' || viewerGender === 'male') {
    return `(l.restricted_to_gender IS NULL OR l.restricted_to_gender = '${viewerGender}')`;
  }
  // Cinsiyet belirtmemiş veya null — sadece kısıtsız ilanları görür
  return `(l.restricted_to_gender IS NULL)`;
}

// GET /listings  →  kullanıcının görebildiği akış
// Sorgu parametreleri:
//   q          : arama metni (title + description üzerinde ILIKE)
//   categoryId : kategori id (parent ise tüm alt kategoriler de dahil edilir)
//   minPrice   : min fiyat
//   maxPrice   : max fiyat
//   city       : şehir
//   limit, offset
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const includeSecondDegree =
      req.query.includeSecondDegree === '1' || req.query.includeSecondDegree === 'true';
    // viaUserId: sadece belirli 1. derece tanıdığın rehberindeki 2. derece kullanıcıların ilanları
    // Kullanıcının rehberinde OLMAYAN kişiler filtresi uygulanır.
    const viaUserId = req.query.viaUserId ? String(req.query.viaUserId) : null;

    const visible = await graph.getVisibleUserIds(req.userId); // 1. derece
    const tierMap = new Map(); // user_id → { tier, via_user_id, via_name, mutual_count }

    if (viaUserId) {
      // Sadece bu aracının rehberindeki 2. derece kullanıcıları çek
      if (!visible.has(viaUserId)) {
        return res.status(403).json({ error: 'not_your_contact' });
      }
      const { rows: fofRows } = await pool.query(
        `SELECT u2.id::text AS id, COALESCE(uc_me.contact_name, u_via.display_name, 'Kullanıcı') AS via_name
         FROM user_contacts uc
         JOIN users u2 ON u2.phone_hash = uc.contact_phone_hash
         JOIN users u_via ON u_via.id = uc.user_id
         LEFT JOIN user_contacts uc_me
           ON uc_me.user_id = $1 AND uc_me.contact_phone_hash = u_via.phone_hash
         WHERE uc.user_id = $2
           AND u2.status = 'active'
           AND u2.id != $1
           AND u2.id NOT IN (
             SELECT u1.id FROM user_contacts uc1
             JOIN users u1 ON u1.phone_hash = uc1.contact_phone_hash
             WHERE uc1.user_id = $1
           )`,
        [req.userId, viaUserId]
      );
      for (const r of fofRows) {
        tierMap.set(r.id, { tier: 2, via_user_id: viaUserId, via_name: r.via_name, mutual_count: 1 });
      }
      if (tierMap.size === 0) {
        return res.json({ listings: [], counts: { first: 0, second: 0 } });
      }
    } else {
      // Normal akış: 1. + 2. derece (istenirse)
      const secondMap = includeSecondDegree
        ? await graph.getSecondDegreeMap(req.userId)
        : new Map();

      if (visible.size === 0 && secondMap.size === 0) {
        return res.json({ listings: [], message: 'Rehberinde henüz Abadan kullanan kimse yok. Arkadaşlarını davet et!' });
      }
      for (const uid of visible.keys()) tierMap.set(uid, { tier: 1 });
      for (const [uid, info] of secondMap.entries()) {
        if (!tierMap.has(uid)) tierMap.set(uid, {
          tier: 2,
          via_user_id: info.via_user_id,
          via_name: info.via_name,
          mutual_count: info.mutual_count,
        });
      }
    }
    // İLET (Forward) — 1. derecedeki tanıdıkların forward ettiği ilanlar
    // Bunlar user_id filtresine takılmayabilir (3. derece ilan olabilir), o yüzden
    // ayrı bir listing_id filter'ı ile OR bağlanacak.
    // Map: listing_id → { forwarder_id, forwarder_name, forwarded_at }
    const forwardMap = new Map();
    if (visible.size > 0) {
      const visibleIdsArr = Array.from(visible.keys());
      const { rows: fwdRows } = await pool.query(
        `SELECT DISTINCT ON (lf.listing_id)
           lf.listing_id, lf.forwarder_id, lf.created_at,
           COALESCE(uc.contact_name, u.display_name, 'Kullanıcı') AS forwarder_name
         FROM listing_forwards lf
         JOIN users u ON u.id = lf.forwarder_id
         LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_phone_hash = u.phone_hash
         WHERE lf.forwarder_id = ANY($2::uuid[])
         ORDER BY lf.listing_id, lf.created_at DESC`,
        [req.userId, visibleIdsArr]
      );
      for (const r of fwdRows) {
        forwardMap.set(String(r.listing_id), {
          forwarder_id: r.forwarder_id,
          forwarder_name: r.forwarder_name,
          forwarded_at: r.created_at,
        });
      }
    }
    const forwardedListingIds = Array.from(forwardMap.keys());

    const ids = Array.from(tierMap.keys());
    const myGender = await getMyGender(req.userId);
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const offset = parseInt(req.query.offset || '0', 10);
    const categoryId = req.query.categoryId ? parseInt(req.query.categoryId, 10) : null;
    const q = (req.query.q || '').toString().trim();
    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;
    const city = req.query.city ? req.query.city.toString().trim() : null;
    // Çoklu il filtresi: ?cities=İstanbul,Ankara
    const cities = req.query.cities
      ? req.query.cities.toString().split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const days = req.query.days ? Math.max(1, Math.min(parseInt(req.query.days, 10), 365)) : null;
    const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
    const freeOnly = req.query.freeOnly === '1' || req.query.freeOnly === 'true';
    const sellerId = req.query.sellerId ? String(req.query.sellerId) : null;
    // Sıralama seçenekleri (mobile filter chip)
    // newest (default) | oldest | price_asc | price_desc | popular
    const sortBy = String(req.query.sortBy || 'newest');
    const orderMap = {
      newest:     'l.created_at DESC',
      oldest:     'l.created_at ASC',
      price_asc:  'l.price ASC, l.created_at DESC',
      price_desc: 'l.price DESC, l.created_at DESC',
      popular:    'l.view_count DESC, l.created_at DESC',
    };
    const orderBySql = orderMap[sortBy] || orderMap.newest;

    // Filter: kullanıcının network'ündeki (1.+2. derece) veya 1. derecesinin forward ettiği ilanlar
    // $1 = user_ids (network), $2 = forwarded listing_ids
    const filters = [
      forwardedListingIds.length > 0
        ? '(l.user_id = ANY($1::uuid[]) OR l.id = ANY($2::uuid[]))'
        : 'l.user_id = ANY($1::uuid[])',
      // Aktif ilanlar HER ZAMAN gösterilir.
      // Sold ilanlar özel koşulla: max 7 gün, ve bu kullanıcı için 24 saatte tek gösterim.
      `(
        l.status = 'active'
        OR (
          l.status = 'sold'
          AND l.sold_at IS NOT NULL
          AND l.sold_at > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM sold_listing_seen ss
            WHERE ss.listing_id = l.id
              AND ss.user_id = '${req.userId}'
              AND ss.first_seen_at < now() - interval '24 hours'
          )
        )
      )`,
      'l.admin_removed_at IS NULL',
      // Hayalet onay filtresi: pending hayalet ilanlar feed'de görünmez.
      // Normal ilanlar (ghost_mode=false) VEYA onaylanmış hayaletler (approved) görünür.
      "(l.ghost_mode = false OR l.ghost_approval_status = 'approved')",
      // Cinsiyet kısıtı — kullanıcı kendi cinsiyetine uyan ilanları görür
      genderFilter(myGender),
      // Kendi ilanlarını akışta görmesin (sadece İlanlarım sekmesinde)
      `l.user_id <> '${req.userId}'`,
    ];
    const params = [ids];
    if (forwardedListingIds.length > 0) {
      params.push(forwardedListingIds);
    }

    // Tarih filtresi (ana akış için son N gün)
    if (days) {
      filters.push(`l.created_at >= now() - interval '${days} days'`);
    }

    // Ücretsiz ürün filtresi (price = 0)
    if (freeOnly) {
      // "Ücretsiz" sekmesi: hem fiyat=0 olanlar hem "ne verirsen" olanlar
      filters.push(`(l.price = 0 OR l.is_negotiable = TRUE)`);
    }

    // Belirli satıcının ilanları
    if (sellerId) {
      params.push(sellerId);
      filters.push(`l.user_id = $${params.length}`);
    }

    // Kategori filtresi: id verildiyse kendisi + TÜM alt seviye (recursive: L2, L3, ...)
    if (categoryId) {
      params.push(categoryId);
      filters.push(`l.category_id IN (
        WITH RECURSIVE descendants AS (
          SELECT id FROM categories WHERE id = $${params.length}
          UNION ALL
          SELECT c.id FROM categories c
          INNER JOIN descendants d ON c.parent_id = d.id
        )
        SELECT id FROM descendants
      )`);
    }

    // Tam metin arama (ILIKE — basit ve Türkçe karakter dostu)
    if (q) {
      params.push(`%${q}%`);
      filters.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
    }

    if (minPrice != null && !Number.isNaN(minPrice)) {
      params.push(minPrice);
      filters.push(`l.price >= $${params.length}`);
    }
    if (maxPrice != null && !Number.isNaN(maxPrice)) {
      params.push(maxPrice);
      filters.push(`l.price <= $${params.length}`);
    }
    if (cities && cities.length > 0) {
      // Çoklu il — l.location_city herhangi birine eşit (case-insensitive)
      params.push(cities);
      filters.push(`LOWER(l.location_city) = ANY(SELECT LOWER(c) FROM unnest($${params.length}::text[]) AS c)`);
    } else if (city) {
      params.push(city);
      filters.push(`l.location_city ILIKE $${params.length}`);
    }

    // Mahremiyet notu: aracı (1. derece) kişinin kim olduğunu istemciye dönmüyoruz.
    // Sadece sellerın derece bilgisini (1 veya 2) dönüyoruz.

    // Gizlenen ilanlar ve favori durumu için userId'yi parametrize edelim
    params.push(req.userId); // $N — favoriler & gizlenenler için
    const userParamIdx = params.length;
    params.push(limit, offset); // limit ve offset en sonda

    // Gizlenen ilanları akıştan çıkar (göz açık olsa includeHidden=1 olur ve filtre uygulanmaz)
    if (!includeHidden) {
      filters.push(`l.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $${userParamIdx})`);
    }

    // Satıcı adı: bakan kullanıcının rehberinde bu kişi varsa o isimle göster,
    // yoksa kullanıcının kendi belirttiği display_name'i göster.
    const sql = `
      SELECT l.id, l.title, l.description, l.price, l.currency, l.is_negotiable,
             l.location_city, l.location_district, l.created_at,
             l.category_id, c.name AS category_name, c.slug AS category_slug,
             l.user_id, l.status, l.sold_at,
             -- [DEMO] prefix'i (seed-listings.js'in eklediği) UI'da gözükmesin diye soyuluyor.
             REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\[DEMO\] ', '') AS seller_name,
             u.avatar_url AS seller_avatar,
             u.ghost_mode AS seller_ghost_mode,
             l.ghost_mode AS listing_ghost_mode,
             -- Liste kartı için tek foto: cover (ilk) thumbnail
             (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
             -- Auto-loop için tüm foto thumbnails (max 8, base64 değil thumbnail URL)
             (SELECT json_agg(COALESCE(p.thumb_url, p.url) ORDER BY p.ordering)
              FROM (SELECT thumb_url, url, ordering FROM listing_photos WHERE listing_id = l.id ORDER BY ordering LIMIT 8) p) AS all_photos,
             (SELECT COUNT(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
             EXISTS(SELECT 1 FROM favorites WHERE user_id = $${userParamIdx} AND listing_id = l.id) AS is_favorite,
             EXISTS(SELECT 1 FROM hidden_listings WHERE user_id = $${userParamIdx} AND listing_id = l.id) AS is_hidden
      FROM listings l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN user_contacts uc ON uc.user_id = $${userParamIdx} AND uc.contact_phone_hash = u.phone_hash
      WHERE ${filters.join(' AND ')}
      ORDER BY ${orderBySql}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(sql, params);

    const result = rows
      .map((row) => {
        const tierInfo = tierMap.get(String(row.user_id)) || { tier: 2 };
        let tier = tierInfo.tier;
        const isSecond = tier === 2;
        // HAYALET: kullanıcı hayalet VEYA ilan hayalet, VE bakan kendisi değilse → gizle
        const isGhost = !!(row.seller_ghost_mode || row.listing_ghost_mode) && String(row.user_id) !== String(req.userId);

        // İLET — bu ilan 1. derecemdeki biri tarafından iletildi mi?
        // Öncelik forward > native tier (forward daha yakın etkileşim).
        const fwd = forwardMap.get(String(row.id));
        const isForwarded = !!fwd && !isGhost;  // hayaletler zaten forward edilemez ama güvenlik ağı

        return {
          ...row,
          degree: tier,
          tier,
          seller_name: (isSecond || isGhost) ? null : row.seller_name,
          seller_avatar: (isSecond || isGhost) ? null : row.seller_avatar,
          is_ghost: isGhost,
          via_user_id: isSecond ? tierInfo.via_user_id : null,
          via_name: isSecond ? tierInfo.via_name : null,
          mutual_count: isSecond ? tierInfo.mutual_count : null,
          // İLET bilgileri — frontend "İLETİ" etiketi ve "Ali iletti" için
          is_forwarded: isForwarded,
          forwarded_by_user_id: isForwarded ? fwd.forwarder_id : null,
          forwarded_by_name: isForwarded ? fwd.forwarder_name : null,
          forwarded_at: isForwarded ? fwd.forwarded_at : null,
          photos: (row.all_photos && row.all_photos.length > 0)
            ? row.all_photos
            : (row.cover_photo ? [row.cover_photo] : []),
          photo_count: row.photo_count || 0,
        };
      })
      // Hayalet ilanlar 2. derecede de görünür — sadece kimlik gizli (seller_name/avatar null,
      // is_ghost=true). Via aracı gösterilir, via zaten hayalet DEĞİL (graph.js'te filtreli),
      // yani üzerinden iletişim mümkün. Filter yok.
      ;

    // Sold ilan tracking — bu feed'de görülen sold ilanları kaydet
    // İkinci gösterime kadar 24 saat sayacı başlar. Sadece bu kullanıcı için.
    const soldIdsInFeed = result.filter((r) => r.status === 'sold').map((r) => r.id);
    if (soldIdsInFeed.length > 0) {
      pool.query(
        `INSERT INTO sold_listing_seen (listing_id, user_id)
         SELECT unnest($1::uuid[]), $2
         ON CONFLICT DO NOTHING`,
        [soldIdsInFeed, req.userId]
      ).catch((e) => console.error('[listings] sold_seen track fail:', e.message));
    }

    // Sayaçlar: 1. ve 2. derece ayrı (deduplication zaten SQL'de)
    const firstCount = result.filter((r) => r.tier === 1).length;
    const secondCount = result.filter((r) => r.tier === 2).length;

    res.json({
      listings: result,
      count: result.length,
      counts: { first: firstCount, second: secondCount },
    });
  } catch (err) {
    next(err);
  }
});

// GET /listings/mine  →  kullanıcının kendi ilanları (aktif, satılmış, vb. hepsi)
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.title, l.description, l.price, l.currency,
              l.location_city, l.location_district, l.created_at, l.updated_at, l.status,
              l.category_id, c.name AS category_name,
              l.restricted_to_gender, l.is_negotiable,
              l.ghost_mode, l.ghost_approval_status, l.ghost_approval_reason,
              (SELECT p.url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count
       FROM listings l
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.user_id = $1
       ORDER BY l.created_at DESC`,
      [req.userId]
    );
    const result = rows.map((r) => ({
      ...r,
      photos: r.cover_photo ? [r.cover_photo] : [],
      photo_count: r.photo_count || 0,
    }));
    res.json({ listings: result, count: result.length });
  } catch (err) {
    next(err);
  }
});

// GET /listings/garage-sale  →  Vitrin sekmesi: son N gün ilanları (default 30 gün, max 30 gün)
// Reels-style görüntüleme akışı. Daha geniş pencere → boş ekran azalır.
router.get('/garage-sale', requireAuth, async (req, res, next) => {
  try {
    const includeSecondDegree =
      req.query.includeSecondDegree === '1' || req.query.includeSecondDegree === 'true';
    const visible = await graph.getVisibleUserIds(req.userId);
    const secondMap = includeSecondDegree
      ? await graph.getSecondDegreeMap(req.userId)
      : new Map();

    if (visible.size === 0 && secondMap.size === 0) {
      return res.json({ listings: [], message: 'Henüz tanıdığın yok. Önce rehberini senkronize et.' });
    }

    // tier lookup için birleşik map
    const tierMap = new Map();
    for (const uid of visible.keys()) tierMap.set(uid, { tier: 1 });
    for (const [uid, info] of secondMap.entries()) {
      if (!tierMap.has(uid)) tierMap.set(uid, {
        tier: 2,
        via_user_id: info.via_user_id,
        via_name: info.via_name,
        mutual_count: info.mutual_count,
      });
    }
    const ids = Array.from(tierMap.keys());
    // Vitrin zaman penceresi — client istediği kadar geriye bakabilir (max 1 yıl)
    // Default 720 saat (30 gün). Client 6 ay = 4320, tümü = 8760 (1 yıl) gönderebilir.
    const hours = Math.min(parseInt(req.query.hours || '720', 10), 8760);
    const myGender = await getMyGender(req.userId);
    const freeOnly = req.query.freeOnly === '1' || req.query.freeOnly === 'true';
    const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';

    const sql = `
      SELECT l.id, l.title, l.description, l.price, l.currency,
             l.location_city, l.location_district, l.created_at,
             l.category_id, c.name AS category_name,
             l.user_id,
             -- [DEMO] prefix'i (seed-listings.js'in eklediği) UI'da gözükmesin diye soyuluyor.
             REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\[DEMO\] ', '') AS seller_name,
             u.avatar_url AS seller_avatar,
             u.ghost_mode AS seller_ghost_mode,
             l.ghost_mode AS listing_ghost_mode,
             (SELECT COALESCE(p.thumb_url, p.url) FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.ordering ASC LIMIT 1) AS cover_photo,
             -- Vitrin auto-loop için tüm foto thumbnails (10 tane sınır)
             (SELECT json_agg(COALESCE(p.thumb_url, p.url) ORDER BY p.ordering)
              FROM (SELECT thumb_url, url, ordering FROM listing_photos WHERE listing_id = l.id ORDER BY ordering LIMIT 10) p) AS all_photos,
             (SELECT COUNT(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
             EXISTS(SELECT 1 FROM favorites WHERE user_id = $3 AND listing_id = l.id) AS is_favorite,
             EXISTS(SELECT 1 FROM hidden_listings WHERE user_id = $3 AND listing_id = l.id) AS is_hidden,
             l.is_negotiable
      FROM listings l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN user_contacts uc ON uc.user_id = $3 AND uc.contact_phone_hash = u.phone_hash
      WHERE l.user_id = ANY($1::uuid[])
        AND l.user_id <> $3
        AND l.status = 'active'
        AND l.admin_removed_at IS NULL
        AND l.created_at >= now() - ($2 || ' hours')::interval
        AND ${genderFilter(myGender)}
        -- Hayalet onay filtresi: pending hayalet ilanlar Vitrin'de de görünmez.
        AND (l.ghost_mode = false OR l.ghost_approval_status = 'approved')
        ${freeOnly ? 'AND (l.price = 0 OR l.is_negotiable = TRUE)' : ''}
        ${includeHidden ? '' : 'AND l.id NOT IN (SELECT listing_id FROM hidden_listings WHERE user_id = $3)'}
      ORDER BY l.created_at DESC
    `;
    const { rows } = await pool.query(sql, [ids, hours, req.userId]);

    const result = rows
      .map((row) => {
        const tierInfo = tierMap.get(String(row.user_id)) || { tier: 1 };
        const tier = tierInfo.tier;
        const isSecond = tier === 2;
        // HAYALET: kullanıcı hayalet VEYA ilan hayalet, VE bakan kendisi değilse → kimlik gizle
        const isGhost = !!(row.seller_ghost_mode || row.listing_ghost_mode) && String(row.user_id) !== String(req.userId);
        return {
          ...row,
          degree: tier,
          tier,
          seller_name: (isSecond || isGhost) ? null : row.seller_name,
          seller_avatar: (isSecond || isGhost) ? null : row.seller_avatar,
          is_ghost: isGhost,
          via_user_id: isSecond ? tierInfo.via_user_id : null,
          via_name: isSecond ? tierInfo.via_name : null,
          mutual_count: isSecond ? tierInfo.mutual_count : null,
          // Auto-loop için tüm foto'lar; boş ise cover ile fallback
          photos: (row.all_photos && row.all_photos.length > 0)
            ? row.all_photos
            : (row.cover_photo ? [row.cover_photo] : []),
          photo_count: row.photo_count || 0,
        };
      })
      // Hayalet ilanlar 2. derecede de görünür — sadece kimlik gizli. Ana feed ile tutarlı.
      ;

    res.json({ listings: result, count: result.length, hours });
  } catch (err) {
    next(err);
  }
});

// POST /listings/:id/forward — 2. derece ilanı kendi çevremize ilet
// Kısıtlar:
//   - İlan var + aktif
//   - Kullanıcının kendi ilanı DEĞİL
//   - Hayalet DEĞİL (ilan-level VE kullanıcı-level)
//   - Kullanıcı için tier=2 (1. derece zaten görüyor, ilet mantıksız)
// UNIQUE(listing_id, forwarder_id) — aynı kullanıcı aynı ilanı iki kez iletemez (idempotent).
router.post('/:id/forward', requireAuth, async (req, res, next) => {
  try {
    const listingId = req.params.id;

    const lres = await pool.query(
      `SELECT l.id, l.user_id, l.status, l.admin_removed_at,
              l.ghost_mode AS listing_ghost, u.ghost_mode AS user_ghost
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`,
      [listingId]
    );
    if (lres.rows.length === 0) return res.status(404).json({ error: 'listing_not_found' });
    const l = lres.rows[0];

    if (l.status !== 'active' || l.admin_removed_at) {
      return res.status(400).json({ error: 'listing_not_active' });
    }
    if (l.user_id === req.userId) {
      return res.status(400).json({ error: 'cannot_forward_own_listing' });
    }
    if (l.listing_ghost || l.user_ghost) {
      return res.status(400).json({ error: 'cannot_forward_ghost' });
    }

    // tier kontrolü — 1. derecede ise ilet gerekmez (zaten görüyor)
    const visible = await graph.getVisibleUserIds(req.userId);
    if (visible.has(String(l.user_id))) {
      return res.status(400).json({ error: 'first_degree_no_forward' });
    }
    const secondMap = await graph.getSecondDegreeMap(req.userId);
    if (!secondMap.has(String(l.user_id))) {
      return res.status(400).json({ error: 'not_in_your_network' });
    }

    // Idempotent insert — aynı forward tekrar POST edilirse sessizce OK.
    const ins = await pool.query(
      `INSERT INTO listing_forwards (listing_id, forwarder_id)
       VALUES ($1, $2)
       ON CONFLICT (listing_id, forwarder_id) DO NOTHING
       RETURNING id, created_at`,
      [listingId, req.userId]
    );

    res.json({ ok: true, already: ins.rowCount === 0 });
  } catch (err) {
    next(err);
  }
});

// DELETE /listings/:id/forward — iletim geri al
router.delete('/:id/forward', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM listing_forwards WHERE listing_id = $1 AND forwarder_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /listings/:id/intermediaries — 2. derece ilanı için aracıların listesi
// Kullanıcı hangi tanıdığından bilgi sormak istediğini seçer.
router.get('/:id/intermediaries', requireAuth, async (req, res, next) => {
  try {
    const lres = await pool.query('SELECT user_id FROM listings WHERE id = $1', [req.params.id]);
    if (lres.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const sellerId = lres.rows[0].user_id;
    if (sellerId === req.userId) return res.json({ intermediaries: [] });

    const intermediaries = await graph.getIntermediariesFor(req.userId, sellerId);
    res.json({ intermediaries });
  } catch (err) {
    next(err);
  }
});

// GET /listings/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const visible = await graph.getVisibleUserIds(req.userId);
    const myGender = await getMyGender(req.userId);
    const { rows } = await pool.query(
      `SELECT l.*,
              -- [DEMO] prefix'i (seed-listings.js'in eklediği) UI'da gözükmesin diye soyuluyor.
             REGEXP_REPLACE(COALESCE(uc.contact_name, u.display_name), '^\[DEMO\] ', '') AS seller_name,
              u.avatar_url AS seller_avatar,
              u.ghost_mode AS seller_ghost_mode,
              c.name AS category_name,
              c.slug AS category_slug,
              parent.id AS parent_category_id,
              parent.name AS parent_category_name,
              (SELECT json_agg(p.url ORDER BY p.ordering) FROM listing_photos p WHERE p.listing_id = l.id) AS photos,
              (SELECT json_agg(COALESCE(p.thumb_url, p.url) ORDER BY p.ordering) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_thumbs,
              EXISTS(SELECT 1 FROM favorites WHERE user_id = $2 AND listing_id = l.id) AS is_favorite,
              EXISTS(SELECT 1 FROM hidden_listings WHERE user_id = $2 AND listing_id = l.id) AS is_hidden,
              -- Görüntülenme: uygulama içi (listings.view_count) + dış paylaşım linkleri (listing_shares.view_count sum)
              COALESCE((SELECT SUM(view_count)::int FROM listing_shares WHERE listing_id = l.id), 0) AS share_views
       FROM listings l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN user_contacts uc ON uc.user_id = $2 AND uc.contact_phone_hash = u.phone_hash
       LEFT JOIN categories c ON c.id = l.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_id
       WHERE l.id = $1`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const listing = rows[0];

    // MAHREMİYET: cinsiyet kısıtı varsa ve eşleşmiyorsa 404
    if (listing.user_id !== req.userId && listing.restricted_to_gender) {
      if (listing.restricted_to_gender !== myGender) {
        return res.status(404).json({ error: 'not_found' });
      }
    }

    // Pending hayalet ilan — sadece sahibi ve admin görebilir
    if (
      listing.user_id !== req.userId &&
      listing.ghost_mode &&
      listing.ghost_approval_status === 'pending'
    ) {
      return res.status(404).json({ error: 'not_found' });
    }

    const isOwn = listing.user_id === req.userId;
    const inFirstDegree = visible.has(listing.user_id);
    let tier = isOwn ? 0 : (inFirstDegree ? 1 : null);
    let viaInfo = null;

    // Bu ilan bir 1. derecemdeki tanıdık tarafından forward edilmiş mi?
    // Öyleyse ilanı görebilirim (3. derece olsa bile), tier=2 gibi göster + is_forwarded=true
    let forwardInfo = null;
    if (!isOwn) {
      const visibleIdsArr = Array.from(visible.keys());
      if (visibleIdsArr.length > 0) {
        const fres = await pool.query(
          `SELECT lf.forwarder_id, lf.created_at,
                  COALESCE(uc.contact_name, u.display_name, 'Kullanıcı') AS forwarder_name
           FROM listing_forwards lf
           JOIN users u ON u.id = lf.forwarder_id
           LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_phone_hash = u.phone_hash
           WHERE lf.listing_id = $2 AND lf.forwarder_id = ANY($3::uuid[])
           ORDER BY lf.created_at DESC LIMIT 1`,
          [req.userId, req.params.id, visibleIdsArr]
        );
        if (fres.rows.length > 0) {
          forwardInfo = fres.rows[0];
        }
      }
    }

    // 2. derece kontrolü — sadece ilk kontrolde bulunamazsa gönder
    if (!isOwn && !inFirstDegree) {
      const secondMap = await graph.getSecondDegreeMap(req.userId);
      const info = secondMap.get(listing.user_id);
      if (info) {
        tier = 2;
        viaInfo = info;
      } else if (forwardInfo) {
        // 2. derecemde değil ama 1. derece tanıdık forward etmiş — göster (tier=2 gibi)
        tier = 2;
        viaInfo = {
          via_user_id: forwardInfo.forwarder_id,
          via_name: forwardInfo.forwarder_name,
          mutual_count: 1,
        };
      } else {
        return res.status(403).json({ error: 'not_in_your_network' });
      }
    }

    const isSecond = tier === 2;
    // İlet edilebilir mi kontrolü — sadece tier=2 + hayalet değil + kendisi değil
    // Bu bilgi UI'da "İlet" butonunu göstermek için kullanılır.
    // Kullanıcı zaten iletti mi? — canForward=true ama alreadyForwarded=true ise UI "İletildi ✓" yapabilir.

    // View sayacı — UNIQUE user bazında. Aynı kişi defalarca açsa 1 kez sayılır.
    // Sahibi hariç. Async: response'u geciktirmez.
    if (!isOwn) {
      (async () => {
        try {
          const ins = await pool.query(
            `INSERT INTO listing_views (listing_id, viewer_user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [req.params.id, req.userId]
          );
          // Sadece ilk kez ise counter'ı artır (aynı kişi tekrar açarsa rowCount=0)
          if (ins.rowCount > 0) {
            await pool.query(
              'UPDATE listings SET view_count = view_count + 1 WHERE id = $1',
              [req.params.id]
            );
          }
        } catch (e) {
          console.error('[listings] view track fail:', e.message);
        }
      })();
    }

    const appViews = Number(listing.view_count || 0);
    const shareViews = Number(listing.share_views || 0);
    const totalViews = appViews + shareViews;

    // HAYALET: kullanıcı hayalet VEYA ilan hayalet, VE bakan kendisi değilse
    const isGhost = !!(listing.seller_ghost_mode || listing.ghost_mode) && !isOwn;
    // 2. derece + hayalet detay: normal aç, sadece kimlik gizli (is_ghost=true).
    // Via aracılığıyla mesajlaşma frontend'de çalışır.

    // İlet edilebilir mi + kullanıcı zaten iletmiş mi?
    const canForward = isSecond && !isGhost && !isOwn;
    let alreadyForwardedByMe = false;
    if (canForward) {
      const chk = await pool.query(
        'SELECT 1 FROM listing_forwards WHERE listing_id = $1 AND forwarder_id = $2 LIMIT 1',
        [req.params.id, req.userId]
      );
      alreadyForwardedByMe = chk.rowCount > 0;
    }

    res.json({
      ...listing,
      // 2. derece için gerçek isim gizli, hayalet için de
      seller_name: (isSecond || isGhost) ? null : listing.seller_name,
      seller_avatar: (isSecond || isGhost) ? null : listing.seller_avatar,
      is_ghost: isGhost, // frontend WhatsApp buton gizler, 👻 gösterir
      user_id: isSecond ? null : listing.user_id, // 2. derece'de user_id de gizli (mesaj yönlendirme via'ya)
      real_user_id: listing.user_id, // referans için (mesajlaşmada backend kullanır)
      tier,
      degree: tier,
      via_user_id: viaInfo?.via_user_id || null,
      via_name: viaInfo?.via_name || null,
      mutual_count: viaInfo?.mutual_count || null,
      photos: listing.photos || [],
      photo_thumbs: listing.photo_thumbs || [],
      restricted_to_gender: isOwn ? listing.restricted_to_gender : undefined,
      // Görüntülenme sayıları
      view_count: appViews,       // uygulama içi
      share_views: shareViews,     // dış paylaşım linki tıklamaları
      total_views: totalViews,     // toplam (bu request sayılmadan önce; UI için önemli değil)
      // İLET (Forward) bilgileri
      is_forwarded: !!forwardInfo,
      forwarded_by_user_id: forwardInfo?.forwarder_id || null,
      forwarded_by_name: forwardInfo?.forwarder_name || null,
      forwarded_at: forwardInfo?.created_at || null,
      can_forward: canForward,
      already_forwarded_by_me: alreadyForwardedByMe,
    });
  } catch (err) {
    next(err);
  }
});

// POST /listings
router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { value, error } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Idempotency-Key — timeout/retry durumunda duplicate önle
    const idempotencyKey = (req.headers['idempotency-key'] || '').toString().slice(0, 128) || null;
    if (idempotencyKey) {
      const existing = await pool.query(
        `SELECT * FROM listings WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [req.userId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(201).json({ listing: existing.rows[0], idempotent: true });
      }
    }

    // Yasak kelime kontrolü — title + description birlikte taranır
    const bannedWords = require('../services/banned-words');
    const combinedText = (value.title || '') + '\n' + (value.description || '');
    const check = await bannedWords.checkText(combinedText);
    if (check.blocked) {
      return res.status(400).json({
        error: 'content_blocked',
        message: check.message,
        matched: check.matched_pattern,
      });
    }

    await client.query('BEGIN');
    // Eğer kullanıcı cinsiyet kısıtı istiyorsa, kendi cinsiyetiyle uyumlu olmalı
    let restrictedTo = null;
    if (value.restrictedToGender) {
      const myGender = await getMyGender(req.userId);
      if (myGender && myGender === value.restrictedToGender) {
        restrictedTo = value.restrictedToGender;
      }
      // Aksi takdirde sessizce yok say (kullanıcı kendi cinsiyetinin dışındaki bir kısıtı koyamaz)
    }
    // Hayalet ilan: admin onayı bekler
    const approvalStatus = value.ghostMode ? 'pending' : null;

    let ins;
    try {
      ins = await client.query(
        `INSERT INTO listings (user_id, title, description, category_id, price, currency, location_city, location_district, restricted_to_gender, is_negotiable, idempotency_key, ghost_mode, ghost_approval_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [req.userId, value.title, value.description, value.categoryId, value.price, value.currency, value.locationCity || null, value.locationDistrict || null, restrictedTo, !!value.isNegotiable, idempotencyKey, !!value.ghostMode, approvalStatus]
      );
    } catch (dbErr) {
      // 23505 = unique_violation — race condition: aynı key paralel geldi
      if (dbErr.code === '23505' && idempotencyKey) {
        await client.query('ROLLBACK').catch(() => {});
        const existing = await pool.query(
          `SELECT * FROM listings WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [req.userId, idempotencyKey]
        );
        if (existing.rows.length > 0) {
          return res.status(201).json({ listing: existing.rows[0], idempotent: true });
        }
      }
      throw dbErr;
    }
    const listing = ins.rows[0];
    const thumbs = Array.isArray(req.body.photoThumbs) ? req.body.photoThumbs : [];
    for (let i = 0; i < value.photoUrls.length; i++) {
      await client.query(
        'INSERT INTO listing_photos (listing_id, url, thumb_url, ordering) VALUES ($1, $2, $3, $4)',
        [listing.id, value.photoUrls[i], thumbs[i] || null, i]
      );
    }
    await client.query('COMMIT');

    // Admin bildirimi — yeni ilan (arka planda, ilan cevabını geciktirmez)
    // Kendi ilanı ise admin'e kendine push atmayı önle (excludeUserId)
    // Hayalet onay bekleyen ilanlar → farklı push tipi (öncelikli), yayına da girmedi
    (async () => {
      try {
        const { sendToAllAdmins } = require('../services/push');
        const uRes = await pool.query(
          `SELECT REGEXP_REPLACE(COALESCE(display_name, ''), '^\\[DEMO\\] ', '') AS name
           FROM users WHERE id = $1`,
          [req.userId]
        );
        const senderName = uRes.rows[0]?.name || 'Bir kullanıcı';

        // Hayalet ilan pending durumunda ise ayrı bildirim (yayınlanmadı, admin onay bekliyor)
        if (approvalStatus === 'pending') {
          await sendToAllAdmins(
            {
              title: '👻 Hayalet İlan Onay Bekliyor',
              body: `${senderName}: ${listing.title}`,
              data: {
                type: 'admin_new_ghost',
                listing_id: listing.id,
                user_id: req.userId,
              },
            },
            req.userId
          );
          return; // normal admin bildirimi gönderme — henüz yayınlanmadı
        }

        await sendToAllAdmins(
          {
            title: '📦 Yeni İlan',
            body: `${senderName}: ${listing.title}`,
            data: {
              type: 'admin_new_listing',
              listing_id: listing.id,
              user_id: req.userId,
            },
          },
          req.userId
        );
      } catch (e) {
        console.error('[listings] admin notify fail:', e.message);
      }
    })();

    res.status(201).json({ listing });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /listings/:id  (sadece sahibi)
// İçerik (title, desc, price...) + opsiyonel kategori değişikliği + opsiyonel foto değişikliği
router.patch('/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Önce sahiplik kontrolü + ESKİ FİYATI öğren (fiyat değişti mi bakacağız)
    // Admin kaldırdıysa (admin_removed_at NOT NULL) kullanıcı düzenleyemez
    const own = await client.query(
      'SELECT id, price, admin_removed_at FROM listings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (own.rows[0].admin_removed_at) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'admin_removed', message: 'Bu ilan yönetim tarafından kaldırıldı, düzenlenemez.' });
    }
    const oldPrice = Number(own.rows[0].price);

    // Yasak kelime kontrolü — title/description güncellemesinde
    if (req.body?.title || req.body?.description) {
      const bannedWords = require('../services/banned-words');
      const combinedText = (req.body.title || '') + '\n' + (req.body.description || '');
      const check = await bannedWords.checkText(combinedText);
      if (check.blocked) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'content_blocked',
          message: check.message,
          matched: check.matched_pattern,
        });
      }
    }

    // Basit alan güncellemeleri
    const fields = ['title', 'description', 'price', 'status', 'location_city', 'location_district'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      const camel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) {
        params.push(req.body[camel]);
        updates.push(`${f} = $${params.length}`);
      }
    }
    // Status='sold' set edildiğinde sold_at otomatik damgala (ilk kez)
    // Status başka bir değere döner (geri al) → sold_at NULL
    if (req.body.status === 'sold') {
      updates.push(`sold_at = COALESCE(sold_at, now())`);
    } else if (req.body.status === 'active') {
      updates.push(`sold_at = NULL`);
    }
    // Ekstra: categoryId, isNegotiable, restrictedToGender
    if (req.body.categoryId !== undefined) {
      params.push(req.body.categoryId);
      updates.push(`category_id = $${params.length}`);
    }
    if (req.body.isNegotiable !== undefined) {
      params.push(!!req.body.isNegotiable);
      updates.push(`is_negotiable = $${params.length}`);
    }
    if (req.body.restrictedToGender !== undefined) {
      params.push(req.body.restrictedToGender || null);
      updates.push(`restricted_to_gender = $${params.length}`);
    }
    // İçerik değişikliği tespiti — bu alanlardan biri değiştiyse hayalet ilan tekrar onaya gider
    const CONTENT_FIELDS = ['title', 'description', 'categoryId', 'price', 'photoUrls', 'photoThumbs', 'isNegotiable', 'restrictedToGender'];
    const contentChanged = CONTENT_FIELDS.some((k) => req.body[k] !== undefined);

    // Mevcut hayalet durumunu tek seferde çek
    const curListing = await client.query(
      'SELECT ghost_mode, ghost_approval_status FROM listings WHERE id = $1',
      [req.params.id]
    );
    const prevGhost = !!curListing.rows[0]?.ghost_mode;
    const prevStatus = curListing.rows[0]?.ghost_approval_status;

    // Bu request'te ilan yeni pending oldu mu? (admin bildirimi için)
    let becamePending = false;

    if (req.body.ghostMode !== undefined) {
      const newGhost = !!req.body.ghostMode;
      params.push(newGhost);
      updates.push(`ghost_mode = $${params.length}`);

      if (!prevGhost && newGhost) {
        // false → true: yeni onay bekle
        updates.push(`ghost_approval_status = 'pending'`);
        updates.push(`ghost_approval_reason = NULL`);
        updates.push(`ghost_approved_by = NULL`);
        updates.push(`ghost_approval_at = NULL`);
        becamePending = true;
      } else if (prevGhost && !newGhost) {
        // true → false: hayalet kapatıldı
        updates.push(`ghost_approval_status = NULL`);
        updates.push(`ghost_approval_reason = NULL`);
        updates.push(`ghost_approved_by = NULL`);
        updates.push(`ghost_approval_at = NULL`);
      } else if (prevGhost && newGhost && prevStatus === 'rejected') {
        // Reddedilen hayaleti tekrar göndermek → yeni pending
        updates.push(`ghost_approval_status = 'pending'`);
        updates.push(`ghost_approval_reason = NULL`);
        updates.push(`ghost_approved_by = NULL`);
        updates.push(`ghost_approval_at = NULL`);
        becamePending = true;
      }
    }

    // Onaylanmış hayalet ilanın İÇERİĞİ değiştiyse → tekrar onaya
    // (ghostMode değişmese bile). Statü change (sold, active) tetiklemez.
    if (
      !becamePending &&
      contentChanged &&
      prevGhost &&
      prevStatus === 'approved' &&
      req.body.ghostMode !== false // kullanıcı hayaleti kapatmadıysa
    ) {
      updates.push(`ghost_approval_status = 'pending'`);
      updates.push(`ghost_approval_reason = NULL`);
      updates.push(`ghost_approved_by = NULL`);
      updates.push(`ghost_approval_at = NULL`);
      becamePending = true;
    }

    if (updates.length > 0) {
      params.push(req.params.id, req.userId);
      await client.query(
        `UPDATE listings SET ${updates.join(', ')}, updated_at = now()
         WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
        params
      );
    }

    // Foto güncellemesi (varsa): eskileri sil, yenileri ordering ile ekle
    if (Array.isArray(req.body.photoUrls)) {
      await client.query('DELETE FROM listing_photos WHERE listing_id = $1', [req.params.id]);
      const thumbs = Array.isArray(req.body.photoThumbs) ? req.body.photoThumbs : [];
      for (let i = 0; i < req.body.photoUrls.length; i++) {
        await client.query(
          'INSERT INTO listing_photos (listing_id, url, thumb_url, ordering) VALUES ($1, $2, $3, $4)',
          [req.params.id, req.body.photoUrls[i], thumbs[i] || null, i]
        );
      }
    }

    const { rows } = await client.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);

    // Fiyat değiştiyse — favorileyen kullanıcılara bildirim oluştur
    const newPrice = Number(rows[0].price);
    if (req.body.price !== undefined && oldPrice !== newPrice) {
      const favs = await client.query(
        'SELECT user_id FROM favorites WHERE listing_id = $1',
        [req.params.id]
      );
      for (const f of favs.rows) {
        if (f.user_id === req.userId) continue; // kendi ilanını kendine bildirme
        await client.query(
          `INSERT INTO notifications (user_id, type, listing_id, payload)
           VALUES ($1, 'price_change', $2, $3)`,
          [
            f.user_id,
            req.params.id,
            JSON.stringify({ old_price: oldPrice, new_price: newPrice }),
          ]
        );
      }
      if (favs.rows.length > 0) {
        console.log(`[notif] price_change ${oldPrice}→${newPrice}: ${favs.rows.length} kullanıcıya bildirim`);
      }
    }

    await client.query('COMMIT');

    // Hayalet pending yeni oldu → adminlere push (arka planda)
    if (becamePending) {
      (async () => {
        try {
          const { sendToAllAdmins } = require('../services/push');
          const uRes = await pool.query(
            `SELECT REGEXP_REPLACE(COALESCE(display_name, ''), '^\\[DEMO\\] ', '') AS name
             FROM users WHERE id = $1`,
            [req.userId]
          );
          const senderName = uRes.rows[0]?.name || 'Bir kullanıcı';
          await sendToAllAdmins(
            {
              title: '👻 Hayalet İlan Onay Bekliyor (Yeniden Gönderildi)',
              body: `${senderName}: ${rows[0].title}`,
              data: {
                type: 'admin_new_ghost',
                listing_id: req.params.id,
                user_id: req.userId,
              },
            },
            req.userId
          );
        } catch (e) {
          console.warn('[listings PATCH] admin ghost notify fail:', e.message);
        }
      })();
    }

    res.json({ listing: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    // Önce foto URL'lerini topla — DELETE'ten sonra listing_photos cascade ile temizlenir,
    // R2 dosyalarını silmek için URL'leri önden almak gerek.
    const photoRes = await pool.query(
      `SELECT lp.url, lp.thumb_url
       FROM listing_photos lp
       INNER JOIN listings l ON l.id = lp.listing_id
       WHERE l.id = $1 AND l.user_id = $2`,
      [req.params.id, req.userId]
    );
    const photoUrls = photoRes.rows
      .flatMap((r) => [r.url, r.thumb_url])
      .filter((u) => typeof u === 'string' && u.length > 0);

    // DB'den sil (listing_photos ON DELETE CASCADE ile birlikte)
    const r = await pool.query(
      'DELETE FROM listings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });

    // R2 cleanup — arka planda
    require('../services/storage').cleanupPhotoUrls(photoUrls, `user delete listing ${req.params.id}`);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
