const { Pool } = require('pg');
const config = require('../config');

// Railway/Render/Heroku gibi cloud PG'ler SSL gerektirir.
// Local PG'de SSL yok → connection string'de "sslmode" yoksa açıkça atla.
const isCloud = /sslmode=require/.test(config.databaseUrl || '') ||
                /\.railway\.|\.render\.|\.amazonaws\.|\.supabase\./.test(config.databaseUrl || '');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  ssl: isCloud ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('PostgreSQL bağlantı hatası:', err);
});

module.exports = pool;
