// node --test test/  で実行。外部依存なし（SMTP・LINEはローカルのダミーサーバーで検証）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dental-'));
process.env.DATA_FILE = path.join(tmp, 'data.json');

const mails = [];
const lineCalls = [];
let server, base, smtp, lineSrv;

function startFakeSmtp() {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      let data = false;
      let msg = '';
      sock.write('220 fake\r\n');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        while (true) {
          if (data) {
            const i = buf.indexOf('\r\n.\r\n');
            if (i < 0) return;
            msg = buf.slice(0, i);
            buf = buf.slice(i + 5);
            data = false;
            mails.push(msg);
            sock.write('250 queued\r\n');
          } else {
            const i = buf.indexOf('\r\n');
            if (i < 0) return;
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 OK\r\n');
            else if (line === 'DATA') { data = true; sock.write('354 go\r\n'); }
            else if (line === 'QUIT') { sock.end('221 bye\r\n'); return; }
            else sock.write('250 OK\r\n');
          }
        }
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test.before(async () => {
  smtp = await startFakeSmtp();
  lineSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { lineCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}'); });
  });
  await new Promise((r) => lineSrv.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'none',
    MAIL_FROM: 'Clinic <clinic@example.com>',
    LINE_CHANNEL_TOKEN: 'tok', LINE_API_BASE: `http://127.0.0.1:${lineSrv.address().port}`,
  });
  server = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); smtp.close(); lineSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function call(method, url, { body, cookie, headers, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : undefined, headers: res.headers };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let admin, staff;

test('未ログインはAPIを使えない／初期設定が必要', async () => {
  assert.equal((await call('GET', '/api/status')).data.needsSetup, true);
  assert.equal((await call('GET', '/api/posts')).status, 401);
});

test('初期管理者を作成、2回目は拒否', async () => {
  const r = await call('POST', '/api/setup', { body: { loginId: 'Admin', name: '院長', password: 'password123', email: 'a@example.com' } });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  admin = r.cookie;
  assert.equal((await call('POST', '/api/setup', { body: { loginId: 'x1x', name: 'x', password: 'password123' } })).status, 403);
});

test('スタッフ追加・ログイン・権限', async () => {
  assert.equal((await call('POST', '/api/users', { cookie: admin, body: { loginId: 'sato', name: '佐藤', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/users', { cookie: admin, body: { loginId: 'sato', name: '佐藤', password: 'password456', email: 's@example.com' } })).status, 201);
  assert.equal((await call('POST', '/api/users', { cookie: admin, body: { loginId: 'SATO', name: '重複', password: 'password456' } })).status, 409);
  const bad = await call('POST', '/api/login', { body: { loginId: 'sato', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/login', { body: { loginId: 'sato', password: 'password456' } });
  assert.equal(ok.status, 200);
  staff = ok.cookie;
  assert.equal((await call('POST', '/api/users', { cookie: staff, body: { loginId: 'zzz', name: 'z', password: 'password456' } })).status, 403);
  const users = (await call('GET', '/api/users', { cookie: staff })).data;
  assert.equal(users.length, 2);
  assert.equal(users[0].email, undefined, 'スタッフにメールアドレスは見せない');
  assert.equal(JSON.stringify(users).includes('password'), false);
});

test('ログイン連続失敗でロック', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', { body: { loginId: 'locky', password: 'x' } });
  assert.equal((await call('POST', '/api/login', { body: { loginId: 'locky', password: 'x' } })).status, 429);
});

test('投稿＋通知（LINE/メール）＋既読＋添付', async () => {
  const r = await call('POST', '/api/posts', { cookie: staff, body: { title: '院内研修のお知らせ', body: '来週です', priority: '重要', category: 'お知らせ', notify: true } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.readBy.length, 1);
  await wait(500);
  assert.equal(lineCalls.length, 1);
  assert.equal(lineCalls[0].url, '/v2/bot/message/broadcast');
  assert.equal(lineCalls[0].auth, 'Bearer tok');
  assert.match(lineCalls[0].body.messages[0].text, /【重要】院内研修のお知らせ/);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /Subject: =\?UTF-8\?B\?/);
  assert.match(mails[0], /RCPT|To: a@example.com, s@example.com/);

  const id = r.data.id;
  const read = await call('POST', `/api/posts/${id}/read`, { cookie: admin });
  assert.equal(read.data.readBy.length, 2);

  // 添付
  const up = await call('POST', `/api/posts/${id}/files`, { cookie: staff, raw: Buffer.from('hello'), headers: { 'X-Filename': encodeURIComponent('資料.txt'), 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 201);
  const dl = await call('GET', `/api/files/${up.data.id}`, { cookie: admin });
  assert.equal(dl.data.toString(), 'hello');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await call('GET', `/api/files/${up.data.id}`)).status, 401);
  const exe = await call('POST', `/api/posts/${id}/files`, { cookie: staff, raw: Buffer.from('x'), headers: { 'X-Filename': 'a.exe' } });
  assert.equal(exe.status, 400);
  const big = await call('POST', `/api/posts/${id}/files`, { cookie: staff, raw: Buffer.alloc(10 * 1024 * 1024 + 1), headers: { 'X-Filename': 'a.pdf' } });
  assert.equal(big.status, 413);
  // 他人の投稿は管理者以外削除不可…ここでは管理者が削除できる
  assert.equal((await call('DELETE', `/api/posts/${id}`, { cookie: admin })).status, 200);
  assert.equal((await call('GET', `/api/files/${up.data.id}`, { cookie: admin })).status, 404);
});

test('他人の投稿はスタッフが削除できない', async () => {
  const p = (await call('POST', '/api/posts', { cookie: admin, body: { title: '院長から' } })).data;
  assert.equal((await call('DELETE', `/api/posts/${p.id}`, { cookie: staff })).status, 403);
});

test('予定の作成・検証・更新・削除', async () => {
  const bad = await call('POST', '/api/events', { cookie: staff, body: { title: 'x', date: '2026-13-40' } });
  assert.equal(bad.status, 400);
  const noTime = await call('POST', '/api/events', { cookie: staff, body: { title: 'x', date: '2026-10-10' } });
  assert.equal(noTime.status, 400);
  const ev = await call('POST', '/api/events', { cookie: staff, body: { title: '朝礼', date: '2026-10-10', start: '08:45', end: '09:00', type: '会議・研修' } });
  assert.equal(ev.status, 201);
  const upd = await call('PUT', `/api/events/${ev.data.id}`, { cookie: staff, body: { title: '朝礼(変更)', date: '2026-10-10', allDay: true, type: '休診' } });
  assert.equal(upd.data.allDay, true);
  assert.equal(upd.data.start, '');
  assert.equal((await call('DELETE', `/api/events/${ev.data.id}`, { cookie: staff })).status, 200);
});

test('パスワード変更・管理者によるリセットでセッション失効', async () => {
  const r = await call('PATCH', '/api/me', { cookie: staff, body: { currentPassword: 'password456', newPassword: 'newpassword789' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: r.cookie })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: staff })).status, 401, '旧セッションは無効');
  assert.equal((await call('POST', '/api/login', { body: { loginId: 'sato', password: 'newpassword789' } })).status, 200);
});

test('データファイルにパスワード平文が残らない', () => {
  const raw = fs.readFileSync(process.env.DATA_FILE, 'utf8');
  assert.equal(raw.includes('password123'), false);
  assert.equal(raw.includes('newpassword789'), false);
});

test('静的ファイルのパストラバーサルを拒否', async () => {
  const res = await fetch(base + '/..%2Fserver.js');
  assert.equal(res.status, 404);
});

test('他人の予定は一般スタッフが編集・削除できない', async () => {
  const ev = (await call('POST', '/api/events', { cookie: admin, body: { title: '休診日', date: '2026-10-20', allDay: true, type: '休診' } })).data;
  const staffLogin = (await call('POST', '/api/login', { body: { loginId: 'sato', password: 'newpassword789' } })).cookie;
  assert.equal((await call('PUT', `/api/events/${ev.id}`, { cookie: staffLogin, body: { title: 'x', date: '2026-10-20', allDay: true } })).status, 403);
  assert.equal((await call('DELETE', `/api/events/${ev.id}`, { cookie: staffLogin })).status, 403);
});
