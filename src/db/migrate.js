// Şemayı veritabanına yükleyen basit migrate scripti.
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Şema yükleniyor...');
  try {
    await pool.query(sql);
    console.log('Şema başarıyla yüklendi.');
  } catch (err) {
    console.error('Şema yüklenemedi:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
