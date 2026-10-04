// パスワードハッシュ・セッション・ログイン試行制限
const crypto = require('crypto');
const { db, save } = require('./store');

const SESSION_DAYS = 14;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => s.expires > now);
  db.sessions.push({ hash: sha256(token), userId, expires: now + SESSION_DAYS * 864e5 });
  save();
  return token;
}

function destroySession(token) {
  const h = sha256(token);
  db.sessions = db.sessions.filter((s) => s.hash !== h);
  save();
}

function userFromToken(token) {
  if (!token) return null;
  const h = sha256(token);
  const s = db.sessions.find((x) => x.hash === h && x.expires > Date.now());
  return s ? db.users.find((u) => u.id === s.userId) || null : null;
}

function dropUserSessions(userId) {
  db.sessions = db.sessions.filter((s) => s.userId !== userId);
}

// ログイン総当たり対策: 5回失敗で5分ロック
const attempts = new Map();
const LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;

function isLocked(key) {
  const a = attempts.get(key);
  return !!a && a.count >= LIMIT && a.until > Date.now();
}
function recordFailure(key) {
  const a = attempts.get(key);
  const c = a && a.until > Date.now() ? a.count + 1 : 1;
  attempts.set(key, { count: c, until: Date.now() + LOCK_MS });
}
function clearFailures(key) {
  attempts.delete(key);
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, userFromToken,
  dropUserSessions, isLocked, recordFailure, clearFailures,
};
