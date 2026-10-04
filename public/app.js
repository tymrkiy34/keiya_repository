'use strict';
/* スマイル情報共有 - フロントエンド（依存なし） */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const COLORS = ['#0e8a99', '#6c5ce7', '#e17055', '#2f9d6e', '#d6336c', '#c98a0b', '#3a78d1'];
const ALLOWED_EXT = /\.(pdf|png|jpe?g|gif|webp|txt|csv|docx?|xlsx?|pptx?|zip)$/i;
const MAX_FILE = 10 * 1024 * 1024;

function avatar(name, cls = '') {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${cls}" style="--c:${COLORS[h % COLORS.length]}" title="${esc(name)}">${esc([...String(name)][0] || '?')}</span>`;
}
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
function fmtWhen(iso) {
  const d = new Date(iso);
  if (ymd(d) === ymd(new Date())) return `今日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const evTime = (e) => (e.allDay ? '終日' : e.start + (e.end ? `–${e.end}` : ''));
const evSort = (a, b) => (a.allDay === b.allDay ? (a.start || '').localeCompare(b.start || '') : a.allDay ? -1 : 1);

// ---------- state ----------
const state = {
  ready: false, user: null, needsSetup: false, meta: null,
  users: [], posts: [], events: [], lab: [], items: [], stockLogs: [],
  filter: 'すべて', q: '',
  ui: { lab: { f: 'all', q: '', done: false }, inv: { loc: 'すべて', f: 'すべて', q: '' } },
  cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: ymd(new Date()) },
};

async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) {
    opt.body = raw.data;
    opt.headers['X-Filename'] = encodeURIComponent(raw.name);
    opt.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && state.user && url !== '/api/login') {
    state.user = null;
    render();
    throw new Error('セッションの期限が切れました。もう一度ログインしてください');
  }
  if (!r.ok) throw new Error(j.error || 'エラーが発生しました');
  return j;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.innerHTML = (err ? '' : icon('check', 'sm')) + esc(msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2800);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

async function refreshData() {
  const [users, posts, events, lab, inv] = await Promise.all([
    api('GET', '/api/users'), api('GET', '/api/posts'), api('GET', '/api/events'), api('GET', '/api/lab'), api('GET', '/api/inventory')]);
  Object.assign(state, { users, posts, events, lab, items: inv.items, stockLogs: inv.logs });
}

async function boot() {
  const st = await fetch('/api/status').then((r) => r.json());
  state.needsSetup = st.needsSetup;
  if (st.loggedIn) await enter(); else { state.ready = true; render(); }
}
async function enter() {
  const [me, meta] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/meta')]);
  state.user = me;
  state.meta = meta;
  await refreshData();
  state.ready = true;
  if (!location.hash) location.hash = '#/home';
  render();
}

// ---------- derived ----------
const isAdmin = () => state.user.role === 'admin';
const canModify = (item) => isAdmin() || item.authorId === state.user.id;
const isUnread = (p) => !p.readBy.includes(state.user.id);
const unreadCount = () => state.posts.filter(isUnread).length;
const eventsOn = (date) => state.events.filter((e) => e.date <= date && e.endDate >= date).sort(evSort);
const userName = (id) => (state.users.find((u) => u.id === id) || { name: '（退職）' }).name;

// ---------- views ----------
const route = () => (location.hash.replace('#/', '') || 'home').split('?')[0];

function render() {
  const app = $('#app');
  const y = window.scrollY;
  if (!state.ready) return;
  app.innerHTML = state.user ? shell() : authView();
  window.scrollTo(0, y);
}

function authView() {
  const setup = state.needsSetup;
  return `<div class="auth">
    <section class="auth-hero">
      <div class="brand"><span class="brand-mark">${icon('tooth')}</span><span>スマイル情報共有</span></div>
      <div>
        <h2>院内の連絡を、<br>ひとつの場所に。</h2>
        <p class="lead">お知らせ・申し送り・スケジュールをスタッフ全員でスムーズに共有できます。</p>
        <ul class="feature-list">
          <li><span class="dot">${icon('board', 'sm')}</span>掲示板で既読まで一目で確認</li>
          <li><span class="dot">${icon('cal', 'sm')}</span>診療・休診・研修をカレンダーで共有</li>
          <li><span class="dot">${icon('bell', 'sm')}</span>重要な連絡はLINE・メールでお知らせ</li>
        </ul>
      </div>
      <small style="opacity:.7">© スマイル情報共有</small>
    </section>
    <section class="auth-panel">
      <form class="auth-card" data-form="${setup ? 'setup' : 'login'}">
        <div class="auth-brand-mobile"><span class="brand-mark">${icon('tooth')}</span>スマイル情報共有</div>
        <div><h1>${setup ? '初期設定' : 'ログイン'}</h1>
          <p class="sub">${setup ? '最初に管理者アカウントを作成します。' : 'ログインIDとパスワードを入力してください。'}</p></div>
        <div class="form-error" hidden></div>
        ${setup ? `<div class="field"><label for="a-name">お名前</label><input class="input" id="a-name" name="name" required maxlength="30" placeholder="例: 山田 太郎" autocomplete="name"></div>` : ''}
        <div class="field"><label for="a-id">ログインID</label><input class="input" id="a-id" name="loginId" required autocomplete="username" autocapitalize="none" placeholder="半角英数字" ${setup ? '' : 'autofocus'}></div>
        <div class="field"><label for="a-pw">パスワード</label><input class="input" id="a-pw" name="password" type="password" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}">${setup ? '<span class="hint">8文字以上</span>' : ''}</div>
        ${setup ? `<div class="field"><label for="a-mail">メールアドレス（任意）</label><input class="input" id="a-mail" name="email" type="email" autocomplete="email"></div>` : ''}
        <button class="btn primary" style="min-height:48px;font-size:15px">${setup ? 'アカウントを作成して開始' : 'ログイン'}</button>
        ${setup ? '' : '<p class="hint" style="text-align:center">アカウントをお持ちでない場合は、管理者に発行を依頼してください。</p>'}
      </form>
    </section>
  </div>`;
}

function shell() {
  const r = route();
  const unread = unreadCount();
  const needN = state.items.filter(needsOrder).length;
  const items = [
    ['home', 'home', 'ホーム'], ['board', 'board', '掲示板'], ['calendar', 'cal', 'カレンダー'],
    ['lab', 'flask', '技工物'], ['inventory', 'box', '在庫'],
    ...(isAdmin() ? [['staff', 'users', 'スタッフ']] : []), ['settings', 'gear', '設定'],
  ];
  const link = (it) => `<a href="#/${it[0]}" ${r === it[0] ? 'aria-current="page"' : ''}>${icon(it[1])}<span>${it[2]}</span>${it[0] === 'board' && unread ? `<span class="badge">${unread}</span>` : ''}${it[0] === 'inventory' && needN ? `<span class="badge">${needN}</span>` : ''}</a>`;
  const views = { home: homeView, board: boardView, calendar: calendarView, lab: labView, inventory: inventoryView, staff: staffView, settings: settingsView };
  const tabItems = items.filter((it) => it[0] !== 'staff' && it[0] !== 'settings');
  const body = (views[r] && (r !== 'staff' || isAdmin()) ? views[r] : homeView)();
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">${icon('tooth')}</span><span>スマイル情報共有<small>CLINIC SHARE</small></span></div>
      <nav class="nav" aria-label="メイン">${items.map(link).join('')}</nav>
      <div class="sidebar-foot">
        <div class="me">${avatar(state.user.name)}<div class="who"><b>${esc(state.user.name)}</b><span>${isAdmin() ? '管理者' : 'スタッフ'}</span></div>
          <button class="btn ghost icon-btn" data-act="logout" title="ログアウト" aria-label="ログアウト">${icon('out')}</button></div>
      </div>
    </aside>
    <main class="main ${r === 'lab' ? 'wide' : ''}" id="main">
      <div class="mobile-top"><div class="brand" style="color:var(--brand-600)"><span class="brand-mark" style="background:var(--brand);color:#fff;width:34px;height:34px">${icon('tooth', 'sm')}</span>スマイル情報共有</div>
        <span><a class="btn ghost icon-btn" href="#/settings" aria-label="設定">${icon('gear')}</a><button class="btn ghost icon-btn" data-act="logout" aria-label="ログアウト">${icon('out')}</button></span></div>
      ${body}
    </main>
    <nav class="tabbar" style="grid-template-columns:repeat(${tabItems.length},1fr)" aria-label="メイン">${tabItems.map(link).join('')}</nav>
  </div>`;
}

