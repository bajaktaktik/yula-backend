// Belirli kullanıcının graph (connections) cache'ini Redis'ten siler.
// Kullanım:
//   REDIS_URL="redis://default:PASS@HOST:PORT" node scripts/invalidate-graph.js <user_id>
//
// Örnek:
//   REDIS_URL="redis://default:xxx@redis.proxy.rlwy.net:12345" \
//   node scripts/invalidate-graph.js e7df8735-9216-489a-b1fe-a94c0a14fd44

const { createClient } = require('redis');

const userId = process.argv[2];
if (!userId) {
  console.error('Kullanım: REDIS_URL=... node scripts/invalidate-graph.js <user_id>');
  process.exit(1);
}

const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL env yok!');
  process.exit(1);
}

(async () => {
  const client = createClient({ url });
  client.on('error', (e) => console.error('Redis hatası:', e.message));
  await client.connect();
  const key = `connections:${userId}`;
  const existed = await client.exists(key);
  await client.del(key);
  console.log(existed ? `✓ Cache silindi: ${key}` : `(cache zaten yoktu: ${key})`);
  await client.quit();
  process.exit(0);
})().catch((e) => {
  console.error('Hata:', e);
  process.exit(1);
});
