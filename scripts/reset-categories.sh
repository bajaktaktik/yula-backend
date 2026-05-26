#!/usr/bin/env bash
# Kategorileri sıfırdan kurar — eski kalıntıları siler.

set -e
cd "$(dirname "$0")/.."

DB="postgres://yula:yula@localhost:5432/yula"

echo "1/4  İlanların category_id'si NULL'lanıyor..."
psql "$DB" -c "UPDATE listings SET category_id = NULL;" > /dev/null

echo "2/4  Tüm kategoriler siliniyor..."
psql "$DB" -c "DELETE FROM categories; ALTER SEQUENCE categories_id_seq RESTART WITH 1;" > /dev/null

echo "3/4  yulacat.txt'den kategoriler yükleniyor..."
node scripts/seed-categories.js

echo "4/4  Otomobil ve motosiklet markaları ekleniyor..."
node scripts/seed-vehicle-brands.js

echo ""
echo "✓ Tamamlandı. Eski duplikatlar silindi."
echo "  Şimdi ilanları kategoriye eşlemek için:"
echo "    node scripts/fix-listing-categories.js"
