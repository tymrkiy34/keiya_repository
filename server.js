// 歯科医院 情報共有アプリ - 依存なしの Node.js サーバー
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { db, save, UPLOAD_DIR } = require('./lib/store');
const auth = require('./lib/auth');
const notify = require('./lib/notify');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 10 * 1024 * 1024;
const TZ_OFFSET = Number(process.env.TZ_OFFSET_HOURS ?? 9); // 既定: 日本時間
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR ?? 17);

const CATEGORIES = ['お知らせ', '申し送り', '在庫・発注', 'マニュアル'];
const PRIORITIES = ['通常', '重要', '緊急'];
const EVENT_TYPES = ['診療', '休診', '会議・研修', 'その他'];

// 拡張子 → 配信時のContent-Type（クライアント申告は信用しない）
const FILE_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};
const INLINE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
const isEmail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
const uid = () => crypto.randomUUID();

function send(res, status, body, headers = {}) {
  const isBuf = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (over) return; // 上限超過後は読み捨て（接続を切るとエラー応答が返せない）
      if (size > limit) { over = true; chunks.length = 0; }
      else chunks.push(c);
    });
    req.on('end', () => (over ? reject(new HttpError(413, 'ファイルが大きすぎます（上限10MB）')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req, 100 * 1024);
  try { return JSON.parse(raw.toString() || '{}'); } catch { return fail(400, '不正なリクエストです'); }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(req, token, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role });
const fullUser = (u) => ({
  id: u.id, loginId: u.loginId, name: u.name, role: u.role,
  email: u.email || '', notifyEmail: u.notifyEmail !== false,
});

const nowJst = () => new Date(Date.now() + TZ_OFFSET * 3600e3);

// ---- 通知（レスポンスを待たせず裏で送る）----
function notifyBackground(subject, text) {
  notify.notifyAll(subject, text).catch((e) => console.error('[notify]', e.message));
}
const fmtDate = (d) => { const [, m, day] = d.split('-'); return `${Number(m)}/${Number(day)}`; };
const eventLine = (e) =>
  `${fmtDate(e.date)}${e.endDate && e.endDate !== e.date ? `〜${fmtDate(e.endDate)}` : ''} ` +
  `${e.allDay ? '終日' : e.start + (e.end ? `〜${e.end}` : '')} ${e.title}（${e.type}）`;

// ---- 添付ファイル ----
function findParent(kind, id) {
  const p = db[kind].find((x) => x.id === id);
  return p || fail(404, '見つかりません');
}
function canModify(user, item) {
  return user.role === 'admin' || item.authorId === user.id;
}
function removeFiles(item) {
  for (const f of item.files || []) fs.rm(path.join(UPLOAD_DIR, f.stored), { force: true }, () => {});
}

async function uploadFile(req, res, user, kind, id) {
  const item = findParent(kind, id);
  if (!canModify(user, item)) fail(403, '権限がありません');
  item.files ??= [];
  if (item.files.length >= 10) fail(400, '添付は1件につき10ファイルまでです');
  const name = path.basename(decodeURIComponent(str(req.headers['x-filename'], 300)) || 'file').replace(/[\r\n"]/g, '_');
  const ext = path.extname(name).toLowerCase();
  if (!FILE_TYPES[ext]) fail(400, '対応していないファイル形式です（PDF・画像・Office文書・txt・csv・zip）');
  const data = await readRaw(req, MAX_UPLOAD);
  if (!data.length) fail(400, 'ファイルが空です');
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), data, { mode: 0o600 });
  const file = { id: uid(), name, size: data.length, stored, uploadedBy: user.id, createdAt: new Date().toISOString() };
  item.files.push(file);
  save();
  send(res, 201, { id: file.id, name, size: file.size });
}

function serveFile(res, fileId) {
  for (const kind of ['posts', 'events']) {
    for (const item of db[kind]) {
      const f = (item.files || []).find((x) => x.id === fileId);
      if (!f) continue;
      const ext = path.extname(f.name).toLowerCase();
      const full = path.join(UPLOAD_DIR, f.stored);
      if (!fs.existsSync(full)) fail(404, 'ファイルがありません');
      const disp = INLINE.has(ext) ? 'inline' : 'attachment';
      return send(res, 200, fs.readFileSync(full), {
        'Content-Type': FILE_TYPES[ext],
        'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
    }
  }
  fail(404, 'ファイルがありません');
}

function deleteFile(user, fileId) {
  for (const kind of ['posts', 'events']) {
    for (const item of db[kind]) {
      const i = (item.files || []).findIndex((x) => x.id === fileId);
      if (i < 0) continue;
      if (!canModify(user, item)) fail(403, '権限がありません');
      removeFiles({ files: [item.files[i]] });
      item.files.splice(i, 1);
      save();
      return;
    }
  }
  fail(404, 'ファイルがありません');
}

const postOut = (p) => ({ ...p, files: (p.files || []).map(({ id, name, size }) => ({ id, name, size })) });
const eventOut = (e) => ({ ...e, files: (e.files || []).map(({ id, name, size }) => ({ id, name, size })) });

// ---- イベント入力検証 ----
function parseEvent(b) {
  const title = str(b.title, 100);
  if (!title) fail(400, 'タイトルを入力してください');
  if (!isDate(b.date)) fail(400, '日付を入力してください');
  const endDate = isDate(b.endDate) && b.endDate >= b.date ? b.endDate : b.date;
  const allDay = !!b.allDay;
  let start = '', end = '';
  if (!allDay) {
    if (!isTime(b.start)) fail(400, '開始時刻を入力してください');
    start = b.start;
    end = isTime(b.end) ? b.end : '';
    if (end && endDate === b.date && end <= start) fail(400, '終了時刻は開始時刻より後にしてください');
  }
  return {
    title, date: b.date, endDate, allDay, start, end,
    type: EVENT_TYPES.includes(b.type) ? b.type : 'その他',
    memo: str(b.memo, 2000),
  };
}

// ---- API ----
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' を除く
  const method = req.method;
  const [a, b, c] = parts;
  const cookies = parseCookies(req);
  const user = auth.userFromToken(cookies.sid);

  // 認証不要
  if (a === 'status' && method === 'GET') {
    return send(res, 200, { needsSetup: db.users.length === 0, loggedIn: !!user });
  }
  if (a === 'setup' && method === 'POST') {
    if (db.users.length) fail(403, '初期設定は完了しています');
    const body = await readJson(req);
    const u = newUser(body, 'admin');
    db.users.push(u);
    save();
    const token = auth.createSession(u.id);
    return send(res, 201, fullUser(u), { 'Set-Cookie': sessionCookie(req, token, 14 * 86400) });
  }
  if (a === 'login' && method === 'POST') {
    const body = await readJson(req);
    const loginId = str(body.loginId, 40).toLowerCase();
    const key = `${req.socket.remoteAddress}|${loginId}`;
    if (auth.isLocked(key)) fail(429, '試行回数が多すぎます。5分後にもう一度お試しください');
    const u = db.users.find((x) => x.loginId === loginId);
    if (!u || !auth.verifyPassword(String(body.password ?? ''), u.password)) {
      auth.recordFailure(key);
      fail(401, 'ログインIDまたはパスワードが違います');
    }
    auth.clearFailures(key);
    const token = auth.createSession(u.id);
    return send(res, 200, fullUser(u), { 'Set-Cookie': sessionCookie(req, token, 14 * 86400) });
  }
  if (a === 'logout' && method === 'POST') {
    if (cookies.sid) auth.destroySession(cookies.sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // ここから先はログイン必須
  if (!user) fail(401, 'ログインしてください');
  const admin = () => { if (user.role !== 'admin') fail(403, '管理者のみ操作できます'); };

  if (a === 'meta' && method === 'GET') {
    return send(res, 200, {
      categories: CATEGORIES, priorities: PRIORITIES, eventTypes: EVENT_TYPES,
      channels: notify.cfg(),
    });
  }

  // --- ユーザー ---
  if (a === 'me') {
    if (method === 'GET') return send(res, 200, fullUser(user));
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.email !== undefined) {
        const email = str(body.email, 100);
        if (email && !isEmail(email)) fail(400, 'メールアドレスの形式が正しくありません');
        user.email = email;
      }
      if (body.notifyEmail !== undefined) user.notifyEmail = !!body.notifyEmail;
      if (body.newPassword) {
        if (!auth.verifyPassword(String(body.currentPassword ?? ''), user.password)) fail(400, '現在のパスワードが違います');
        checkPassword(body.newPassword);
        user.password = auth.hashPassword(body.newPassword);
        auth.dropUserSessions(user.id);
        save();
        const token = auth.createSession(user.id); // 現在の端末のみ再発行
        return send(res, 200, fullUser(user), { 'Set-Cookie': sessionCookie(req, token, 14 * 86400) });
      }
      save();
      return send(res, 200, fullUser(user));
    }
  }
  if (a === 'users') {
    if (!b && method === 'GET') {
      return send(res, 200, db.users.map(user.role === 'admin' ? fullUser : publicUser));
    }
    if (!b && method === 'POST') {
      admin();
      const body = await readJson(req);
      const u = newUser(body, body.role === 'admin' ? 'admin' : 'staff');
      db.users.push(u);
      save();
      return send(res, 201, fullUser(u));
    }
    if (b && method === 'PATCH') {
      admin();
      const target = db.users.find((x) => x.id === b) || fail(404, 'ユーザーが見つかりません');
      const body = await readJson(req);
      if (body.name !== undefined) target.name = str(body.name, 30) || fail(400, '名前を入力してください');
      if (body.email !== undefined) {
        const email = str(body.email, 100);
        if (email && !isEmail(email)) fail(400, 'メールアドレスの形式が正しくありません');
        target.email = email;
      }
      if (body.role !== undefined && target.id !== user.id) target.role = body.role === 'admin' ? 'admin' : 'staff';
      if (body.password) {
        checkPassword(body.password);
        target.password = auth.hashPassword(body.password);
        auth.dropUserSessions(target.id);
      }
      save();
      return send(res, 200, fullUser(target));
    }
    if (b && method === 'DELETE') {
      admin();
      if (b === user.id) fail(400, '自分自身は削除できません');
      const i = db.users.findIndex((x) => x.id === b);
      if (i < 0) fail(404, 'ユーザーが見つかりません');
      db.users.splice(i, 1);
      auth.dropUserSessions(b);
      save();
      return send(res, 200, { ok: true });
    }
  }

  // --- 投稿 ---
  if (a === 'posts') {
    if (!b && method === 'GET') return send(res, 200, db.posts.map(postOut));
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const title = str(body.title, 100);
      if (!title) fail(400, 'タイトルを入力してください');
      const post = {
        id: uid(), title, body: str(body.body, 5000), authorId: user.id, author: user.name,
        category: CATEGORIES.includes(body.category) ? body.category : CATEGORIES[0],
        priority: PRIORITIES.includes(body.priority) ? body.priority : PRIORITIES[0],
        pinned: false, createdAt: new Date().toISOString(), readBy: [user.id], files: [],
      };
      db.posts.unshift(post);
      save();
      if (body.notify) {
        const tag = post.priority === '通常' ? '' : `【${post.priority}】`;
        notifyBackground(`${tag}${post.title}`, `${post.category} / 投稿者: ${user.name}\n${post.body.slice(0, 200)}`);
      }
      return send(res, 201, postOut(post));
    }
    const post = findParent('posts', b);
    if (!c && method === 'DELETE') {
      if (!canModify(user, post)) fail(403, '権限がありません');
      removeFiles(post);
      db.posts = db.posts.filter((p) => p !== post);
      save();
      return send(res, 200, { ok: true });
    }
    if (c === 'read' && method === 'POST') {
      if (!post.readBy.includes(user.id)) post.readBy.push(user.id);
      save();
      return send(res, 200, postOut(post));
    }
    if (c === 'pin' && method === 'POST') {
      post.pinned = !post.pinned;
      save();
      return send(res, 200, postOut(post));
    }
    if (c === 'files' && method === 'POST') return uploadFile(req, res, user, 'posts', b);
  }

  // --- 予定 ---
  if (a === 'events') {
    if (!b && method === 'GET') return send(res, 200, db.events.map(eventOut));
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const ev = { id: uid(), ...parseEvent(body), authorId: user.id, author: user.name, createdAt: new Date().toISOString(), files: [] };
      db.events.push(ev);
      save();
      if (body.notify) notifyBackground('【予定が追加されました】', `${eventLine(ev)}\n登録: ${user.name}${ev.memo ? `\n${ev.memo.slice(0, 200)}` : ''}`);
      return send(res, 201, eventOut(ev));
    }
    const ev = findParent('events', b);
    if (!c && method === 'PUT') {
      if (!canModify(user, ev)) fail(403, '権限がありません（登録者または管理者のみ編集できます）');
      const body = await readJson(req);
      Object.assign(ev, parseEvent(body));
      save();
      if (body.notify) notifyBackground('【予定が変更されました】', `${eventLine(ev)}\n更新: ${user.name}`);
      return send(res, 200, eventOut(ev));
    }
    if (!c && method === 'DELETE') {
      if (!canModify(user, ev)) fail(403, '権限がありません（登録者または管理者のみ削除できます）');
      removeFiles(ev);
      db.events = db.events.filter((e) => e !== ev);
      save();
      return send(res, 200, { ok: true });
    }
    if (c === 'files' && method === 'POST') return uploadFile(req, res, user, 'events', b);
  }

  // --- 添付ファイル ---
  if (a === 'files' && b) {
    if (method === 'GET') return serveFile(res, b);
    if (method === 'DELETE') { deleteFile(user, b); return send(res, 200, { ok: true }); }
  }

  // --- 通知テスト（管理者）---
  if (a === 'notify' && b === 'test' && method === 'POST') {
    admin();
    const r = await notify.notifyAll('【テスト通知】', `${user.name} さんが送信したテストです。`);
    return send(res, 200, r);
  }

  fail(404, 'not found');
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) fail(400, 'パスワードは8文字以上にしてください');
  if (p.length > 200) fail(400, 'パスワードが長すぎます');
}

