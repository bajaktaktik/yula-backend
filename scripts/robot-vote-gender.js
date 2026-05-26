// Bekleyen cinsiyet değişikliği talepleri için robotların oy vermesini sağlar.
// Direkt DB'ye yazar — gerçek HTTP akışını taklit eder ama auth gerekmez.
//
// Kullanım:
//   node scripts/robot-vote-gender.js               → tüm robotlar ONAYLA
//   node scripts/robot-vote-gender.js --reject      → tüm robotlar REDDET
//   node scripts/robot-vote-gender.js --reject 1    → sadece 1 robot REDDET, geri kalanı ONAYLA

const crypto = require('crypto');
const pool = require('../src/db/pool');

const ROBOT_SEEDS = [
  'gender-test-female-1',
  'gender-test-female-2',
  'gender-test-male-1',
  'gender-test-male-2',
];

function phoneHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

async function findRobots(client) {
  const hashes = ROBOT_SEEDS.map(phoneHash);
  const { rows } = await client.query(
    `SELECT id, display_name, gender FROM users WHERE phone_hash = ANY($1::text[])`,
    [hashes]
  );
  return rows;
}

async function findPendingRequests(client) {
  const { rows } = await client.query(
    `SELECT r.id, r.requester_id, r.current_gender, r.target_gender,
            r.approvals_needed, r.approvals_received, r.rejections_received,
            u.display_name AS requester_name
     FROM gender_change_requests r
     JOIN users u ON u.id = r.requester_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at DESC`
  );
  return rows;
}

async function castVote(client, requestId, voterId, vote) {
  // 1) Oy ekle (varsa atla)
  const ins = await client.query(
    `INSERT INTO gender_change_votes (request_id, voter_id, vote)
     VALUES ($1, $2, $3)
     ON CONFLICT (request_id, voter_id) DO NOTHING
     RETURNING id`,
    [requestId, voterId, vote]
  );
  if (ins.rowCount === 0) return false; // zaten oy vermiş

  // 2) Sayaçları güncelle
  if (vote === 'approve') {
    await client.query(
      `UPDATE gender_change_requests SET approvals_received = approvals_received + 1 WHERE id = $1`,
      [requestId]
    );
  } else {
    await client.query(
      `UPDATE gender_change_requests SET rejections_received = rejections_received + 1 WHERE id = $1`,
      [requestId]
    );
  }
  return true;
}

async function maybeResolve(client, requestId) {
  const { rows } = await client.query(
    `SELECT requester_id, target_gender, status, approvals_needed,
            approvals_received, rejections_received
     FROM gender_change_requests WHERE id = $1`,
    [requestId]
  );
  const r = rows[0];
  if (!r || r.status !== 'pending') return r?.status;

  if (r.approvals_received >= r.approvals_needed) {
    await client.query(
      `UPDATE gender_change_requests SET status = 'approved', resolved_at = now() WHERE id = $1`,
      [requestId]
    );
    await client.query(`UPDATE users SET gender = $1 WHERE id = $2`, [r.target_gender, r.requester_id]);
    await client.query(
      `INSERT INTO notifications (user_id, type, payload)
       VALUES ($1, 'gender_change_approved', $2)`,
      [r.requester_id, JSON.stringify({ request_id: requestId, target_gender: r.target_gender })]
    );
    return 'approved';
  }
  if (r.rejections_received >= 1) {
    await client.query(
      `UPDATE gender_change_requests SET status = 'rejected', resolved_at = now() WHERE id = $1`,
      [requestId]
    );
    await client.query(
      `INSERT INTO notifications (user_id, type, payload)
       VALUES ($1, 'gender_change_rejected', $2)`,
      [r.requester_id, JSON.stringify({ request_id: requestId, target_gender: r.target_gender })]
    );
    return 'rejected';
  }
  return 'pending';
}

async function main() {
  const rejectIdx = process.argv.indexOf('--reject');
  const allReject = rejectIdx >= 0 && process.argv[rejectIdx + 1] === undefined;
  const partialReject = rejectIdx >= 0 ? parseInt(process.argv[rejectIdx + 1], 10) : 0;

  const client = await pool.connect();
  try {
    const robots = await findRobots(client);
    if (robots.length === 0) {
      console.log('⚠ Robot bulunamadı. Önce: node scripts/create-test-users.js');
      return;
    }
    console.log(`🤖 ${robots.length} robot bulundu`);

    const pending = await findPendingRequests(client);
    if (pending.length === 0) {
      console.log('ℹ Bekleyen cinsiyet değişikliği talebi yok.');
      return;
    }

    for (const req of pending) {
      console.log(`\n📋 Talep: ${req.requester_name} → ${req.target_gender}`);
      console.log(`   (${req.approvals_received}/${req.approvals_needed} onay, ${req.rejections_received} red)`);

      // Target cinsten olan robotları al
      const eligible = robots.filter((r) => r.gender === req.target_gender);
      if (eligible.length === 0) {
        console.log(`   ⚠ ${req.target_gender} cinsten robot yok, atlanıyor`);
        continue;
      }

      let voteIndex = 0;
      for (const robot of eligible) {
        let vote = 'approve';
        if (allReject || (partialReject > 0 && voteIndex < partialReject)) {
          vote = 'reject';
        }
        await client.query('BEGIN');
        try {
          const ok = await castVote(client, req.id, robot.id, vote);
          if (!ok) {
            console.log(`   ↻ ${robot.display_name}: zaten oy vermiş`);
            await client.query('COMMIT');
            continue;
          }
          const status = await maybeResolve(client, req.id);
          await client.query('COMMIT');
          console.log(`   ${vote === 'approve' ? '✓' : '✗'} ${robot.display_name}: ${vote.toUpperCase()} → talep ${status}`);
          if (status === 'approved' || status === 'rejected') {
            break; // Talep çözüldü, başka oy almaya gerek yok
          }
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        voteIndex++;
      }
    }

    console.log('\n✓ Bitti. Uygulamada Bildirimler'i yenile.');
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
