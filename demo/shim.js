// デモ用: サーバーAPIをブラウザ内で再現する（データはlocalStorageに保存。使えない環境ではメモリのみ）
(function () {
  'use strict';
  const KEY = 'smile-demo-v1';
  const CATS = ['お知らせ', '申し送り', '在庫・発注', 'マニュアル'];
  const PRIS = ['通常', '重要', '緊急'];
  const TYPES = ['診療', '休診', '会議・研修', 'その他'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
  const pad = (n) => String(n).padStart(2, '0');
  const day = (n) => { const t = new Date(); const x = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

  function seed() {
    const U = (loginId, name, role) => ({ id: uid(), loginId, name, role, email: '', notifyEmail: true, password: 'demo1234' });
    const users = [U('admin', '山田 院長', 'admin'), U('sato', '佐藤', 'staff'), U('suzuki', '鈴木', 'staff'), U('tanaka', '田中', 'staff')];
    const [a, s, z, t] = users;
    const P = (o) => ({ pinned: false, files: [], ...o, id: uid(), authorId: o.by.id, author: o.by.name });
    const posts = [
      P({ by: a, title: '【緊急】明日の診療開始時間の変更について', body: '機器メンテナンスのため、明日は9:30開始となります。\n受付スタッフは予約患者さまへの連絡をお願いします。', category: 'お知らせ', priority: '緊急', createdAt: ago(2), readBy: [a.id, s.id], pinned: true, files: [{ id: uid(), name: '診療スケジュール.pdf', size: 84200 }] }),
      P({ by: z, title: '消耗品の発注（グローブ・コットン）', body: 'Sサイズのグローブが残り2箱です。今週中に発注します。\n他に足りないものがあれば今日中に教えてください。', category: '在庫・発注', priority: '重要', createdAt: ago(5), readBy: [z.id, a.id] }),
      P({ by: s, title: '申し送り: 患者No.1042 経過観察', body: '抜歯後の経過確認。来院時に出血の有無をチェックしてください。', category: '申し送り', priority: '通常', createdAt: ago(20), readBy: [s.id] }),
      P({ by: a, title: '新しい滅菌マニュアル（改訂版）', body: 'オートクレーブの手順を更新しました。添付をご確認ください。', category: 'マニュアル', priority: '通常', createdAt: ago(48), readBy: [a.id, s.id, z.id, t.id], files: [{ id: uid(), name: '滅菌マニュアル_改訂版.pdf', size: 523000 }, { id: uid(), name: 'チェックリスト.xlsx', size: 18500 }] }),
    ];
    const E = (by, o) => ({ endDate: o.date, allDay: false, start: '', end: '', memo: '', files: [], ...o, id: uid(), authorId: by.id, author: by.name, createdAt: ago(30) });
    const events = [
      E(a, { title: '朝礼', date: day(0), start: '08:45', end: '09:00', type: '診療' }),
      E(a, { title: '院内勉強会（根管治療）', date: day(0), start: '13:00', end: '14:00', type: '会議・研修', memo: '講師: 外部歯科医師\n会場: 待合室' }),
      E(a, { title: '機器メンテナンス', date: day(1), start: '09:00', type: '診療', memo: '診療開始は9:30' }),
      E(a, { title: '休診日', date: day(3), allDay: true, type: '休診' }),
      E(a, { title: '予約枠の確認', date: day(5), start: '10:00', type: '診療' }),
      E(s, { title: 'スタッフ研修旅行', date: day(8), endDate: day(9), allDay: true, type: 'その他' }),
      E(a, { title: '月次ミーティング', date: day(12), start: '13:30', end: '14:30', type: '会議・研修' }),
    ];
    return { users, posts, events };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db || !db.users) db = seed();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  let meId = null;

  class Err extends Error { constructor(s, m) { super(m); this.s = s; } }
  const bad = (s, m) => { throw new Err(s, m); };
  const J = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
  const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
  const isMail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
  const pub = (u) => ({ id: u.id, name: u.name, role: u.role });
  const full = (u) => ({ id: u.id, loginId: u.loginId, name: u.name, role: u.role, email: u.email || '', notifyEmail: u.notifyEmail !== false });
  const strip = (x) => ({ ...x, files: (x.files || []).map(({ id, name, size }) => ({ id, name, size })) });
  const demoNotify = () => setTimeout(() => window.toast && window.toast('デモのため、実際のLINE・メールは送信されません'), 400);
  const checkPw = (p) => { if (typeof p !== 'string' || p.length < 8) bad(400, 'パスワードは8文字以上にしてください'); };

  function parseEvent(b) {
    const title = str(b.title, 100);
    if (!title) bad(400, 'タイトルを入力してください');
    if (!isDate(b.date)) bad(400, '日付を入力してください');
    const endDate = isDate(b.endDate) && b.endDate >= b.date ? b.endDate : b.date;
    let start = '', end = '';
    if (!b.allDay) {
      if (!isTime(b.start)) bad(400, '開始時刻を入力してください');
      start = b.start; end = isTime(b.end) ? b.end : '';
      if (end && endDate === b.date && end <= start) bad(400, '終了時刻は開始時刻より後にしてください');
    }
    return { title, date: b.date, endDate, allDay: !!b.allDay, start, end, type: TYPES.includes(b.type) ? b.type : 'その他', memo: str(b.memo, 2000) };
  }

  function handle(method, path, body, headers) {
    const [a, b, c] = path.split('/').filter(Boolean).slice(1);
    const me = db.users.find((u) => u.id === meId);
    if (a === 'status') return { needsSetup: false, loggedIn: !!me };
    if (a === 'login') {
      const u = db.users.find((x) => x.loginId === str(body.loginId, 40).toLowerCase());
      if (!u || u.password !== String(body.password ?? '')) bad(401, 'ログインIDまたはパスワードが違います');
      meId = u.id; return full(u);
    }
    if (a === 'logout') { meId = null; return { ok: true }; }
    if (!me) bad(401, 'ログインしてください');
    const admin = me.role === 'admin';
    const mod = (it) => admin || it.authorId === me.id;
    const needAdmin = () => { if (!admin) bad(403, '管理者のみ操作できます'); };

    if (a === 'meta') return { categories: CATS, priorities: PRIS, eventTypes: TYPES, channels: { line: true, email: true } };
    if (a === 'me') {
      if (method === 'GET') return full(me);
      if (body.email !== undefined) { const e = str(body.email, 100); if (e && !isMail(e)) bad(400, 'メールアドレスの形式が正しくありません'); me.email = e; }
      if (body.notifyEmail !== undefined) me.notifyEmail = !!body.notifyEmail;
      if (body.newPassword) {
        if (me.password !== String(body.currentPassword ?? '')) bad(400, '現在のパスワードが違います');
        checkPw(body.newPassword); me.password = body.newPassword;
      }
      persist(); return full(me);
    }
    if (a === 'users') {
      if (!b && method === 'GET') return db.users.map(admin ? full : pub);
      needAdmin();
      if (!b && method === 'POST') {
        const loginId = str(body.loginId, 40).toLowerCase();
        if (!/^[a-z0-9._-]{3,40}$/.test(loginId)) bad(400, 'ログインIDは半角英数字（. _ - 可）3〜40文字にしてください');
        if (!str(body.name, 30)) bad(400, '名前を入力してください');
        checkPw(body.password);
        if (db.users.some((u) => u.loginId === loginId)) bad(409, 'そのログインIDは既に使われています');
        const email = str(body.email, 100); if (email && !isMail(email)) bad(400, 'メールアドレスの形式が正しくありません');
        const u = { id: uid(), loginId, name: str(body.name, 30), role: body.role === 'admin' ? 'admin' : 'staff', email, notifyEmail: true, password: body.password };
        db.users.push(u); persist(); return full(u);
      }
      const t = db.users.find((u) => u.id === b) || bad(404, 'ユーザーが見つかりません');
      if (method === 'PATCH') {
        if (body.name !== undefined) t.name = str(body.name, 30) || bad(400, '名前を入力してください');
        if (body.email !== undefined) { const e = str(body.email, 100); if (e && !isMail(e)) bad(400, 'メールアドレスの形式が正しくありません'); t.email = e; }
        if (body.role !== undefined && t.id !== me.id) t.role = body.role === 'admin' ? 'admin' : 'staff';
        if (body.password) { checkPw(body.password); t.password = body.password; }
        persist(); return full(t);
      }
      if (method === 'DELETE') {
        if (t.id === me.id) bad(400, '自分自身は削除できません');
        db.users = db.users.filter((u) => u !== t); persist(); return { ok: true };
      }
    }
    if (a === 'posts') {
      if (!b && method === 'GET') return db.posts.map(strip);
      if (!b && method === 'POST') {
        const title = str(body.title, 100); if (!title) bad(400, 'タイトルを入力してください');
        const p = { id: uid(), title, body: str(body.body, 5000), authorId: me.id, author: me.name,
          category: CATS.includes(body.category) ? body.category : CATS[0], priority: PRIS.includes(body.priority) ? body.priority : PRIS[0],
          pinned: false, createdAt: new Date().toISOString(), readBy: [me.id], files: [] };
        db.posts.unshift(p); persist(); if (body.notify) demoNotify(); return strip(p);
      }
      const p = db.posts.find((x) => x.id === b) || bad(404, '見つかりません');
      if (!c && method === 'DELETE') { if (!mod(p)) bad(403, '権限がありません'); db.posts = db.posts.filter((x) => x !== p); persist(); return { ok: true }; }
      if (c === 'read') { if (!p.readBy.includes(me.id)) p.readBy.push(me.id); persist(); return strip(p); }
      if (c === 'pin') { p.pinned = !p.pinned; persist(); return strip(p); }
      if (c === 'files') return addFile(p, me, mod, headers);
    }
    if (a === 'events') {
      if (!b && method === 'GET') return db.events.map(strip);
      if (!b && method === 'POST') {
        const e = { id: uid(), ...parseEvent(body), authorId: me.id, author: me.name, createdAt: new Date().toISOString(), files: [] };
        db.events.push(e); persist(); if (body.notify) demoNotify(); return strip(e);
      }
      const e = db.events.find((x) => x.id === b) || bad(404, '見つかりません');
      if (!c && method === 'PUT') { if (!mod(e)) bad(403, '権限がありません'); Object.assign(e, parseEvent(body)); persist(); if (body.notify) demoNotify(); return strip(e); }
      if (!c && method === 'DELETE') { if (!mod(e)) bad(403, '権限がありません'); db.events = db.events.filter((x) => x !== e); persist(); return { ok: true }; }
      if (c === 'files') return addFile(e, me, mod, headers);
    }
    if (a === 'files' && b && method === 'DELETE') {
      for (const list of [db.posts, db.events]) for (const it of list) {
        const i = (it.files || []).findIndex((f) => f.id === b);
        if (i >= 0) { if (!mod(it)) bad(403, '権限がありません'); it.files.splice(i, 1); persist(); return { ok: true }; }
      }
      bad(404, 'ファイルがありません');
    }
    if (a === 'notify' && b === 'test') { needAdmin(); demoNotify(); return { line: 'demo', email: 'demo' }; }
    bad(404, 'not found');
  }

  function addFile(item, me, mod, headers) {
    if (!mod(item)) bad(403, '権限がありません');
    item.files = item.files || [];
    if (item.files.length >= 10) bad(400, '添付は1件につき10ファイルまでです');
    const name = decodeURIComponent(headers['x-filename'] || 'file');
    item.files.push({ id: uid(), name, size: headers.__size || 1 });
    persist(); return { ok: true };
  }

  window.fetch = async (url, opt = {}) => {
    const h = {};
    for (const [k, v] of Object.entries(opt.headers || {})) h[k.toLowerCase()] = v;
    let body = {};
    if (opt.body && typeof opt.body === 'string') { try { body = JSON.parse(opt.body); } catch {} }
    if (opt.body && typeof opt.body !== 'string') h.__size = opt.body.size;
    try { return J(200, handle((opt.method || 'GET').toUpperCase(), new URL(url, 'http://x').pathname, body, h)); }
    catch (e) { return e instanceof Err ? J(e.s, { error: e.message }) : (console.error(e), J(500, { error: 'デモでエラーが発生しました' })); }
  };
  window.confirm = () => true; // ビューアでは confirm が使えないためデモでは確認を省略

  // ハッシュに頼らない画面遷移（埋め込み環境向け）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (a) {
      e.preventDefault();
      window.__route = a.getAttribute('href').slice(2);
      setTimeout(() => { window.render(); window.scrollTo(0, 0); }, 0);
      return;
    }
    const f = e.target.closest('a[href^="/api/files/"]');
    if (f) { e.preventDefault(); window.toast('デモでは添付ファイルのダウンロードは行えません'); }
  }, true);

  // ログイン画面にワンタップのデモ用ログインを追加
  new MutationObserver(() => {
    const form = document.querySelector('.auth-card');
    if (!form || form.querySelector('.demo-quick')) return;
    const box = document.createElement('div');
    box.className = 'demo-quick';
    box.innerHTML = '<span>デモ用アカウントでログイン</span><div><button type="button" data-u="admin">管理者として</button><button type="button" data-u="sato">スタッフとして</button></div>';
    box.addEventListener('click', (ev) => {
      const u = ev.target.dataset.u; if (!u) return;
      form.querySelector('[name=loginId]').value = u;
      form.querySelector('[name=password]').value = 'demo1234';
      form.requestSubmit();
    });
    form.append(box);
  }).observe(document.getElementById('app'), { childList: true });
})();
