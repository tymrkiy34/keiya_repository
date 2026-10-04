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
const LAB_STATUSES = ['依頼', '製作中', '外注中', '完成', 'セット済'];
const LAB_TYPES = ['クラウン', 'ブリッジ', 'インレー・アンレー', 'ラミネートベニア', '部分床義歯', '総義歯', 'インプラント上部構造', 'マウスピース・スプリント', '矯正装置', 'その他'];
const LOCATIONS = ['技工室', 'チェアサイド', 'その他'];
const ITEM_CATEGORIES = ['消耗品', '薬剤', '印象材・石膏', '金属・セラミック', 'レジン・ワックス', '器具・バー', 'その他'];
const JOBS = ['歯科医師', '歯科衛生士', '歯科技工士', '歯科助手', '受付', 'その他'];
// 添付ファイルの親データ: ルート名 → 保存先コレクション
const COLLECTIONS = { posts: 'posts', events: 'events', lab: 'labOrders' };

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

const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, jobTitle: u.jobTitle || '' });
const fullUser = (u) => ({
  id: u.id, loginId: u.loginId, name: u.name, role: u.role, jobTitle: u.jobTitle || '',
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
  const p = db[COLLECTIONS[kind]].find((x) => x.id === id);
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
  if (kind !== 'lab' && !canModify(user, item)) fail(403, '権限がありません'); // 技工物の添付は全スタッフ可
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
  for (const coll of Object.values(COLLECTIONS)) {
    for (const item of db[coll]) {
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
  for (const coll of Object.values(COLLECTIONS)) {
    for (const item of db[coll]) {
      const i = (item.files || []).findIndex((x) => x.id === fileId);
      if (i < 0) continue;
      if (coll !== 'labOrders' && !canModify(user, item)) fail(403, '権限がありません');
      removeFiles({ files: [item.files[i]] });
      item.files.splice(i, 1);
      save();
      return;
    }
  }
  fail(404, 'ファイルがありません');
}

const postOut = (p) => ({ ...p, files: (p.files || []).map(({ id, name, size }) => ({ id, name, size })) });
const labOut = (o) => ({ ...o, files: (o.files || []).map(({ id, name, size }) => ({ id, name, size })) });
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

function parseLab(b) {
  const patientRef = str(b.patientRef, 40);
  if (!patientRef) fail(400, '患者番号（またはイニシャル）を入力してください');
  if (!LAB_TYPES.includes(b.type)) fail(400, '技工物の種類を選んでください');
  if (!isDate(b.dueDate)) fail(400, '納期を入力してください');
  const requestDate = isDate(b.requestDate) ? b.requestDate : nowJst().toISOString().slice(0, 10);
  if (b.dueDate < requestDate) fail(400, '納期は依頼日以降にしてください');
  return {
    patientRef, type: b.type, teeth: str(b.teeth, 60), material: str(b.material, 60), shade: str(b.shade, 30),
    doctor: str(b.doctor, 40), lab: str(b.lab, 60),
    assigneeId: db.users.some((u) => u.id === b.assigneeId) ? b.assigneeId : '',
    requestDate, dueDate: b.dueDate, setDate: isDate(b.setDate) ? b.setDate : '',
    urgent: !!b.urgent, memo: str(b.memo, 2000),
  };
}
const qtyNum = (v, label) => {
  const n = Number(v === '' || v == null ? 0 : v);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) fail(400, `${label}は0以上の数値で入力してください`);
  return Math.round(n * 100) / 100;
};
function parseItem(b) {
  const name = str(b.name, 60);
  if (!name) fail(400, '品名を入力してください');
  if (!LOCATIONS.includes(b.location)) fail(400, '置き場所を選んでください');
  return {
    name, location: b.location,
    category: ITEM_CATEGORIES.includes(b.category) ? b.category : 'その他',
    unit: str(b.unit, 10) || '個',
    reorderPoint: qtyNum(b.reorderPoint, '発注点'), target: qtyNum(b.target, '適正在庫'),
    supplier: str(b.supplier, 60), expiry: isDate(b.expiry) ? b.expiry : '', memo: str(b.memo, 500),
  };
}
const today = () => nowJst().toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// 発注点を下回った時に1回だけ通知（補充されるまで再通知しない）
function checkLowStock(item) {
  const low = item.reorderPoint > 0 ? item.qty <= item.reorderPoint : item.qty <= 0;
  if (!low) { item.lowNotified = false; return; }
  if (item.lowNotified || item.orderedAt || process.env.INVENTORY_NOTIFY === '0') return;
  item.lowNotified = true;
  notifyBackground(`【在庫少】${item.name}`, `${item.location}: 残り${item.qty}${item.unit}（発注点 ${item.reorderPoint}${item.unit}）${item.supplier ? `\n仕入先: ${item.supplier}` : ''}`);
}
function logStock(item, user, type, delta, note) {
  db.stockLogs.push({ id: uid(), itemId: item.id, itemName: item.name, location: item.location, type, delta, qty: item.qty, note, by: user.name, at: new Date().toISOString() });
  if (db.stockLogs.length > 500) db.stockLogs.splice(0, db.stockLogs.length - 500);
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
      labStatuses: LAB_STATUSES, labTypes: LAB_TYPES, locations: LOCATIONS, itemCategories: ITEM_CATEGORIES, jobs: JOBS,
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
      if (body.jobTitle !== undefined) user.jobTitle = JOBS.includes(body.jobTitle) ? body.jobTitle : '';
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
      if (body.jobTitle !== undefined) target.jobTitle = JOBS.includes(body.jobTitle) ? body.jobTitle : '';
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

  // --- 技工物 ---
  if (a === 'lab') {
    if (!b && method === 'GET') return send(res, 200, db.labOrders.map(labOut));
    if (!b && method === 'POST') {
      const body = await readJson(req);
      db.meta.labSeq = (db.meta.labSeq || 0) + 1;
      const o = {
        id: uid(), no: `L-${String(db.meta.labSeq).padStart(4, '0')}`, ...parseLab(body), status: '依頼', remakeCount: 0,
        authorId: user.id, author: user.name, createdAt: new Date().toISOString(), files: [],
        history: [{ at: new Date().toISOString(), by: user.name, status: '依頼', note: '依頼を登録' }],
      };
      db.labOrders.unshift(o);
      save();
      if (body.notify) notifyBackground(`【技工物の依頼】${o.no} ${o.type}`, `患者: ${o.patientRef} / 依頼医: ${o.doctor || '—'}\n納期: ${fmtDate(o.dueDate)}${o.urgent ? '（急ぎ）' : ''}`);
      return send(res, 201, labOut(o));
    }
    const o = findParent('lab', b);
    if (!c && method === 'PUT') {
      Object.assign(o, parseLab(await readJson(req)));
      save();
      return send(res, 200, labOut(o));
    }
    if (!c && method === 'DELETE') {
      if (!canModify(user, o)) fail(403, '権限がありません（登録者または管理者のみ削除できます）');
      removeFiles(o);
      db.labOrders = db.labOrders.filter((x) => x !== o);
      save();
      return send(res, 200, { ok: true });
    }
    if (c === 'status' && method === 'POST') {
      const body = await readJson(req);
      if (!LAB_STATUSES.includes(body.status)) fail(400, '工程が正しくありません');
      if (body.status === o.status) fail(400, 'すでにその工程です');
      o.status = body.status;
      o.history.push({ at: new Date().toISOString(), by: user.name, status: body.status, note: str(body.note, 200) });
      save();
      if (body.notify) notifyBackground(`【技工物 ${o.status}】${o.no} ${o.type}`, `患者: ${o.patientRef} / 依頼医: ${o.doctor || '—'}\n納期: ${fmtDate(o.dueDate)}${str(body.note, 200) ? `\n${str(body.note, 200)}` : ''}`);
      return send(res, 200, labOut(o));
    }
    if (c === 'remake' && method === 'POST') {
      const body = await readJson(req);
      o.status = '製作中';
      o.remakeCount = (o.remakeCount || 0) + 1;
      o.history.push({ at: new Date().toISOString(), by: user.name, status: '製作中', note: `再製作（${o.remakeCount}回目）${str(body.note, 200) ? ': ' + str(body.note, 200) : ''}` });
      save();
      return send(res, 200, labOut(o));
    }
    if (c === 'files' && method === 'POST') return uploadFile(req, res, user, 'lab', b);
  }

  // --- 在庫（技工室・チェアサイド）---
  if (a === 'inventory') {
    if (!b && method === 'GET') return send(res, 200, { items: db.items, logs: db.stockLogs.slice(-300).reverse() });
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const item = { id: uid(), ...parseItem(body), qty: qtyNum(body.qty, '現在数'), orderedAt: '', lowNotified: false, createdAt: new Date().toISOString() };
      db.items.push(item);
      logStock(item, user, 'new', item.qty, '品目を登録');
      checkLowStock(item);
      save();
      return send(res, 201, item);
    }
    if (b === 'bulk-ordered' && method === 'POST') {
      const body = await readJson(req);
      for (const id of Array.isArray(body.ids) ? body.ids : []) {
        const it = db.items.find((x) => x.id === id);
        if (it) it.orderedAt = today();
      }
      save();
      return send(res, 200, { ok: true });
    }
    const item = db.items.find((x) => x.id === b) || fail(404, '品目が見つかりません');
    if (!c && method === 'PUT') {
      Object.assign(item, parseItem(await readJson(req)));
      checkLowStock(item);
      save();
      return send(res, 200, item);
    }
    if (!c && method === 'DELETE') {
      admin();
      db.items = db.items.filter((x) => x !== item);
      save();
      return send(res, 200, { ok: true });
    }
    if (c === 'adjust' && method === 'POST') {
      const body = await readJson(req);
      const amount = qtyNum(body.amount, '数量');
      const note = str(body.note, 100);
      const before = item.qty;
      if (body.type === 'use') {
        if (amount <= 0) fail(400, '数量を入力してください');
        if (amount > item.qty) fail(400, `在庫（${item.qty}${item.unit}）より多く使用できません`);
        item.qty = round2(item.qty - amount);
      } else if (body.type === 'in') {
        if (amount <= 0) fail(400, '数量を入力してください');
        item.qty = round2(item.qty + amount);
        item.orderedAt = ''; // 入庫したら発注済みを解除
      } else if (body.type === 'set') {
        item.qty = amount; // 棚卸
      } else fail(400, '操作が正しくありません');
      logStock(item, user, body.type, round2(item.qty - before), note);
      checkLowStock(item);
      save();
      return send(res, 200, item);
    }
    if (c === 'ordered' && method === 'POST') {
      const body = await readJson(req);
      item.orderedAt = body.ordered ? today() : '';
      if (!body.ordered) item.lowNotified = false;
      save();
      return send(res, 200, item);
    }
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
  return { id: uid(), loginId, name, role, email, jobTitle: JOBS.includes(body.jobTitle) ? body.jobTitle : '', notifyEmail: true, password: auth.hashPassword(body.password), createdAt: new Date().toISOString() };
}

// ---- 前日リマインダー（明日の予定をまとめて通知）----
function reminderTick() {
  const c = notify.cfg();
  if (!c.line && !c.email) return;
  const now = nowJst();
  const todayStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < REMINDER_HOUR || db.meta.lastReminder === todayStr) return;
  db.meta.lastReminder = todayStr;
  save();
  const tomorrow = new Date(now.getTime() + 864e5).toISOString().slice(0, 10);
  const list = db.events
    .filter((e) => e.date <= tomorrow && e.endDate >= tomorrow)
    .sort((x, y) => (x.start || '').localeCompare(y.start || ''));
  if (list.length) notifyBackground(`【明日の予定】${fmtDate(tomorrow)}`, list.map(eventLine).join('\n'));
  const due = db.labOrders.filter((o) => o.status !== 'セット済' && o.dueDate <= tomorrow);
  if (due.length) {
    notifyBackground('【技工物の納期】今日・明日・超過分', due.map((o) => `${o.no} ${o.type}（患者 ${o.patientRef}）納期 ${fmtDate(o.dueDate)} ${o.status}`).join('\n'));
  }
  const soon = new Date(now.getTime() + 14 * 864e5).toISOString().slice(0, 10);
  const exp = db.items.filter((i) => i.expiry && i.expiry <= soon && i.qty > 0);
  if (exp.length) notifyBackground('【在庫】使用期限が近い品目', exp.map((i) => `${i.name}（${i.location}）期限 ${i.expiry}`).join('\n'));
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