// --- Home ---
function homeView() {
  const now = new Date();
  const today = ymd(now);
  const weekEnd = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6));
  const todayEv = eventsOn(today);
  const upcoming = state.events
    .filter((e) => e.endDate >= today && e.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || evSort(a, b)).slice(0, 6);
  const unreadPosts = state.posts.filter(isUnread);
  const feed = (unreadPosts.length ? unreadPosts : state.posts).slice().sort((a, b) => (b.priority !== '通常') - (a.priority !== '通常') || b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const labSoon = labActive().sort((a, b) => a.dueDate.localeCompare(b.dueDate) || Number(b.urgent) - Number(a.urgent));
  const labNear = labSoon.filter((o) => daysUntil(o.dueDate) <= 1).length;
  const orders = state.items.filter(needsOrder);
  const hour = now.getHours();
  const greet = hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'お疲れさまです';
  return `
    <section class="hero">
      <div class="date">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${WD[now.getDay()]}）</div>
      <h1>${greet}、${esc(state.user.name)}さん</h1>
      <div class="stats four">
        <a class="stat" href="#/board" data-act="goto-unread"><b>${unreadPosts.length}</b><span>未読のお知らせ</span></a>
        <a class="stat" href="#/calendar" data-act="goto-today"><b>${todayEv.length}</b><span>今日の予定</span></a>
        <a class="stat" href="#/lab"><b>${labNear}</b><span>納期が近い技工物</span></a>
        <a class="stat" href="#/inventory"><b>${orders.length}</b><span>要発注の在庫</span></a>
      </div>
    </section>
    <div class="cols">
      <div>
        <div class="section-title"><h2>直近の予定</h2><a href="#/calendar">カレンダーを開く</a></div>
        <div class="card list">${upcoming.length ? upcoming.map(eventRow).join('') : `<div class="empty">${icon('cal')}<div>今後7日間の予定はありません</div></div>`}</div>
      </div>
      <div>
        <div class="section-title"><h2>${unreadPosts.length ? '未読のお知らせ' : '最新のお知らせ'}</h2><a href="#/board">掲示板を開く</a></div>
        <div class="card list">${feed.length ? feed.map(feedRow).join('') : `<div class="empty">${icon('board')}<div>お知らせはまだありません</div></div>`}</div>
      </div>
      <div>
        <div class="section-title"><h2>技工物の納期</h2><a href="#/lab">技工物を開く</a></div>
        <div class="card list">${labSoon.length ? labSoon.slice(0, 5).map(labRow).join('') : `<div class="empty">${icon('flask')}<div>進行中の技工物はありません</div></div>`}</div>
      </div>
      <div>
        <div class="section-title"><h2>要発注の在庫</h2><a href="#/inventory">在庫を開く</a></div>
        <div class="card list">${orders.length ? orders.slice(0, 5).map(orderRow).join('') : `<div class="empty">${icon('box')}<div>発注が必要な品目はありません</div></div>`}</div>
      </div>
    </div>`;
}
function labRow(o) {
  const d = parseYmd(o.dueDate), di = dueInfo(o.dueDate);
  return `<a class="list-item" href="#/lab">
    <div class="datebox ${di.c === 'od' ? 'late' : di.c === 'soon' ? 'today' : ''}"><b>${d.getDate()}</b><span>${d.getMonth() + 1}月</span></div>
    <div class="li-main"><b>${esc(o.type)} ・ ${esc(o.patientRef)}</b><span>${esc(o.status)} ・ ${o.lab ? esc(o.lab) : '院内'} ・ ${di.t}</span></div>${o.urgent ? '<span class="pill urgent">急ぎ</span>' : ''}
  </a>`;
}
function orderRow(i) {
  return `<a class="list-item" href="#/inventory">
    <div class="datebox ${i.qty <= 0 ? 'late' : ''}"><b>${i.qty}</b><span>${esc(i.unit)}</span></div>
    <div class="li-main"><b>${esc(i.name)}</b><span>${esc(i.location)}${i.supplier ? ` ・ ${esc(i.supplier)}` : ''}</span></div><span class="pill ${i.qty <= 0 ? 'urgent' : 'warn'}">${i.qty <= 0 ? '在庫切れ' : '要発注'}</span>
  </a>`;
}
function eventRow(e) {
  const d = parseYmd(e.date);
  const isToday = e.date <= ymd(new Date()) && e.endDate >= ymd(new Date());
  return `<a class="list-item" href="#/calendar" data-act="goto-date" data-date="${e.date}">
    <div class="datebox ${isToday ? 'today' : ''}"><b>${d.getDate()}</b><span>${WD[d.getDay()]}</span></div>
    <div class="li-main"><b>${esc(e.title)}</b><span>${evTime(e)} ・ ${esc(e.type)}</span></div>
  </a>`;
}
function feedRow(p) {
  const pr = p.priority === '緊急' ? '<span class="pill urgent">緊急</span>' : p.priority === '重要' ? '<span class="pill warn">重要</span>' : `<span class="pill">${esc(p.category)}</span>`;
  return `<a class="list-item" href="#/board" data-act="goto-post" data-id="${p.id}">
    ${avatar(p.author)}<div class="li-main"><b>${esc(p.title)}</b><span>${esc(p.author)} ・ ${fmtWhen(p.createdAt)}${isUnread(p) ? ' ・ <b style="display:inline;color:var(--brand-600)">未読</b>' : ''}</span></div>${pr}
  </a>`;
}

// --- Board ---
function boardView() {
  const chips = ['すべて', '未読', ...state.meta.categories];
  return `
    <div class="page-head"><div><h1>掲示板</h1><p class="sub">お知らせ・申し送り・マニュアルなどを共有します</p></div>
      <div class="head-actions"><button class="btn primary" data-act="new-post">${icon('plus', 'sm')}新規投稿</button></div></div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="絞り込み">${chips.map((c) => `<button class="chip" data-act="filter" data-v="${esc(c)}" aria-pressed="${state.filter === c}">${esc(c)}${c === '未読' && unreadCount() ? ` ${unreadCount()}` : ''}</button>`).join('')}</div>
      <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="キーワードで検索" value="${esc(state.q)}" aria-label="検索"></div>
    </div>
    <div class="posts" id="posts">${postsHtml()}</div>`;
}
function postsHtml() {
  const q = state.q.trim().toLowerCase();
  const list = state.posts
    .filter((p) => (state.filter === 'すべて' ? true : state.filter === '未読' ? isUnread(p) : p.category === state.filter))
    .filter((p) => !q || (p.title + p.body + p.author).toLowerCase().includes(q))
    .sort((a, b) => (b.pinned - a.pinned) || b.createdAt.localeCompare(a.createdAt));
  if (!list.length) return `<div class="card empty">${icon('board')}<div>${state.filter === '未読' ? '未読のお知らせはありません 🎉' : '該当する投稿はありません'}</div></div>`;
  return list.map(postCard).join('');
}
function postCard(p) {
  const unread = isUnread(p);
  const pri = p.priority === '緊急' ? '<span class="pill urgent">緊急</span>' : p.priority === '重要' ? '<span class="pill warn">重要</span>' : '';
  const readers = p.readBy.map((id) => state.users.find((u) => u.id === id)).filter(Boolean);
  return `<article class="card post p-${esc(p.priority)} ${unread ? 'unread' : ''}" id="post-${p.id}">
    <div class="post-meta">${p.pinned ? `<span class="pill brand">${icon('pin', 'sm')}ピン留め</span>` : ''}${pri}<span class="pill">${esc(p.category)}</span>${unread ? '<span class="pill brand">未読</span>' : ''}</div>
    <h3>${esc(p.title)}</h3>
    ${p.body ? `<div class="text">${esc(p.body)}</div>` : ''}
    ${filesHtml(p.files, canModify(p))}
    <div class="post-foot">
      <div class="by">${avatar(p.author, 'xs')}${esc(p.author)}<span class="hint" style="font-weight:400">${fmtWhen(p.createdAt)}</span></div>
      <div class="readers"><div class="stack">${readers.slice(0, 5).map((u) => avatar(u.name, 'xs')).join('')}</div><span>既読 ${readers.length}/${state.users.length}</span></div>
      <div class="post-actions">
        ${unread ? `<button class="btn primary sm" data-act="read" data-id="${p.id}">${icon('check', 'sm')}既読にする</button>` : ''}
        <button class="btn ghost sm" data-act="pin" data-id="${p.id}">${icon('pin', 'sm')}${p.pinned ? 'ピン解除' : 'ピン留め'}</button>
        ${canModify(p) ? `<button class="btn ghost sm danger" data-act="del-post" data-id="${p.id}">${icon('trash', 'sm')}削除</button>` : ''}
      </div>
    </div>
  </article>`;
}
function filesHtml(files, removable) {
  if (!files || !files.length) return '';
  return `<div class="files">${files.map((f) => `<span class="file">${icon('file', 'sm')}<a class="name" href="/api/files/${f.id}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${esc(f.name)}</a><small>${fmtSize(f.size)}</small>${removable ? `<button type="button" class="x" data-act="del-file" data-id="${f.id}" aria-label="${esc(f.name)}を削除">${icon('x', 'sm')}</button>` : ''}</span>`).join('')}</div>`;
}

