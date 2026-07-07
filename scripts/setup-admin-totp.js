// Admin TOTP kurulumu (CLI).
// Kullanım:
//   node scripts/setup-admin-totp.js <user-id>
//
// Ne yapar:
//   1. Verilen user için yeni bir TOTP secret üretir
//   2. DB'ye admin_totp_secret + admin_totp_verified_at (now) olarak yazar
//   3. Konsola QR kodu (ASCII) + otpauth:// URI + secret yazdırır
//
// Kullanıcı bu QR'ı Google Authenticator ile tarar ve o kod ile panele giriş yapar.
// Panel UI'sinde setup akışı YOKTUR — sadece bu script ile eklenebilir.
//
// GEREKSİNİMLER:
//   - Backend .env dosyasında geçerli DATABASE_URL ve PHONE_HASH_PEPPER olmalı
//   - Lokal test için: cd backend && node scripts/setup-admin-totp.js <user-id>

require('dotenv').config();
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const pool = require('../src/db/pool');

authenticator.options = { window: 1, step: 30 };

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('❌ Kullanım: node scripts/setup-admin-totp.js <user-id>');
    process.exit(1);
  }

  const u = await pool.query(
    'SELECT id, display_name, admin_totp_verified_at FROM users WHERE id = $1',
    [userId]
  );
  if (u.rows.length === 0) {
    console.error(`❌ Kullanıcı bulunamadı: ${userId}`);
    process.exit(1);
  }

  if (u.rows[0].admin_totp_verified_at) {
    console.log(`⚠️  Bu kullanıcının zaten TOTP kurulu (${u.rows[0].admin_totp_verified_at}).`);
    console.log(`⚠️  Devam edersen mevcut secret üzerine yazılır ve eski Authenticator kaydı çalışmaz olur.`);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((resolve) => rl.question('Devam edilsin mi? (evet/hayır): ', resolve));
    rl.close();
    if (ans.trim().toLowerCase() !== 'evet') {
      console.log('İşlem iptal edildi.');
      process.exit(0);
    }
  }

  const secret = authenticator.generateSecret();
  const label = 'Abadan Admin (' + (u.rows[0].display_name || userId.slice(0, 8)) + ')';
  const issuer = 'Abadan';
  const otpauthUri = authenticator.keyuri(label, issuer, secret);

  // DB'ye yaz — verified_at hemen dolu (sadece güvenli terminaldeki admin çağırıyor)
  await pool.query(
    'UPDATE users SET admin_totp_secret = $1, admin_totp_verified_at = now() WHERE id = $2',
    [secret, userId]
  );

  // Konsol çıktısı
  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ TOTP kurulumu tamamlandı');
  console.log('═'.repeat(60));
  console.log(`\n  Kullanıcı  : ${u.rows[0].display_name || '(isimsiz)'}`);
  console.log(`  User ID    : ${userId}\n`);

  console.log('  Aşağıdaki QR kodu Google Authenticator ile tara:\n');
  const qrAscii = await QRCode.toString(otpauthUri, { type: 'terminal', small: true });
  console.log(qrAscii);

  console.log('  Ya da manuel giriş için:');
  console.log(`    Hesap adı : ${label}`);
  console.log(`    Anahtar   : ${secret}`);
  console.log(`    Tip       : Zaman tabanlı (TOTP)\n`);

  console.log('  Sonraki adım:');
  console.log('    Panele git → Telefon + PIN + Authenticator 6 haneli kodu ile giriş yap.\n');
  console.log('═'.repeat(60) + '\n');

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Hata:', err);
  process.exit(1);
});
