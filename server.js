// 歯科医院 情報共有アプリ - 依存なしの Node.js サーバー
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CATEGORIES = ['お知らせ', '申し送り', '在庫・発注', '予定', 'マニュアル'];
const PRIORITIES = ['通常', '重要', '緊急'];

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { posts: [] };
  }
}

function save(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function handleApi(req, res, url) {
  const db = load();
  const parts = url.pathname.split('/').filter(Boolean); // ['api','posts',id,...]

  if (parts[1] === 'meta' && req.method === 'GET') {
    return send(res, 200, { categories: CATEGORIES, priorities: PRIORITIES });
  }

  if (parts[1] !== 'posts') return send(res, 404, { error: 'not found' });

  if (parts.length === 2 && req.method === 'GET') {
    return send(res, 200, db.posts);
  }

  if (parts.length === 2 && req.method === 'POST') {
    const b = await readBody(req);
    const title = str(b.title, 100);
    const author = str(b.author, 30);
    if (!title || !author) return send(res, 400, { error: 'タイトルと投稿者は必須です' });
    const post = {
      id: crypto.randomUUID(),
      title,
      body: str(b.body, 5000),
      author,
      category: CATEGORIES.includes(b.category) ? b.category : CATEGORIES[0],
      priority: PRIORITIES.includes(b.priority) ? b.priority : PRIORITIES[0],
      date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : '',
      pinned: false,
      createdAt: new Date().toISOString(),
      readBy: [author],
    };
    db.posts.unshift(post);
    save(db);
    return send(res, 201, post);
  }

  const post = db.posts.find((p) => p.id === parts[2]);
  if (!post) return send(res, 404, { error: '投稿が見つかりません' });

  if (parts.length === 3 && req.method === 'DELETE') {
    db.posts = db.posts.filter((p) => p !== post);
    save(db);
    return send(res, 200, { ok: true });
  }

  if (parts[3] === 'read' && req.method === 'POST') {
    const name = str((await readBody(req)).name, 30);
    if (!name) return send(res, 400, { error: '名前が必要です' });
    if (!post.readBy.includes(name)) post.readBy.push(name);
    save(db);
    return send(res, 200, post);
  }

  if (parts[3] === 'pin' && req.method === 'POST') {
    post.pinned = !post.pinned;
    save(db);
    return send(res, 200, post);
  }

  send(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