// --- Calendar ---
function calendarView() {
  const { y, m, sel } = state.cal;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
  const today = ymd(new Date());
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = ymd(d);
    const evs = eventsOn(key);
    cells += `<button class="cal-day ${d.getMonth() !== m ? 'out' : ''} ${key === today ? 'today' : ''}" data-act="cal-sel" data-date="${key}" aria-selected="${key === sel}" aria-label="${d.getMonth() + 1}月${d.getDate()}日 予定${evs.length}件">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map((e) => `<span class="ev t-${esc(e.type)}">${e.allDay ? '' : `<span class="t">${esc(e.start)} </span>`}${esc(e.title)}</span>`).join('')}
      ${evs.length > 3 ? `<span class="more">他${evs.length - 3}件</span>` : ''}
    </button>`;
  }
  return `
    <div class="page-head"><div><h1>カレンダー</h1><p class="sub">診療・休診・会議などの予定を共有します</p></div>
      <div class="head-actions"><button class="btn primary" data-act="new-event" data-date="${sel}">${icon('plus', 'sm')}予定を追加</button></div></div>
    <div class="cal-bar">
      <button class="btn icon-btn" data-act="cal-prev" aria-label="前の月">${icon('left')}</button>
      <button class="btn icon-btn" data-act="cal-next" aria-label="次の月">${icon('right')}</button>
      <h2>${y}年${m + 1}月</h2>
      <button class="btn sm" data-act="cal-today">今日</button>
      <div class="legend">${state.meta.eventTypes.map((t) => `<span><i style="background:var(--ev-${{ 診療: 'clinic', 休診: 'closed', '会議・研修': 'meeting', その他: 'other' }[t]})"></i>${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="card cal"><div class="cal-head">${WD.map((w) => `<div>${w}</div>`).join('')}</div><div class="cal-grid">${cells}</div></div>
    <div class="day-panel">${dayPanel()}</div>`;
}
function dayPanel() {
  const sel = state.cal.sel;
  const d = parseYmd(sel);
  const evs = eventsOn(sel);
  return `<div class="section-title"><h2>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）の予定</h2>
    <button class="btn sm" data-act="new-event" data-date="${sel}">${icon('plus', 'sm')}この日に追加</button></div>
    <div class="card list">${evs.length ? evs.map((e) => `<div class="list-item" data-act="open-event" data-id="${e.id}" tabindex="0" role="button">
      <div class="datebox" style="width:64px"><b style="font-size:13px">${esc(e.allDay ? '終日' : e.start)}</b><span>${esc(e.allDay ? '' : e.end ? '〜' + e.end : '')}</span></div>
      <div class="li-main"><b>${esc(e.title)}</b><span>${esc(e.type)} ・ ${esc(e.author)}${e.files.length ? ` ・ 添付${e.files.length}件` : ''}</span></div>
      ${e.type === '休診' ? '<span class="pill urgent">休診</span>' : ''}
    </div>`).join('') : `<div class="empty">${icon('cal')}<div>この日の予定はありません</div></div>`}</div>`;
}

// --- Lab (技工物) ---
const todayStr = () => ymd(new Date());
const daysUntil = (d) => Math.round((parseYmd(d) - parseYmd(todayStr())) / 864e5);
const md = (d) => { const x = parseYmd(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
function dueInfo(d) {
  const n = daysUntil(d);
  if (n < 0) return { t: `${-n}日超過`, c: 'od' };
  if (n === 0) return { t: '今日', c: 'soon' };
  if (n === 1) return { t: '明日', c: 'soon' };
  return { t: `あと${n}日`, c: '' };
}
const labActive = () => state.lab.filter((o) => o.status !== 'セット済');
const lastAt = (o) => (o.history[o.history.length - 1] || {}).at || o.createdAt;

function labView() {
  const active = labActive();
  const overdue = active.filter((o) => daysUntil(o.dueDate) < 0).length;
  const soon = active.filter((o) => { const n = daysUntil(o.dueDate); return n >= 0 && n <= 1; }).length;
  const cnt = (s) => state.lab.filter((o) => o.status === s).length;
  const tile = (label, n, cls = '') => `<div class="sum-tile ${n ? cls : ''}"><b>${n}</b><span>${label}</span></div>`;
  const f = state.ui.lab;
  const chips = [['all', 'すべて'], ['mine', '自分の担当'], ['in', '院内製作'], ['out', '外注'], ['urgent', '急ぎ']];
  return `
    <div class="page-head"><div><h1>技工物管理</h1><p class="sub">依頼から納品・セットまでの進み具合を共有します</p></div>
      <div class="head-actions"><button class="btn primary" data-act="new-lab">${icon('plus', 'sm')}新規依頼</button></div></div>
    <div class="lab-sum">${tile('納期超過', overdue, 'urgent')}${tile('今日・明日が納期', soon, 'warn')}${tile('製作中', cnt('製作中'))}${tile('完成（セット待ち）', cnt('完成'))}</div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="絞り込み">${chips.map(([v, l]) => `<button class="chip" data-act="lab-filter" data-v="${v}" aria-pressed="${f.f === v}">${l}</button>`).join('')}
        <button class="chip" data-act="lab-done" aria-pressed="${f.done}">セット済も表示</button></div>
      <div class="search">${icon('search')}<input class="input" id="lab-q" type="search" placeholder="患者番号・種類・依頼医" value="${esc(f.q)}" aria-label="検索"></div>
    </div>
    <div id="lab-board">${labBoard()}</div>`;
}
function labFiltered() {
  const { f, q } = state.ui.lab;
  const k = q.trim().toLowerCase();
  return state.lab
    .filter((o) => (f === 'all' ? true : f === 'mine' ? o.assigneeId === state.user.id : f === 'in' ? !o.lab : f === 'out' ? !!o.lab : o.urgent))
    .filter((o) => !k || [o.no, o.patientRef, o.doctor, o.type, o.teeth, o.lab, o.material].join(' ').toLowerCase().includes(k));
}
function labBoard() {
  const list = labFiltered();
  const cols = state.meta.labStatuses.filter((s) => s !== 'セット済' || state.ui.lab.done);
  return `<div class="kanban" style="--cols:${cols.length}">${cols.map((s) => {
    let items = list.filter((o) => o.status === s);
    items = s === 'セット済'
      ? items.sort((a, b) => lastAt(b).localeCompare(lastAt(a))).slice(0, 20)
      : items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || Number(b.urgent) - Number(a.urgent));
    return `<section class="col" data-s="${s}" aria-label="${s}"><div class="col-head"><i></i>${s}<span>${items.length}</span></div>
      ${items.length ? items.map(labCard).join('') : '<div class="col-empty">なし</div>'}</section>`;
  }).join('')}</div>`;
}
function labCard(o) {
  const done = o.status === 'セット済';
  const di = dueInfo(o.dueDate);
  const who = o.lab ? `外注: ${o.lab}` : o.assigneeId ? userName(o.assigneeId) : '担当未定';
  return `<div class="lab-card ${!done && di.c === 'od' ? 'od' : ''}" data-act="open-lab" data-id="${o.id}" role="button" tabindex="0">
    <div class="lab-top"><span>${esc(o.no)}</span>${o.urgent ? '<span class="pill urgent">急ぎ</span>' : ''}${o.remakeCount ? `<span class="pill warn">再製作${o.remakeCount}</span>` : ''}</div>
    <div class="lab-type">${esc(o.type)}</div>
    <div class="lab-sub">${esc([o.teeth, o.material, o.shade].filter(Boolean).join(' ・ '))}</div>
    <div class="lab-meta">患者 ${esc(o.patientRef)}${o.doctor ? ` ・ ${esc(o.doctor)}` : ''}</div>
    <div class="lab-foot">${done ? `<span>セット済 ${md(lastAt(o).slice(0, 10))}</span>` : `<span class="due ${di.c}">納期 ${md(o.dueDate)} ${di.t}</span>`}<span>${esc(who)}</span></div>
  </div>`;
}

// --- Inventory (在庫) ---
function itemState(i) {
  if (i.expiry && i.expiry < todayStr()) return 'expired';
  if (i.qty <= 0) return 'out';
  if (i.reorderPoint > 0 && i.qty <= i.reorderPoint) return 'low';
  if (i.expiry && daysUntil(i.expiry) <= 30) return 'expiring';
  return 'ok';
}
const needsOrder = (i) => !i.orderedAt && (i.qty <= 0 || (i.reorderPoint > 0 && i.qty <= i.reorderPoint));
const expiringItem = (i) => ['expired', 'expiring'].includes(itemState(i));
const STATE_RANK = { out: 0, expired: 0, low: 1, expiring: 2, ok: 3 };

function inventoryView() {
  const v = state.ui.inv;
  const locs = ['すべて', ...state.meta.locations.filter((l) => state.items.some((i) => i.location === l) || l === v.loc || l !== 'その他')];
  const need = state.items.filter(needsOrder).length;
  const count = (l) => (l === 'すべて' ? state.items : state.items.filter((i) => i.location === l)).length;
  const fl = [['すべて', 'すべて'], ['要発注', `要発注${need ? ' ' + need : ''}`], ['期限間近', '期限間近'], ['発注済', '発注済（入荷待ち）']];
  return `
    <div class="page-head"><div><h1>在庫管理</h1><p class="sub">技工室・チェアサイドの在庫を、使った分・入れた分だけ記録します</p></div>
      <div class="head-actions"><button class="btn" data-act="order-list">${icon('clip2', 'sm')}発注リスト${need ? `（${need}）` : ''}</button>
        <button class="btn primary" data-act="new-item">${icon('plus', 'sm')}品目を追加</button></div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="置き場所">${locs.map((l) => `<button data-act="inv-loc" data-v="${esc(l)}" aria-pressed="${v.loc === l}">${esc(l)} ${count(l)}</button>`).join('')}</div></div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="絞り込み">${fl.map(([k, l]) => `<button class="chip" data-act="inv-filter" data-v="${k}" aria-pressed="${v.f === k}">${l}</button>`).join('')}</div>
      <div class="search">${icon('search')}<input class="input" id="inv-q" type="search" placeholder="品名・仕入先" value="${esc(v.q)}" aria-label="検索"></div>
    </div>
    <div class="card stock-list" id="inv-list">${invList()}</div>`;
}
function invList() {
  const { loc, f, q } = state.ui.inv;
  const k = q.trim().toLowerCase();
  const list = state.items
    .filter((i) => loc === 'すべて' || i.location === loc)
    .filter((i) => (f === '要発注' ? needsOrder(i) : f === '期限間近' ? expiringItem(i) : f === '発注済' ? !!i.orderedAt : true))
    .filter((i) => !k || [i.name, i.supplier, i.category].join(' ').toLowerCase().includes(k))
    .sort((a, b) => STATE_RANK[itemState(a)] - STATE_RANK[itemState(b)] || a.location.localeCompare(b.location, 'ja') || a.name.localeCompare(b.name, 'ja'));
  if (!list.length) return `<div class="empty">${icon('box')}<div>${state.items.length ? '該当する品目はありません' : '品目がまだありません。「品目を追加」から登録してください'}</div></div>`;
  return list.map(stockRow).join('');
}
function statePill(i) {
  const s = itemState(i);
  if (s === 'expired') return '<span class="pill urgent">期限切れ</span>';
  if (s === 'out') return i.orderedAt ? `<span class="pill brand">発注済 ${md(i.orderedAt)}</span>` : '<span class="pill urgent">在庫切れ</span>';
  if (s === 'low') return i.orderedAt ? `<span class="pill brand">発注済 ${md(i.orderedAt)}</span>` : '<span class="pill warn">要発注</span>';
  if (s === 'expiring') return `<span class="pill warn">期限 ${md(i.expiry)}</span>`;
  return i.orderedAt ? `<span class="pill brand">発注済 ${md(i.orderedAt)}</span>` : '<span class="pill ok">十分</span>';
}
function stockRow(i) {
  const s = itemState(i);
  const max = i.target > 0 ? i.target : i.reorderPoint > 0 ? i.reorderPoint * 3 : Math.max(i.qty, 1);
  const pct = Math.max(i.qty > 0 ? 4 : 0, Math.min(100, (i.qty / max) * 100));
  return `<div class="stock s-${s}">
    <div class="stock-main" data-act="open-item" data-id="${i.id}" role="button" tabindex="0" aria-label="${esc(i.name)}の詳細">
      <b>${esc(i.name)}</b>
      <span class="sub"><span class="pill">${esc(i.location)}</span>${esc(i.category)}${i.supplier ? ` ・ ${esc(i.supplier)}` : ''}${i.reorderPoint ? ` ・ 発注点 ${i.reorderPoint}${esc(i.unit)}` : ''}</span>
      <div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div>
    </div>
    <div class="stepper"><button type="button" data-act="stock-use" data-id="${i.id}" aria-label="${esc(i.name)}を1${esc(i.unit)}使う" ${i.qty <= 0 ? 'disabled' : ''}>${icon('minus', 'sm')}</button>
      <div class="qty"><b>${i.qty}</b><span>${esc(i.unit)}</span></div>
      <button type="button" data-act="stock-in" data-id="${i.id}" aria-label="${esc(i.name)}を1${esc(i.unit)}入庫">${icon('plus', 'sm')}</button></div>
    ${statePill(i)}
  </div>`;
}

// --- Staff ---
function staffView() {
  return `
    <div class="page-head"><div><h1>スタッフ管理</h1><p class="sub">アカウントの発行・権限・パスワードの再設定</p></div>
      <div class="head-actions"><button class="btn primary" data-act="new-user">${icon('plus', 'sm')}スタッフを追加</button></div></div>
    <div class="card" style="overflow:auto"><table class="table">
      <thead><tr><th>名前</th><th class="hide-sm">職種</th><th>ログインID</th><th class="hide-sm">メール</th><th>権限</th><th></th></tr></thead>
      <tbody>${state.users.map((u) => `<tr>
        <td><div class="who">${avatar(u.name)}${esc(u.name)}${u.id === state.user.id ? '<span class="pill brand">あなた</span>' : ''}</div></td>
        <td class="hide-sm">${esc(u.jobTitle || '—')}</td><td>${esc(u.loginId)}</td><td class="hide-sm">${esc(u.email || '—')}</td>
        <td><span class="pill ${u.role === 'admin' ? 'brand' : ''}">${u.role === 'admin' ? '管理者' : 'スタッフ'}</span></td>
        <td class="acts"><button class="btn ghost sm" data-act="edit-user" data-id="${u.id}">${icon('edit', 'sm')}編集</button>
          ${u.id !== state.user.id ? `<button class="btn ghost sm danger" data-act="del-user" data-id="${u.id}" aria-label="${esc(u.name)}を削除">${icon('trash', 'sm')}</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

// --- Settings ---
function settingsView() {
  const u = state.user;
  const ch = state.meta.channels;
  const chRow = (ic, name, desc, on) => `<div class="channel"><span class="ci">${icon(ic)}</span><div><b>${name}</b><span>${desc}</span></div><span class="pill ${on ? 'brand' : ''}">${on ? '有効' : '未設定'}</span></div>`;
  return `
    <div class="page-head"><div><h1>設定</h1><p class="sub">プロフィール・パスワード・通知</p></div></div>
    <div class="setting-grid">
      <form class="card card-pad stack-form" data-form="profile">
        <h2>プロフィール</h2>
        <div class="me" style="background:none;border:0;padding:0">${avatar(u.name)}<div class="who"><b>${esc(u.name)}</b><span>ID: ${esc(u.loginId)} ・ ${esc(u.jobTitle || '職種未設定')} ・ ${u.role === 'admin' ? '管理者' : 'スタッフ'}</span></div></div>
        <div class="field"><label for="p-mail">メールアドレス</label><input class="input" id="p-mail" name="email" type="email" value="${esc(u.email)}" placeholder="name@example.com"><span class="hint">通知メールの送信先になります</span></div>
        <label class="check"><input type="checkbox" name="notifyEmail" ${u.notifyEmail ? 'checked' : ''}><span>メールで通知を受け取る</span></label>
        <div><button class="btn primary">保存する</button></div>
      </form>
      <form class="card card-pad stack-form" data-form="password">
        <h2>パスワード変更</h2>
        <div class="form-error" hidden></div>
        <div class="field"><label for="pw0">現在のパスワード</label><input class="input" id="pw0" name="currentPassword" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="pw1">新しいパスワード</label><input class="input" id="pw1" name="newPassword" type="password" required minlength="8" autocomplete="new-password"><span class="hint">8文字以上</span></div>
        <div><button class="btn primary">変更する</button></div>
      </form>
      <div class="card card-pad" style="grid-column:1/-1">
        <h2>通知チャネル</h2>
        ${chRow('chat', 'LINE', 'LINE公式アカウント（Messaging API）で配信', ch.line)}
        ${chRow('mail', 'メール', 'メールアドレスを登録したスタッフへ送信', ch.email)}
        <p class="hint" style="margin-top:10px">${isAdmin() ? '通知の接続設定はサーバーの環境変数で行います（READMEの「通知の設定」を参照）。' : '通知の設定は管理者が行います。'}</p>
        ${isAdmin() && (ch.line || ch.email) ? '<div style="margin-top:12px"><button class="btn" data-act="test-notify">' + icon('bell', 'sm') + 'テスト通知を送信</button></div>' : ''}
      </div>
    </div>
    ${isAdmin() ? `<div style="margin-top:20px"><a class="btn" href="#/staff">${icon('users', 'sm')}スタッフ管理を開く</a></div>` : ''}
    <div style="margin-top:20px"><button class="btn danger" data-act="logout">${icon('out', 'sm')}ログアウト</button></div>`;
}

// ---------- modal / file picker ----------
function openModal(title, bodyHtml, footHtml) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form class="modal" method="dialog" novalidate>
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost icon-btn" data-close aria-label="閉じる">${icon('x')}</button></div>
    <div class="modal-body">${bodyHtml}</div><div class="modal-foot">${footHtml}</div></form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  dlg.showModal();
  return dlg;
}

function filePicker(host) {
  const files = [];
  host.innerHTML = `<div class="drop" tabindex="0" role="button">${icon('clip', 'sm')} ファイルを選択、またはここにドロップ<div class="hint">PDF・画像・Office文書・txt/csv・zip ／ 1ファイル10MBまで</div></div>
    <input type="file" multiple hidden><div class="files"></div>`;
  const drop = $('.drop', host), input = $('input', host), list = $('.files', host);
  const paint = () => {
    list.innerHTML = files.map((f, i) => `<span class="file">${icon('file', 'sm')}<span class="name">${esc(f.name)}</span><small>${fmtSize(f.size)}</small><button type="button" class="x" data-i="${i}" aria-label="取り消し">${icon('x', 'sm')}</button></span>`).join('');
  };
  const add = (fl) => {
    for (const f of fl) {
      if (!ALLOWED_EXT.test(f.name)) toast(`${f.name}: 対応していない形式です`, true);
      else if (f.size > MAX_FILE) toast(`${f.name}: 10MBを超えています`, true);
      else if (f.size === 0) toast(`${f.name}: 空のファイルです`, true);
      else files.push(f);
    }
    paint();
  };
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  ['dragover', 'dragenter'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((n) => drop.addEventListener(n, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); add(e.dataTransfer.files); });
  list.addEventListener('click', (e) => { const b = e.target.closest('.x'); if (b) { files.splice(Number(b.dataset.i), 1); paint(); } });
  return files;
}

async function uploadAll(kind, id, files) {
  const failed = [];
  for (const f of files) {
    try { await api('POST', `/api/${kind}/${id}/files`, undefined, { name: f.name, data: f }); } catch (e) { failed.push(`${f.name}（${e.message}）`); }
  }
  if (failed.length) toast(`添付に失敗: ${failed.join('、')}`, true);
}

function notifyBox(defaultOn, label) {
  const ch = state.meta.channels;
  const names = [ch.line && 'LINE', ch.email && 'メール'].filter(Boolean).join('・');
  if (!names) return `<div class="notify-box"><label class="check"><input type="checkbox" disabled><span>${label}</span></label><div class="hint" style="margin:4px 0 0 28px">通知先が未設定です（設定画面で確認できます）</div></div>`;
  return `<div class="notify-box"><label class="check"><input type="checkbox" name="notify" ${defaultOn ? 'checked' : ''}><span>${label}<br><span class="hint">${names}で全スタッフへ送信されます</span></span></label></div>`;
}
const opts = (arr, sel) => arr.map((v) => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');

// ---------- dialogs ----------
function postDialog() {
  const dlg = openModal('新規投稿', `
    <div class="field"><label for="n-title">タイトル</label><input class="input" id="n-title" name="title" required maxlength="100" placeholder="例: 来週の院内勉強会について"></div>
    <div class="row two">
      <div class="field"><label for="n-cat">カテゴリ</label><select class="input" id="n-cat" name="category">${opts(state.meta.categories)}</select></div>
      <div class="field"><label for="n-pri">優先度</label><select class="input" id="n-pri" name="priority">${opts(state.meta.priorities)}</select></div>
    </div>
    <div class="field"><label for="n-body">内容</label><textarea class="input" id="n-body" name="body" maxlength="5000" placeholder="連絡内容を入力"></textarea></div>
    <div class="field"><span class="lbl">添付ファイル</span><div id="n-files"></div></div>
    ${notifyBox(false, '投稿をLINE・メールで通知する')}
    <div class="warn-note">患者さまの氏名など個人を特定できる情報は書かないでください（イニシャルや患者番号を使用）。</div>`,
    `<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${icon('check', 'sm')}投稿する</button>`);
  const files = filePicker($('#n-files', dlg));
  const form = $('form', dlg);
  const pri = $('[name=priority]', dlg), nt = $('[name=notify]', dlg);
  if (nt) pri.addEventListener('change', () => { nt.checked = pri.value !== '通常'; });
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.title.trim()) return $('#n-title', dlg).focus();
    const btn = $('.btn.primary', dlg); btn.disabled = true;
    try {
      const p = await api('POST', '/api/posts', { ...fd, notify: !!nt && nt.checked });
      await uploadAll('posts', p.id, files);
      dlg.close();
      state.filter = 'すべて';
      await refreshData(); render();
      toast('投稿しました');
    } finally { btn.disabled = false; }
  }));
}