function newUser(body, role) {
  const loginId = str(body.loginId, 40).toLowerCase();
  const name = str(body.name, 30);
  if (!/^[a-z0-9._-]{3,40}$/.test(loginId)) fail(400, 'ログインIDは半角英数字（. _ - 可）3〜40文字にしてください');
  if (!name) fail(400, '名前を入力してください');
  checkPassword(body.password);
  if (db.users.some((u) => u.loginId === loginId)) fail(409, 'そのログインIDは既に使われています');
  const email = str(body.email, 100);
  if (email && !isEmail(email)) fail(400, 'メールアドレスの形式が正しくありません');
  return { id: uid(), loginId, name, role, email, notifyEmail: true, password: auth.hashPassword(body.password), createdAt: new Date().toISOString() };
}

// ---- 前日リマインダー（明日の予定をまとめて通知）----
function reminderTick() {
  const c = notify.cfg();
  if (!c.line && !c.email) return;
  const now = nowJst();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < REMINDER_HOUR || db.meta.lastReminder === today) return;
  db.meta.lastReminder = today;
  save();
  const tomorrow = new Date(now.getTime() + 864e5).toISOString().slice(0, 10);
  const list = db.events
    .filter((e) => e.date <= tomorrow && e.endDate >= tomorrow)
    .sort((x, y) => (x.start || '').localeCompare(y.start || ''));
  if (!list.length) return;
  notifyBackground(`【明日の予定】${fmtDate(tomorrow)}`, list.map(eventLine).join('\n'));
}

// ---- 静的ファイル ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found');
    }
    send(res, 200, fs.readFileSync(file), {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Frame-Options': 'DENY',
    });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'サーバーエラーが発生しました' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
  setInterval(reminderTick, 60 * 1000).unref();
}
module.exports = server;
