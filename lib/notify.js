// LINE（Messaging API）とメール（SMTP）への通知。設定はすべて環境変数。
//   LINE_CHANNEL_TOKEN  チャネルアクセストークン（長期）
//   LINE_TO             送信先のグループID/ユーザーID。未設定なら友だち全員へ配信
//   SMTP_HOST SMTP_PORT SMTP_SECURE(ssl|starttls|none) SMTP_USER SMTP_PASS MAIL_FROM
//   APP_URL             通知に載せるアプリのURL
const net = require('net');
const tls = require('tls');
const { db } = require('./store');

const env = process.env;
const cfg = () => ({
  line: !!env.LINE_CHANNEL_TOKEN,
  email: !!(env.SMTP_HOST && env.MAIL_FROM),
});

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

async function sendLine(text) {
  const to = env.LINE_TO;
  const base = env.LINE_API_BASE || 'https://api.line.me'; // テスト用に差し替え可能
  const res = await fetch(`${base}/v2/bot/message/${to ? 'push' : 'broadcast'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({ ...(to ? { to } : {}), messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LINE ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---- 最小限のSMTPクライアント ----
function smtpSend({ host, port, secure, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    let sock;
    let buf = '';
    let waiter = null;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock && sock.destroy(); } catch {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timeout')), 30000);

    const attach = (s) => {
      sock = s;
      s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; pump(); });
      s.on('error', finish);
      s.on('close', () => finish(new Error('SMTP connection closed')));
    };
    // 複数行応答（"250-..." 続き行、"250 ..." 最終行）を1つにまとめて返す
    function pump() {
      if (!waiter) return;
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiter;
          waiter = null;
          return w(reply);
        }
      }
    }
    const read = () => new Promise((r) => { waiter = r; pump(); });
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const reply = await read();
      if (!ok.includes(reply.slice(0, 3))) throw new Error(`SMTP: ${reply}`);
      return reply;
    };
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

    (async () => {
      const connected = new Promise((r) => {
        if (secure === 'ssl') attach(tls.connect({ host, port, servername: host }, r));
        else attach(net.connect({ host, port }, r));
      });
      await connected;
      await cmd(null, ['220']);
      await cmd('EHLO clinic-app', ['250']);
      if (secure === 'starttls') {
        await cmd('STARTTLS', ['220']);
        sock.removeAllListeners();
        buf = '';
        await new Promise((r) => attach(tls.connect({ socket: sock, servername: host }, r)));
        await cmd('EHLO clinic-app', ['250']);
      }
      if (user) {
        await cmd('AUTH LOGIN', ['334']);
        await cmd(b64(user), ['334']);
        await cmd(b64(pass || ''), ['235']);
      }
      const addr = (s) => s.replace(/[<>\r\n]/g, '');
      const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
      await cmd(`MAIL FROM:<${addr(fromAddr)}>`, ['250']);
      for (const t of to) await cmd(`RCPT TO:<${addr(t)}>`, ['250', '251']);
      await cmd('DATA', ['354']);
      const body = Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
      const msg = [
        `From: ${oneLine(from)}`,
        `To: ${to.map(oneLine).join(', ')}`,
        `Subject: =?UTF-8?B?${b64(oneLine(subject))}?=`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '', body, '.',
      ].join('\r\n');
      await cmd(msg, ['250']);
      sock.write('QUIT\r\n');
      finish();
    })().catch(finish);
  });
}

function sendMail(to, subject, text) {
  const secure = (env.SMTP_SECURE || 'starttls').toLowerCase();
  return smtpSend({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || (secure === 'ssl' ? 465 : secure === 'none' ? 25 : 587),
    secure,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    to,
    subject,
    text,
  });
}

// 全チャネルへ通知。失敗しても呼び出し元は止めない（結果を返すだけ）。
async function notifyAll(subject, text) {
  const c = cfg();
  const url = env.APP_URL ? `\n\n${env.APP_URL}` : '';
  const results = { line: 'off', email: 'off' };
  const jobs = [];
  if (c.line) {
    jobs.push(
      sendLine(`${subject}\n${text}${url}`)
        .then(() => (results.line = 'ok'))
        .catch((e) => { results.line = 'error'; console.error('[notify:line]', e.message); }),
    );
  }
  if (c.email) {
    const to = db.users.filter((u) => u.email && u.notifyEmail !== false).map((u) => u.email);
    if (to.length) {
      jobs.push(
        sendMail(to, subject, `${text}${url}`)
          .then(() => (results.email = 'ok'))
          .catch((e) => { results.email = 'error'; console.error('[notify:email]', e.message); }),
      );
    }
  }
  await Promise.all(jobs);
  return results;
}

module.exports = { cfg, notifyAll, smtpSend };
