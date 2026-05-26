// reset-and-test-seed.js sonrası: en son kayıtlı GERÇEK kullanıcıyı bul,
// onu tüm test kullanıcılarıyla rehberde bağla, sonra "yanlışlıkla kadın olarak
// kayıtlı" test kullanıcısının (Murat Erdem) cinsiyet değişikliği talebine
// onaylayıcı olarak ekle. 2 diğer onaylayıcı rastgele erkek test kullanıcılarından.
//
// Sen "Erkek" olarak kayıtlı olmalısın (Onboarding'de seçtiğin).
//
// Kullanım: node scripts/add-me-as-approver.js

const crypto = require('crypto');
const pool = require('../src/db/pool');

function h(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

const MISREGISTERED_SEED = 'test-f5-misregistered';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Yanlış kayıtlı kullanıcıyı bul (kadın olarak kayıtlı, erkeğe geçmek istiyor)
    const mis = await client.query(
      `SELECT id, display_name, gender FROM users WHERE phone_hash = $1`,
      [h(MISREGISTERED_SEED)]
    );
    if (mis.rows.length === 0) {
      console.error('✗ "Murat Erdem" test kullanıcısı bulunamadı. Önce reset-and-test-seed.js çalıştır.');
      await client.query('ROLLBACK');
      return;
    }
    const misUser = mis.rows[0];
    console.log(`🎯 Yanlış kayıtlı: ${misUser.display_name} (${misUser.gender})`);

    // 2) En son kayıt olan GERÇEK kullanıcıyı bul (test seed'leri hariç)
    const realQ = await client.query(`
      SELECT id, display_name, gender FROM users
      WHERE phone_hash NOT IN (
        SELECT phone_hash FROM users WHERE display_name IN (
          'Ayşe Demir','Fatma Yılmaz','Zeynep Kaya','Elif Şahin','Murat Erdem',
          'Ali Çelik','Mehmet Aslan','Mustafa Doğan','Hasan Yıldız','Hüseyin Polat'
        )
      )
      ORDER BY created_at DESC LIMIT 1
    `);
    if (realQ.rows.length === 0) {
      console.error('✗ Gerçek (test olmayan) kullanıcı yok. Önce uygulamadan kayıt ol.');
      await client.query('ROLLBACK');
      return;
    }
    const me = realQ.rows[0];
    console.log(`👤 Sen: ${me.display_name} (${me.gender})`);

    // 3) Tüm test kullanıcılarını senin rehberine ve seni onların rehberine ekle
    //    (Bu adım cinsiyetten bağımsız — ilanları görebilmen için gerekli.)
    const testUsers = await client.query(`
      SELECT id, phone_hash, display_name FROM users
      WHERE display_name IN (
        'Ayşe Demir','Fatma Yılmaz','Zeynep Kaya','Elif Şahin','Murat Erdem',
        'Ali Çelik','Mehmet Aslan','Mustafa Doğan','Hasan Yıldız','Hüseyin Polat'
      )
    `);
    const myPhoneHash = (await client.query('SELECT phone_hash FROM users WHERE id = $1', [me.id])).rows[0].phone_hash;
    for (const u of testUsers.rows) {
      // Test → bana
      await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO NOTHING`,
        [u.id, myPhoneHash, me.display_name || 'Yeni Kullanıcı']
      );
      // Bana → test
      await client.query(
        `INSERT INTO user_contacts (user_id, contact_phone_hash, contact_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, contact_phone_hash) DO UPDATE SET contact_name = EXCLUDED.contact_name`,
        [me.id, u.phone_hash, u.display_name]
      );
    }
    console.log(`🔗 ${testUsers.rows.length} test kullanıcı rehbere eklendi (karşılıklı)`);

    // 4) Cinsiyet talebi senaryosu — sadece sen "male" ise oluştur
    //    (Kadın olarak kayıt olduysan bu adım atlanır, ama ilan akışı çalışır.)
    if (me.gender !== 'male') {
      console.warn(`\n⚠ Senin cinsiyetin "${me.gender}". Cinsiyet onay senaryosu için "male" gerek.`);
      console.warn('  Akış senaryosu atlandı; ilanlar yine görünür. Cinsiyetini erkek olarak ayarlayıp tekrar dene.');
      // Cache temizle ki rehber bağlantı aktif olsun
      try {
        const redis = require('../src/cache/redis');
        await redis.del(`connections:${me.id}`);
        for (const u of testUsers.rows) await redis.del(`connections:${u.id}`);
      } catch {}
      await client.query('COMMIT');
      console.log('\n✓ Rehber bağlantıları kuruldu. Uygulamada ana sayfaya çek (pull-to-refresh) → 20 ilan görünmeli.');
      return;
    }

    const otherMales = await client.query(`
      SELECT id, display_name FROM users
      WHERE gender = 'male' AND id <> $1
        AND display_name IN ('Ali Çelik','Mehmet Aslan','Mustafa Doğan','Hasan Yıldız','Hüseyin Polat')
      ORDER BY random() LIMIT 2
    `, [me.id]);
    if (otherMales.rows.length < 2) {
      console.error('✗ Yeterli erkek test kullanıcısı yok. Önce reset-and-test-seed.js çalıştır.');
      await client.query('ROLLBACK');
      return;
    }
    const approverIds = [me.id, otherMales.rows[0].id, otherMales.rows[1].id];
    console.log(`👥 Onaylayıcılar:`);
    console.log(`   • ${me.display_name} (sen)`);
    console.log(`   • ${otherMales.rows[0].display_name}`);
    console.log(`   • ${otherMales.rows[1].display_name}`);

    // 5) Mevcut bekleyen talep varsa sil (idempotent)
    await client.query(
      `DELETE FROM gender_change_requests WHERE requester_id = $1 AND status = 'pending'`,
      [misUser.id]
    );

    // 6) Talep oluştur
    const req = await client.query(
      `INSERT INTO gender_change_requests (requester_id, current_gender, target_gender)
       VALUES ($1, 'female', 'male') RETURNING id`,
      [misUser.id]
    );
    const requestId = req.rows[0].id;
    console.log(`📋 Talep oluşturuldu: ${requestId}`);

    // 7) 3 onaylayıcıya bildirim
    for (const aid of approverIds) {
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'gender_change_request', $2)`,
        [
          aid,
          JSON.stringify({
            request_id: requestId,
            requester_id: misUser.id,
            current_gender: 'female',
            target_gender: 'male',
          }),
        ]
      );
    }
    console.log('✉ 3 bildirim gönderildi');

    // 8) Redis cache temizle ki rehber kontağın hemen aktif olsun
    try {
      const redis = require('../src/cache/redis');
      await redis.del(`connections:${me.id}`);
      for (const u of testUsers.rows) await redis.del(`connections:${u.id}`);
      console.log('🧽 Graph cache temizlendi');
    } catch (e) {
      console.warn('⚠ Redis temizlenemedi:', e.message);
    }

    await client.query('COMMIT');
    console.log('\n✓ Hazır! Uygulamada:');
    console.log('   1. Ana sayfaya pull-to-refresh çek → test kullanıcılarının ilanları görünmeli');
    console.log('   2. Bildirimler sekmesine git → "Murat Erdem" cinsiyet değişikliği onay talebi');
    console.log('   3. "Onayla" veya "Reddet" — akış orada test edilir');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ Hata:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
