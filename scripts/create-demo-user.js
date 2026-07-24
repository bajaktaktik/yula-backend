// Demo kullanıcı oluşturma / güncelleme script'i.
//
// KULLANIM:
//   Railway shell'de:  npm run demo:user
//                  ya: node scripts/create-demo-user.js
//
// Idempotent — kullanıcı zaten varsa PIN + isim update edilir.
// Hash formülü login akışıyla birebir aynı: HMAC-SHA256(pepper, SHA256(e164))

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { normalizePhone } = require('../src/utils/phone');
const pool = require('../src/db/pool');

const RAW_PHONE = '0 500 111 22 33';
const PIN = '4964';
const DISPLAY_NAME = 'Demo Kullanıcı';

async function main() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  DEMO KULLANICI OLUŞTUR / GÜNCELLE');
  console.log('═══════════════════════════════════════════════\n');

  const pepper = process.env.PHONE_HASH_PEPPER;
  if (!pepper) {
    console.error('❌ PHONE_HASH_PEPPER env değişkeni eksik.');
    console.error('   Railway env kontrol et.');
    process.exit(1);
  }

  const e164 = normalizePhone(RAW_PHONE);
  if (!e164) {
    console.error('❌ Telefon numarası normalize edilemedi:', RAW_PHONE);
    console.error('   Türk cep formatına uygun mu kontrol et (05XX ile başlamalı).');
    process.exit(1);
  }
  console.log('📱 E164:      ', e164);

  // Login akışıyla aynı hash formülü:
  //   Mobile: SHA256(e164) — client hash
  //   Backend: HMAC-SHA256(pepper, client_hash) — DB'de tutulan hash
  const clientSha = crypto.createHash('sha256').update(e164).digest('hex');
  const phoneHash = crypto
    .createHmac('sha256', pepper)
    .update(clientSha)
    .digest('hex');
  console.log('🔒 Phone hash:', phoneHash.slice(0, 20) + '...');

  const pinHash = await bcrypt.hash(PIN, 10);
  console.log('🔒 PIN hash oluşturuldu (bcrypt)');
  console.log();

  const existing = await pool.query(
    'SELECT id, display_name FROM users WHERE phone_hash = $1',
    [phoneHash]
  );

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    console.log('ℹ️  Kullanıcı zaten var — PIN + isim güncelleniyor');
    await pool.query(
      `UPDATE users
         SET pin_hash = $1,
             display_name = $2,
             status = 'active',
             onboarded_at = COALESCE(onboarded_at, now())
       WHERE id = $3`,
      [pinHash, DISPLAY_NAME, id]
    );
    console.log('✅ Güncellendi. User ID:', id);
  } else {
    const r = await pool.query(
      `INSERT INTO users
         (phone_hash, display_name, pin_hash, status, onboarded_at, role)
       VALUES ($1, $2, $3, 'active', now(), 'user')
       RETURNING id`,
      [phoneHash, DISPLAY_NAME, pinHash]
    );
    console.log('✅ Demo kullanıcı oluşturuldu. User ID:', r.rows[0].id);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('  🎉 HAZIR — Aşağıdaki bilgilerle giriş yap:');
  console.log('═══════════════════════════════════════════════');
  console.log('  📱 Telefon:', RAW_PHONE);
  console.log('  🔑 PIN:    ', PIN);
  console.log('  👤 İsim:   ', DISPLAY_NAME);
  console.log('═══════════════════════════════════════════════\n');

  await pool.end();
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
