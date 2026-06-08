// Redis client — toleranslı. Bağlantı düşerse:
// - Hata sessizce log'lanır (her saniye spam etmez, sadece ilk hata)
// - Reconnect denenir ama uygulamayı bloke etmez
// - Redis kullanan fonksiyonlar fail durumunda graceful (try/catch sessiz dönmeli)

const { createClient } = require('redis');
const config = require('../config');

const client = createClient({
  url: config.redisUrl,
  socket: {
    connectTimeout: 5000,
    // Üstel backoff ile reconnect — sürekli ECONNREFUSED spam'i engeller
    reconnectStrategy: (retries) => {
      if (retries > 20) {
        console.warn('[redis] max reconnect attempts reached, giving up');
        return false; // dur
      }
      return Math.min(retries * 500, 10000); // 0.5s, 1s, ... max 10s
    },
  },
});

let lastErrorLogAt = 0;
client.on('error', (err) => {
  // Tekrarlayan hataları her 60 sn'de bir logla
  const now = Date.now();
  if (now - lastErrorLogAt > 60000) {
    console.error('[redis] connection error:', err.message);
    lastErrorLogAt = now;
  }
});

client.on('connect', () => console.log('[redis] connected.'));
client.on('reconnecting', () => {/* sessiz */});

(async () => {
  try {
    await client.connect();
  } catch (err) {
    console.warn('[redis] initial connect failed, will retry in background:', err.message);
  }
})();

module.exports = client;
