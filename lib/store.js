// JSONファイルによる簡易ストア（単一プロセス前提・メモリキャッシュ＋原子的書き込み）
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DATA_FILE), 'uploads');

let db;
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  db = {};
}
for (const k of ['users', 'sessions', 'posts', 'events']) db[k] ??= [];
db.meta ??= {};
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

module.exports = { db, save, UPLOAD_DIR };
