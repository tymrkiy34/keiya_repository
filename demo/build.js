// 使い方: node demo/build.js  → dist/demo.html（単一HTML。実サーバー不要で画面を試せるデモ）
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let css = read('public/app.css');
// ダークテーマを prefers-color-scheme と data-theme の両方で効かせる
css = css.replace(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}\n\}/, (_, inner) =>
  `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {${inner}\n  }\n}\n:root[data-theme="dark"] {${inner}\n}`);
if (!css.includes('[data-theme="dark"]')) throw new Error('dark block patch failed');

let js = read('public/app.js');
const patches = [
  ["const route = () => (location.hash.replace('#/', '') || 'home').split('?')[0];", "const route = () => window.__route || 'home';"],
  ["if (!location.hash) location.hash = '#/home';", "window.__route = window.__route || 'home';"],
  ["state.needsSetup = false; location.hash = ''; render(); break;", "state.needsSetup = false; window.__route = 'home'; render(); break;"],
];
for (const [from, to] of patches) { if (!js.includes(from)) throw new Error('patch target missing: ' + from); js = js.replace(from, to); }
// 公開しているグローバル関数に依存（render / toast は関数宣言なので window から参照できる）

const sprite = read('public/index.html').match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const demoCss = `
.demo-bar{display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center;justify-content:center;padding:8px 16px;background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:500;text-align:center}
.demo-bar b{background:var(--brand);color:#fff;border-radius:999px;padding:1px 10px;font-size:11.5px;letter-spacing:.06em}
.demo-quick{display:grid;gap:8px;padding:14px;border:1px dashed var(--line-2);border-radius:var(--r);background:var(--surface);font-size:13px;color:var(--ink-2)}
.demo-quick div{display:flex;gap:8px;flex-wrap:wrap}
.demo-quick button{flex:1;min-height:40px;border-radius:999px;border:1px solid var(--brand);background:var(--brand-50);color:var(--brand-600);font-weight:700;font-size:13.5px}
.demo-quick button:hover{background:var(--brand-100)}
`;
const html = `<title>スマイル情報共有</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
${css}
${demoCss}
</style>
<div class="demo-bar"><b>DEMO</b><span>データはこのブラウザ内にだけ保存されます。LINE・メール通知と添付のダウンロードは実際には動きません。</span></div>
${sprite}
<div id="app"><div class="loading">読み込み中…</div></div>
<div id="toasts" role="status" aria-live="polite"></div>
<script>
${fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8')}
</script>
<script>
${js}
</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/demo.html'), html);
console.log('dist/demo.html', Math.round(html.length / 1024) + 'KB');