function eventDialog(ev, date) {
  const editing = !!ev;
  const e = ev || { title: '', type: '診療', date, endDate: date, allDay: false, start: '09:00', end: '', memo: '', files: [] };
  const dlg = openModal(editing ? '予定を編集' : '予定を追加', `
    <div class="field"><label for="e-title">タイトル</label><input class="input" id="e-title" name="title" required maxlength="100" value="${esc(e.title)}" placeholder="例: 院内ミーティング"></div>
    <div class="row two">
      <div class="field"><label for="e-type">種類</label><select class="input" id="e-type" name="type">${opts(state.meta.eventTypes, e.type)}</select></div>
      <div class="field" style="align-content:end"><label class="check" style="min-height:44px;align-items:center"><input type="checkbox" name="allDay" ${e.allDay ? 'checked' : ''} style="margin:0"><span>終日</span></label></div>
    </div>
    <div class="row two">
      <div class="field"><label for="e-date">開始日</label><input class="input" id="e-date" name="date" type="date" required value="${e.date}"></div>
      <div class="field"><label for="e-end-date">終了日</label><input class="input" id="e-end-date" name="endDate" type="date" value="${e.endDate}"></div>
    </div>
    <div class="row two" id="times">
      <div class="field"><label for="e-start">開始時刻</label><input class="input" id="e-start" name="start" type="time" value="${esc(e.start)}"></div>
      <div class="field"><label for="e-end">終了時刻（任意）</label><input class="input" id="e-end" name="end" type="time" value="${esc(e.end)}"></div>
    </div>
    <div class="field"><label for="e-memo">メモ</label><textarea class="input" id="e-memo" name="memo" maxlength="2000" style="min-height:80px" placeholder="場所・持ち物・連絡事項など">${esc(e.memo)}</textarea></div>
    <div class="field"><span class="lbl">添付ファイル</span><div id="e-existing">${filesHtml(e.files, true)}</div><div id="e-files"></div></div>
    ${notifyBox(false, editing ? '変更をLINE・メールで通知する' : '予定をLINE・メールで通知する')}`,
    `${editing ? `<button type="button" class="btn danger left" data-act="x" id="e-del">${icon('trash', 'sm')}削除</button>` : ''}<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${icon('check', 'sm')}${editing ? '更新する' : '追加する'}</button>`);
  const files = filePicker($('#e-files', dlg));
  const form = $('form', dlg);
  const allDay = $('[name=allDay]', dlg);
  const sync = () => { $('#times', dlg).hidden = allDay.checked; };
  allDay.addEventListener('change', sync); sync();
  $('[name=date]', dlg).addEventListener('change', (x) => { const ed = $('[name=endDate]', dlg); if (!ed.value || ed.value < x.target.value) ed.value = x.target.value; });
  $('#e-existing', dlg).addEventListener('click', guard(async (x) => {
    const b = x.target.closest('[data-act=del-file]');
    if (!b) return;
    x.stopPropagation();
    await api('DELETE', `/api/files/${b.dataset.id}`);
    b.closest('.file').remove();
    await refreshData(); render();
  }));
  if (editing) $('#e-del', dlg).addEventListener('click', guard(async () => {
    if (!confirm('この予定を削除しますか？')) return;
    await api('DELETE', `/api/events/${ev.id}`);
    dlg.close(); await refreshData(); render(); toast('削除しました');
  }));
  form.addEventListener('submit', guard(async (x) => {
    x.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.title.trim()) return $('#e-title', dlg).focus();
    const body = { ...fd, allDay: allDay.checked, notify: !!fd.notify };
    const btn = $('.btn.primary', dlg); btn.disabled = true;
    try {
      const saved = editing ? await api('PUT', `/api/events/${ev.id}`, body) : await api('POST', '/api/events', body);
      await uploadAll('events', saved.id, files);
      state.cal.sel = saved.date; state.cal.y = parseYmd(saved.date).getFullYear(); state.cal.m = parseYmd(saved.date).getMonth();
      dlg.close(); await refreshData(); render(); toast(editing ? '更新しました' : '予定を追加しました');
    } finally { btn.disabled = false; }
  }));
}

