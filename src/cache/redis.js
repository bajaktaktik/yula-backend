const { createClient } = require('redis');
const config = require('../config');

const client = createClient({ url: config.redisUrl });
client.on('error', (err) => console.error('Redis hatası:', err));

(async () => {
  try {
    await client.connect();
    console.log('Redis bağlandı.');
  } catch (err) {
    console.error('Redis bağlanamadı:', err);
  }
})();

module.exports = client;
