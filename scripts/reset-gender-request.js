// Bekleyen cinsiyet değişikliği talebini siler — test için yeniden talep oluşturabilmek için.
// Varsayılan: en son aktif kullanıcının TÜM talepleri (pending/approved/rejected).
//
// Kullanım:
//   node scripts/reset-gender-request.js                → en son aktif kullanıcı
//   node scripts/reset-gender-request.js --user <id>    → belirli kullanıcı
//   node scripts/reset-gender-request.js --all          → tüm kullanıcıların TÜM talepleri
//   node scripts/reset-gender-request.js --pending-only → sadece pending olanlar

const pool = require('../src/db/pool');

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { user: null, all: false, pendingOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') out.user = argv[++i];
    else if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--pending-only') out.pendingOnly = true;
  }
  return out;
}

async function pickTarget(args) {
  if (args.user) return [args.user];
  if (args.all) {
    const { rows } = await pool.query('SELECT DISTINCT requester_id FROM gender_change_requests');
    return rows.map((r) => r.requester_id);
  }
  const { rows } = await pool.query(
    `SELECT id, display_name FROM users
     ORDER BY last_active_at DESC NULLS LAST, created_at DESC LIMIT 1`
  );
  if (rows.length === 0) return [];
  console.log(`🎯 En son aktif kullanıcı: ${rows[0].display_name} (${rows[0].id})`);
  return [rows[0].id];
}

async function main() {
  const args = parseArgs();
  const targets = await pickTarget(args);
  if (targets.length === 0) {
    console.log('⚠ Hedef bulunamadı.');
    await pool.end();
    return;
  }

  const statusFilter = args.pendingOnly ? `AND status = 'pending'` : '';

  let totalReqs = 0;
  let totalNotifs = 0;

  for (const userId of targets) {
    // 1) Bu kullanıcının taleplerini bul
    const reqs = await pool.query(
      `SELECT id, current_gender, target_gender, status FROM gender_change_requests
       WHERE requester_id = $1 ${statusFilter}`,
      [userId]
    );

    if (reqs.rows.length === 0) {
      console.log(`  ℹ ${userId}: talep yok, atlanıyor`);
      continue;
    }

    const reqIds = reqs.rows.map((r) => r.id);

    // 2) İlgili bildirimleri sil:
    //    - Onaylayıcılara giden gender_change_request bildirimleri
    //    - Talep sahibine giden gender_change_approved / rejected bildirimleri
    const delNotif = await pool.query(
      `DELETE FROM notifications
       WHERE type IN ('gender_change_request', 'gender_change_approved', 'gender_change_rejected')
         AND (payload->>'request_id')::uuid = ANY($1::uuid[])`,
      [reqIds]
    );
    totalNotifs += delNotif.rowCount;

    // 3) Talepleri sil (CASCADE oyları da siler)
    const delReq = await pool.query(
      `DELETE FROM gender_change_requests WHERE id = ANY($1::uuid[])`,
      [reqIds]
    );
    totalReqs += delReq.rowCount;

    console.log(`  ✓ ${userId}: ${delReq.rowCount} talep + ${delNotif.rowCount} bildirim silindi`);
    for (const r of reqs.rows) {
      console.log(`     - ${r.current_gender} → ${r.target_gender}  [${r.status}]`);
    }
  }

  console.log(`\n✓ Toplam: ${totalReqs} talep, ${totalNotifs} bildirim silindi.`);
  console.log('  Uygulamada Profil > Bilgilerimi Düzenle ekranını yenile.');
  await pool.end();
}

main().catch((e) => {
  console.error('✗ Hata:', e);
  pool.end();
  process.exit(1);
});