function eventDetailDialog(e) {
  const d = parseYmd(e.date);
  const span = e.endDate !== e.date ? ` 〜 ${parseYmd(e.endDate).getMonth() + 1}月${parseYmd(e.endDate).getDate()}日` : '';
  openModal(e.title, `
    <div><span class="pill brand">${esc(e.type)}</span></div>
    <div><b>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）${span}</b><br><span style="color:var(--ink-2)">${evTime(e)}</span></div>
    ${e.memo ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(e.memo)}</div>` : ''}
    ${filesHtml(e.files, false)}
    <div class="hint">登録: ${esc(e.author)}</div>`,
    '<button type="button" class="btn" data-close>閉じる</button>');
}

function userDialog(u) {
  const editing = !!u;
  const dlg = openModal(editing ? 'スタッフを編集' : 'スタッフを追加', `
    <div class="form-error" hidden></div>
    <div class="field"><label for="u-name">名前</label><input class="input" id="u-name" name="name" required maxlength="30" value="${esc(u?.name)}"></div>
    <div class="field"><label for="u-job">職種</label><select class="input" id="u-job" name="jobTitle"><option value="">未設定</option>${opts(state.meta.jobs, u?.jobTitle)}</select></div>
    <div class="field"><label for="u-id">ログインID</label><input class="input" id="u-id" name="loginId" ${editing ? 'disabled' : 'required'} value="${esc(u?.loginId)}" autocapitalize="none" placeholder="半角英数字（例: sato）"></div>
    <div class="field"><label for="u-mail">メールアドレス（任意）</label><input class="input" id="u-mail" name="email" type="email" value="${esc(u?.email)}"></div>
    <div class="field"><label for="u-role">権限</label><select class="input" id="u-role" name="role" ${u && u.id === state.user.id ? 'disabled' : ''}><option value="staff" ${u?.role !== 'admin' ? 'selected' : ''}>スタッフ</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>管理者</option></select></div>
    <div class="field"><label for="u-pw">${editing ? '新しいパスワード（変更する場合のみ）' : 'パスワード'}</label><input class="input" id="u-pw" name="password" type="password" ${editing ? '' : 'required'} minlength="8" autocomplete="new-password"><span class="hint">8文字以上${editing ? '。変更するとそのユーザーはログアウトされます' : ''}</span></div>`,
    `<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${editing ? '保存する' : '追加する'}</button>`);
  const form = $('form', dlg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (editing) { delete fd.loginId; if (!fd.password) delete fd.password; if ($('[name=role]', dlg).disabled) delete fd.role; }
    try {
      if (editing) await api('PATCH', `/api/users/${u.id}`, fd); else await api('POST', '/api/users', fd);
      dlg.close(); await refreshData(); render(); toast(editing ? '保存しました' : 'スタッフを追加しました');
    } catch (err) {
      const box = $('.form-error', dlg); box.textContent = err.message; box.hidden = false;
    }
  });
}

// ---------- lab / inventory dialogs ----------
function bindExistingFiles(dlg, host) {
  host.addEventListener('click', guard(async (x) => {
    const b = x.target.closest('[data-act=del-file]');
    if (!b) return;
    x.stopPropagation();
    await api('DELETE', `/api/files/${b.dataset.id}`);
    b.closest('.file').remove();
    await refreshData(); render();
  }));
}
const closeAllDialogs = () => document.querySelectorAll('dialog[open]').forEach((d) => d.close());

function labFormDialog(o) {
  const editing = !!o;
  const v = o || { patientRef: '', type: state.meta.labTypes[0], teeth: '', material: '', shade: '', doctor: '', lab: '', assigneeId: '', requestDate: todayStr(), dueDate: ymd(new Date(Date.now() + 7 * 864e5)), setDate: '', urgent: false, memo: '', files: [] };
  const doctors = state.users.filter((u) => u.jobTitle === '歯科医師');
  const sorted = [...state.users].sort((a, b) => (b.jobTitle === '歯科技工士') - (a.jobTitle === '歯科技工士'));
  const dlg = openModal(editing ? `${o.no} を編集` : '技工物の新規依頼', `
    <div class="row two">
      <div class="field"><label for="l-pt">患者番号／イニシャル</label><input class="input" id="l-pt" name="patientRef" required maxlength="40" value="${esc(v.patientRef)}" placeholder="例: No.1042"></div>
      <div class="field"><label for="l-type">技工物の種類</label><select class="input" id="l-type" name="type">${opts(state.meta.labTypes, v.type)}</select></div>
    </div>
    <div class="row three">
      <div class="field"><label for="l-teeth">部位</label><input class="input" id="l-teeth" name="teeth" maxlength="60" value="${esc(v.teeth)}" placeholder="例: 右上6"></div>
      <div class="field"><label for="l-mat">素材</label><input class="input" id="l-mat" name="material" maxlength="60" value="${esc(v.material)}" placeholder="例: ジルコニア"></div>
      <div class="field"><label for="l-shade">色調</label><input class="input" id="l-shade" name="shade" maxlength="30" value="${esc(v.shade)}" placeholder="例: A2"></div>
    </div>
    <div class="row two">
      <div class="field"><label for="l-doc">依頼医</label><input class="input" id="l-doc" name="doctor" maxlength="40" list="doctors" value="${esc(v.doctor)}"><datalist id="doctors">${doctors.map((u) => `<option value="${esc(u.name)}">`).join('')}</datalist></div>
      <div class="field"><label for="l-asg">担当（院内）</label><select class="input" id="l-asg" name="assigneeId"><option value="">未定</option>${sorted.map((u) => `<option value="${u.id}" ${u.id === v.assigneeId ? 'selected' : ''}>${esc(u.name)}${u.jobTitle ? `（${esc(u.jobTitle)}）` : ''}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="l-lab">外注先（院内製作なら空欄）</label><input class="input" id="l-lab" name="lab" maxlength="60" value="${esc(v.lab)}" placeholder="例: ○○デンタルラボ"></div>
    <div class="row three">
      <div class="field"><label for="l-req">依頼日</label><input class="input" id="l-req" name="requestDate" type="date" required value="${v.requestDate}"></div>
      <div class="field"><label for="l-due">納期</label><input class="input" id="l-due" name="dueDate" type="date" required value="${v.dueDate}"></div>
      <div class="field"><label for="l-set">セット予定日</label><input class="input" id="l-set" name="setDate" type="date" value="${v.setDate}"></div>
    </div>
    <label class="check"><input type="checkbox" name="urgent" ${v.urgent ? 'checked' : ''}><span>急ぎの依頼</span></label>
    <div class="field"><label for="l-memo">指示・メモ</label><textarea class="input" id="l-memo" name="memo" maxlength="2000" style="min-height:80px" placeholder="形態・咬合・注意点など">${esc(v.memo)}</textarea></div>
    <div class="field"><span class="lbl">指示書・写真</span><div id="l-existing">${filesHtml(v.files, true)}</div><div id="l-files"></div></div>
    ${editing ? '' : notifyBox(false, '依頼をLINE・メールで通知する')}
    <div class="warn-note">患者さまの氏名は入力しないでください。患者番号またはイニシャルを使用してください。</div>`,
    `<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${icon('check', 'sm')}${editing ? '更新する' : '依頼を登録'}</button>`);
  const files = filePicker($('#l-files', dlg));
  bindExistingFiles(dlg, $('#l-existing', dlg));
  const form = $('form', dlg);
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = { ...fd, urgent: !!fd.urgent, notify: !!fd.notify };
    const btn = $('.btn.primary', dlg); btn.disabled = true;
    try {
      const saved = editing ? await api('PUT', `/api/lab/${o.id}`, body) : await api('POST', '/api/lab', body);
      await uploadAll('lab', saved.id, files);
      dlg.close(); await refreshData(); render(); toast(editing ? '更新しました' : `${saved.no} を登録しました`);
    } finally { btn.disabled = false; }
  }));
}

function labDetailDialog(o) {
  const di = dueInfo(o.dueDate);
  const idx = (s) => state.meta.labStatuses.indexOf(s);
  const row = (k, val) => (val ? `<div><dt>${k}</dt><dd>${val}</dd></div>` : '');
  const dlg = openModal(`${o.no}　${o.type}`, `
    <div class="post-meta"><span class="pill brand">${esc(o.status)}</span>${o.urgent ? '<span class="pill urgent">急ぎ</span>' : ''}${o.remakeCount ? `<span class="pill warn">再製作 ${o.remakeCount}回</span>` : ''}</div>
    <dl class="kv">
      ${row('患者番号', esc(o.patientRef))}${row('依頼医', esc(o.doctor))}${row('部位', esc(o.teeth))}${row('素材', esc(o.material))}${row('色調', esc(o.shade))}
      ${row('担当', esc(o.assigneeId ? userName(o.assigneeId) : ''))}${row('製作', o.lab ? `外注: ${esc(o.lab)}` : '院内')}
      ${row('依頼日', md(o.requestDate))}${row('納期', `${md(o.dueDate)}${o.status === 'セット済' ? '' : ` <span class="due ${di.c}">${di.t}</span>`}`)}${row('セット予定', o.setDate ? md(o.setDate) : '')}
    </dl>
    ${o.memo ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(o.memo)}</div>` : ''}
    ${filesHtml(o.files, false)}
    <div><div class="sect-label">工程を変更</div><div class="steps">${state.meta.labStatuses.map((s) => `<button type="button" class="step ${s === o.status ? 'on' : idx(s) < idx(o.status) ? 'done' : ''}" data-to="${s}" ${s === o.status ? 'disabled aria-current="step"' : ''}>${s}</button>`).join('')}</div></div>
    <div><div class="sect-label">履歴</div><ul class="timeline">${[...o.history].reverse().map((h) => `<li><div><b>${esc(h.status)}</b> ・ ${esc(h.by)}<small>${fmtWhen(h.at)}${h.note ? ` ・ ${esc(h.note)}` : ''}</small></div></li>`).join('')}</ul></div>`,
    `${canModify(o) ? `<button type="button" class="btn danger left" data-x="del">${icon('trash', 'sm')}削除</button>` : ''}<button type="button" class="btn" data-x="remake">再製作にする</button><button type="button" class="btn primary" data-x="edit">${icon('edit', 'sm')}編集</button>`);
  dlg.addEventListener('click', guard(async (e) => {
    const step = e.target.closest('[data-to]');
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (step) labStatusDialog(o, step.dataset.to, false);
    else if (x === 'remake') labStatusDialog(o, '製作中', true);
    else if (x === 'edit') { dlg.close(); labFormDialog(o); }
    else if (x === 'del') {
      if (!confirm(`${o.no} を削除しますか？添付ファイルも削除されます。`)) return;
      await api('DELETE', `/api/lab/${o.id}`); dlg.close(); await refreshData(); render(); toast('削除しました');
    }
  }));
}

function labStatusDialog(o, to, remake) {
  const dlg = openModal(remake ? '再製作にする' : `工程を「${to}」に変更`, `
    <div class="field"><label for="s-note">メモ（任意）</label><input class="input" id="s-note" name="note" maxlength="200" placeholder="${remake ? '再製作の理由など' : '例: 試適OK、色調確認済み'}"></div>
    ${remake ? '' : notifyBox(to === '完成', `「${to}」をLINE・メールで通知する`)}`,
    `<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${icon('check', 'sm')}${remake ? '再製作にする' : '変更する'}</button>`);
  const form = $('form', dlg);
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (remake) await api('POST', `/api/lab/${o.id}/remake`, { note: fd.note });
    else await api('POST', `/api/lab/${o.id}/status`, { status: to, note: fd.note, notify: !!fd.notify });
    closeAllDialogs(); await refreshData(); render(); toast(remake ? '再製作にしました' : `「${to}」に変更しました`);
  }));
}

function itemFormDialog(it) {
  const editing = !!it;
  const v = it || { name: '', location: state.ui.inv.loc !== 'すべて' ? state.ui.inv.loc : state.meta.locations[0], category: state.meta.itemCategories[0], unit: '個', qty: 0, reorderPoint: 0, target: 0, supplier: '', expiry: '', memo: '' };
  const dlg = openModal(editing ? '品目を編集' : '品目を追加', `
    <div class="field"><label for="i-name">品名</label><input class="input" id="i-name" name="name" required maxlength="60" value="${esc(v.name)}" placeholder="例: 超硬石膏 / 3Mグローブ S"></div>
    <div class="row two">
      <div class="field"><label for="i-loc">置き場所</label><select class="input" id="i-loc" name="location">${opts(state.meta.locations, v.location)}</select></div>
      <div class="field"><label for="i-cat">分類</label><select class="input" id="i-cat" name="category">${opts(state.meta.itemCategories, v.category)}</select></div>
    </div>
    <div class="row three">
      <div class="field"><label for="i-qty">現在数</label><input class="input" id="i-qty" name="qty" type="number" min="0" step="any" inputmode="decimal" value="${v.qty}" ${editing ? 'disabled' : ''}>${editing ? '<span class="hint">変更は「使用・入庫・棚卸」で</span>' : ''}</div>
      <div class="field"><label for="i-unit">単位</label><input class="input" id="i-unit" name="unit" maxlength="10" list="units" value="${esc(v.unit)}"><datalist id="units">${['個', '箱', '袋', '本', 'ml', 'g', 'kg', 'セット', '枚'].map((u) => `<option>${u}`).join('')}</datalist></div>
      <div class="field"><label for="i-rp">発注点</label><input class="input" id="i-rp" name="reorderPoint" type="number" min="0" step="any" inputmode="decimal" value="${v.reorderPoint}"><span class="hint">この数以下で要発注</span></div>
    </div>
    <div class="row two">
      <div class="field"><label for="i-target">適正在庫（任意）</label><input class="input" id="i-target" name="target" type="number" min="0" step="any" inputmode="decimal" value="${v.target}"><span class="hint">発注時の目標数</span></div>
      <div class="field"><label for="i-exp">使用期限（任意）</label><input class="input" id="i-exp" name="expiry" type="date" value="${esc(v.expiry)}"></div>
    </div>
    <div class="field"><label for="i-sup">仕入先（任意）</label><input class="input" id="i-sup" name="supplier" maxlength="60" value="${esc(v.supplier)}" placeholder="例: ○○歯科商店"></div>
    <div class="field"><label for="i-memo">メモ（任意）</label><input class="input" id="i-memo" name="memo" maxlength="500" value="${esc(v.memo)}" placeholder="保管場所・型番など"></div>`,
    `<button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${icon('check', 'sm')}${editing ? '保存する' : '追加する'}</button>`);
  const form = $('form', dlg);
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.name.trim()) return $('#i-name', dlg).focus();
    if (editing) await api('PUT', `/api/inventory/${it.id}`, fd); else await api('POST', '/api/inventory', fd);
    dlg.close(); await refreshData(); render(); toast(editing ? '保存しました' : '品目を追加しました');
  }));
}

const STOCK_LABEL = { use: '使用', in: '入庫', set: '棚卸', new: '登録' };
function itemDetailDialog(id) {
  const dlg = openModal(state.items.find((i) => i.id === id).name, `
    <div id="d-sum"></div>
    <div class="field"><span class="lbl">数量を記録</span>
      <div class="seg-radio" role="radiogroup" aria-label="操作">
        <label><input type="radio" name="type" value="use" checked><span>使用</span></label>
        <label><input type="radio" name="type" value="in"><span>入庫</span></label>
        <label><input type="radio" name="type" value="set"><span>棚卸</span></label>
      </div></div>
    <div class="row two">
      <div class="field"><label for="d-amt" id="d-amt-l">使った数</label><input class="input" id="d-amt" name="amount" type="number" min="0" step="any" inputmode="decimal" required placeholder="例: 1"></div>
      <div class="field"><label for="d-note">メモ（任意）</label><input class="input" id="d-note" name="note" maxlength="100" placeholder="例: 症例No.1042"></div>
    </div>
    <button class="btn primary">${icon('check', 'sm')}記録する</button>
    <div><div class="sect-label">最近の履歴</div><ul class="timeline" id="d-hist"></ul></div>`,
    `<button type="button" class="btn danger left" data-x="del" hidden>${icon('trash', 'sm')}削除</button><button type="button" class="btn" data-x="order"></button><button type="button" class="btn" data-x="edit">${icon('edit', 'sm')}編集</button>`);
  const cur = () => state.items.find((i) => i.id === id);
  const labels = { use: '使った数', in: '入れた数', set: '実際の数（棚卸）' };
  const paint = () => {
    const i = cur();
    if (!i) return dlg.close();
    $('#d-sum', dlg).innerHTML = `<div class="sum-big"><b>${i.qty}</b><span>${esc(i.unit)}</span>${statePill(i)}</div>
      <dl class="kv" style="margin-top:12px">
        <div><dt>置き場所</dt><dd>${esc(i.location)}</dd></div><div><dt>分類</dt><dd>${esc(i.category)}</dd></div>
        <div><dt>発注点</dt><dd>${i.reorderPoint ? i.reorderPoint + esc(i.unit) : '—'}</dd></div><div><dt>適正在庫</dt><dd>${i.target ? i.target + esc(i.unit) : '—'}</dd></div>
        <div><dt>仕入先</dt><dd>${esc(i.supplier || '—')}</dd></div><div><dt>使用期限</dt><dd>${i.expiry ? esc(i.expiry) : '—'}</dd></div>
        ${i.memo ? `<div style="grid-column:1/-1"><dt>メモ</dt><dd>${esc(i.memo)}</dd></div>` : ''}</dl>`;
    const logs = state.stockLogs.filter((l) => l.itemId === id).slice(0, 8);
    $('#d-hist', dlg).innerHTML = logs.length ? logs.map((l) => `<li><div><b>${STOCK_LABEL[l.type] || l.type}${l.type === 'new' ? '' : ` ${l.delta > 0 ? '+' : ''}${l.delta}${esc(i.unit)}`}</b>（残り ${l.qty}${esc(i.unit)}）<small>${fmtWhen(l.at)} ・ ${esc(l.by)}${l.note ? ` ・ ${esc(l.note)}` : ''}</small></div></li>`).join('') : '<li><div class="hint">履歴はまだありません</div></li>';
    $('[data-x=order]', dlg).textContent = i.orderedAt ? '発注済を取り消す' : '発注済にする';
    $('[data-x=del]', dlg).hidden = !isAdmin();
  };
  paint();
  dlg.addEventListener('change', (e) => { if (e.target.name === 'type') $('#d-amt-l', dlg).textContent = labels[e.target.value]; });
  dlg.addEventListener('click', guard(async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'edit') { dlg.close(); itemFormDialog(cur()); }
    else if (x === 'order') { await api('POST', `/api/inventory/${id}/ordered`, { ordered: !cur().orderedAt }); await refreshData(); render(); paint(); }
    else if (x === 'del') {
      if (!confirm(`${cur().name} を削除しますか？`)) return;
      await api('DELETE', `/api/inventory/${id}`); dlg.close(); await refreshData(); render(); toast('削除しました');
    }
  }));
  $('form', dlg).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await api('POST', `/api/inventory/${id}/adjust`, fd);
    $('#d-amt', dlg).value = ''; $('#d-note', dlg).value = '';
    await refreshData(); render(); paint(); toast(`${STOCK_LABEL[fd.type]}を記録しました`);
  }));
}

function orderListDialog() {
  const need = state.items.filter(needsOrder);
  const waiting = state.items.filter((i) => i.orderedAt);
  const suggest = (i) => Math.max(Math.round(((i.target > 0 ? i.target : Math.max(i.reorderPoint * 2, 1)) - i.qty) * 100) / 100, 1);
  const groups = new Map();
  for (const i of need) { const k = i.supplier || '仕入先未設定'; groups.set(k, [...(groups.get(k) || []), i]); }
  const text = `【発注リスト】${md(todayStr())}\n` + [...groups].map(([s, arr]) => `■ ${s}\n` + arr.map((i) => `・${i.name} ${suggest(i)}${i.unit}（現在 ${i.qty}${i.unit}・${i.location}）`).join('\n')).join('\n');
  const dlg = openModal('発注リスト', `
    ${need.length ? [...groups].map(([s, arr]) => `<div class="order-group"><h3>${esc(s)}</h3>${arr.map((i) => `<div class="order-row"><div>${esc(i.name)}<small>${esc(i.location)} ・ 現在 ${i.qty}${esc(i.unit)}${i.reorderPoint ? ` / 発注点 ${i.reorderPoint}` : ''}</small></div><b>${suggest(i)}${esc(i.unit)}</b></div>`).join('')}</div>`).join('')
      : `<div class="empty">${icon('check')}<div>要発注の品目はありません</div></div>`}
    ${waiting.length ? `<div><div class="sect-label">入荷待ち（発注済）</div><div class="order-group">${waiting.map((i) => `<div class="order-row"><div>${esc(i.name)}<small>${esc(i.location)} ・ ${md(i.orderedAt)}に発注</small></div><b>${i.qty}${esc(i.unit)}</b></div>`).join('')}</div></div>` : ''}
    <textarea class="input" id="o-text" readonly hidden style="min-height:140px">${esc(text)}</textarea>
    <div class="hint">数量は「適正在庫 − 現在数」で計算しています（適正在庫が未設定なら発注点の2倍）。入庫を記録すると発注済みは自動で解除されます。</div>`,
    `<button type="button" class="btn" data-close>閉じる</button>${need.length ? `<button type="button" class="btn" data-x="copy">コピー</button><button type="button" class="btn primary" data-x="ordered">${icon('check', 'sm')}すべて発注済みにする</button>` : ''}`);
  dlg.addEventListener('click', guard(async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'copy') {
      try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
      catch { const ta = $('#o-text', dlg); ta.hidden = false; ta.select(); toast('下の文章を選択しました。コピーしてください'); }
    } else if (x === 'ordered') {
      await api('POST', '/api/inventory/bulk-ordered', { ids: need.map((i) => i.id) });
      dlg.close(); await refreshData(); render(); toast('発注済みにしました');
    }
  }));
}

// ---------- events ----------
document.addEventListener('click', guard(async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const { act, id, date } = t.dataset;
  const find = (arr) => arr.find((x) => x.id === id);
  switch (act) {
    case 'logout':
      await api('POST', '/api/logout'); Object.assign(state, { user: null, users: [], posts: [], events: [] });
      state.needsSetup = false; location.hash = ''; render(); break;
    case 'filter': state.filter = t.dataset.v; render(); break;
    case 'goto-unread': state.filter = '未読'; break;
    case 'goto-today': state.cal.sel = ymd(new Date()); state.cal.y = new Date().getFullYear(); state.cal.m = new Date().getMonth(); break;
    case 'goto-date': { const d = parseYmd(date); Object.assign(state.cal, { sel: date, y: d.getFullYear(), m: d.getMonth() }); break; }
    case 'goto-post': state.filter = 'すべて'; state.q = ''; setTimeout(() => $('#post-' + id)?.scrollIntoView({ block: 'center' }), 50); break;
    case 'new-post': postDialog(); break;
    case 'read': await api('POST', `/api/posts/${id}/read`); await refreshData(); render(); break;
    case 'pin': await api('POST', `/api/posts/${id}/pin`); await refreshData(); render(); break;
    case 'del-post':
      if (!confirm('この投稿を削除しますか？添付ファイルも削除されます。')) return;
      await api('DELETE', `/api/posts/${id}`); await refreshData(); render(); toast('削除しました'); break;
    case 'del-file':
      if (t.closest('dialog')) return; // ダイアログ内は専用ハンドラ
      if (!confirm('この添付ファイルを削除しますか？')) return;
      await api('DELETE', `/api/files/${id}`); await refreshData(); render(); break;
    case 'cal-prev': state.cal.m--; if (state.cal.m < 0) { state.cal.m = 11; state.cal.y--; } render(); break;
    case 'cal-next': state.cal.m++; if (state.cal.m > 11) { state.cal.m = 0; state.cal.y++; } render(); break;
    case 'cal-today': { const n = new Date(); Object.assign(state.cal, { y: n.getFullYear(), m: n.getMonth(), sel: ymd(n) }); render(); break; }
    case 'cal-sel': state.cal.sel = date; render(); break;
    case 'new-event': eventDialog(null, date || ymd(new Date())); break;
    case 'open-event': { const ev = find(state.events); if (ev) canModify(ev) ? eventDialog(ev) : eventDetailDialog(ev); break; }
    case 'new-lab': labFormDialog(null); break;
    case 'open-lab': { const o = find(state.lab); if (o) labDetailDialog(o); break; }
    case 'lab-filter': state.ui.lab.f = t.dataset.v; render(); break;
    case 'lab-done': state.ui.lab.done = !state.ui.lab.done; render(); break;
    case 'inv-loc': state.ui.inv.loc = t.dataset.v; render(); break;
    case 'inv-filter': state.ui.inv.f = t.dataset.v; render(); break;
    case 'new-item': itemFormDialog(null); break;
    case 'open-item': itemDetailDialog(id); break;
    case 'order-list': orderListDialog(); break;
    case 'stock-use': case 'stock-in':
      await api('POST', `/api/inventory/${id}/adjust`, { type: act === 'stock-use' ? 'use' : 'in', amount: 1 });
      await refreshData(); render(); break;
    case 'new-user': userDialog(null); break;
    case 'edit-user': userDialog(find(state.users)); break;
    case 'del-user': {
      const u = find(state.users);
      if (!confirm(`${u.name} さんのアカウントを削除しますか？`)) return;
      await api('DELETE', `/api/users/${id}`); await refreshData(); render(); toast('削除しました'); break;
    }
    case 'test-notify': { const r = await api('POST', '/api/notify/test'); toast(`LINE: ${r.line} / メール: ${r.email}`); break; }
  }
}));

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-act][role=button]')) { e.preventDefault(); e.target.click(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { state.q = e.target.value; $('#posts').innerHTML = postsHtml(); }
  if (e.target.id === 'lab-q') { state.ui.lab.q = e.target.value; $('#lab-board').innerHTML = labBoard(); }
  if (e.target.id === 'inv-q') { state.ui.inv.q = e.target.value; $('#inv-list').innerHTML = invList(); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const fd = Object.fromEntries(new FormData(form));
  const err = $('.form-error', form);
  const show = (m) => { if (err) { err.textContent = m; err.hidden = false; } else toast(m, true); };
  try {
    if (kind === 'login' || kind === 'setup') {
      state.user = await api('POST', kind === 'login' ? '/api/login' : '/api/setup', fd);
      state.needsSetup = false;
      await enter();
    } else if (kind === 'profile') {
      state.user = await api('PATCH', '/api/me', { email: fd.email, notifyEmail: !!fd.notifyEmail });
      await refreshData(); render(); toast('保存しました');
    } else if (kind === 'password') {
      await api('PATCH', '/api/me', fd);
      form.reset(); if (err) err.hidden = true; toast('パスワードを変更しました');
    }
  } catch (x) { show(x.message); }
});

window.addEventListener('hashchange', () => { if (state.user) { render(); window.scrollTo(0, 0); } });

// 30秒ごとに自動更新（入力中・ダイアログ表示中は画面を触らない）
setInterval(async () => {
  if (!state.user || document.hidden || $('dialog[open]') || document.activeElement?.matches('input,textarea,select')) return;
  try { await refreshData(); render(); } catch {}
}, 30000);

boot().catch(() => { $('#app').innerHTML = '<div class="loading">サーバーに接続できません</div>'; });
