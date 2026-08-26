/**
 * 趣味游戏 · 主 Worker（静态网站 + 云端排行榜 API 一体）
 * ------------------------------------------------
 * 静态资源由 wrangler.toml 的 [assets] 自动托管；
 * 本脚本只处理排行榜接口，其余路径回落到静态资产：
 *   GET  /scores            拉取榜单（?limit=N，默认100，最大200）
 *   POST /scores            提交成绩 {name, score, note, anon, ts}
 *   GET  /admin             管理页（需在配置中设置 ADMIN_KEY）
 *   GET  /admin/clear?key=  清空榜单
 *
 * 存储说明：每条成绩是一个独立的 KV 键，整条记录编码在键名里
 * （s/<ts>/<score>/<匿名0|1>/<名字base64url>/<备注base64url>），
 * 读取只用 KV list——list 不走边缘缓存，永远拿到最新数据。
 * 旧版把整个数组塞进单个 scores 键做「读-改-写」：KV get 有最低 60 秒
 * 边缘缓存，导致刚提交的成绩一分钟内看不到，且缓存期内再次提交会读到
 * 旧数组、写回时把别人的新成绩覆盖丢失。首次访问会自动把旧数据迁移到新格式。
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const MAX_LIST = 2000; // 最多保留多少条记录（超出后剪掉最老的）
const PREFIX = 's/';

/* ---------- 键名编解码：整条记录编码在键名里，list 一次拿全 ---------- */
function b64e(s){
  const bytes = new TextEncoder().encode(String(s ?? ''));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(s){
  try {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  } catch (e){ return ''; }
}
function keyOf(e){
  return `${PREFIX}${Math.trunc(e.ts)}/${Math.trunc(e.score)}/${e.anon ? 1 : 0}/${b64e(e.name)}/${b64e(e.note)}`;
}
function entryOf(key){
  const p = String(key).split('/');
  if (p.length !== 6 || p[0] !== 's') return null;
  const ts = parseInt(p[1], 10), score = parseInt(p[2], 10);
  if (!Number.isFinite(ts) || !Number.isFinite(score)) return null;
  return { ts, score, anon: p[3] === '1', name: b64d(p[4]), note: b64d(p[5]) };
}

/* ---------- 读写整套榜单 ---------- */
async function listAllKeys(env){
  const out = [];
  let cursor;
  do {
    const r = await env.LB.list({ prefix: PREFIX, limit: 1000, cursor });
    for (const k of r.keys) out.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}
// 旧版数据（单个 scores 键里的数组）自动迁移成分键格式，只执行一次
async function migrate(env){
  const legacy = await env.LB.get('scores', 'json');
  if (!Array.isArray(legacy) || !legacy.length) return;
  await Promise.all(legacy
    .filter(e => e && typeof e === 'object' && Number.isFinite(Number(e.score)))
    .map(e => env.LB.put(keyOf({
      name: String(e.name ?? '').slice(0, 20),
      anon: !!e.anon,
      score: Math.floor(Number(e.score)),
      note: String(e.note ?? '').slice(0, 60),
      ts: Math.floor(Number(e.ts)) || Date.now(),
    }), '1')));
  await env.LB.delete('scores');
}
async function loadAll(env){
  await migrate(env);
  const keys = await listAllKeys(env);
  return { keys, list: keys.map(entryOf).filter(Boolean) };
}
const byRank = (a, b) => b.score - a.score || b.ts - a.ts;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/scores') {
      // 拉取榜单
      if (request.method === 'GET') {
        const q = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
        const limit = Math.min(Math.max(q, 1), 200);
        const { list } = await loadAll(env);
        return json(list.sort(byRank).slice(0, limit));
      }
      // 提交成绩：直接写独立键，不读旧值，天然没有并发覆盖问题；同一条重复提交是幂等的
      if (request.method === 'POST') {
        let b = {};
        try { b = await request.json(); } catch (e) { /* 忽略 */ }
        const entry = sanitize(b);
        if (!entry) return json({ error: 'bad request' }, 400);
        await env.LB.put(keyOf(entry), '1');
        // 超出上限时剪掉最老的（键名以时间戳开头，字典序即时间序）
        const keys = await listAllKeys(env);
        if (keys.length > MAX_LIST){
          keys.sort();
          await Promise.all(keys.slice(0, keys.length - MAX_LIST).map(k => env.LB.delete(k)));
        }
        return json({ ok: true, entry });
      }
    }

    // 管理接口：清空榜单（需在配置中设置 ADMIN_KEY）
    if (url.pathname === '/admin/clear' && env.ADMIN_KEY
        && url.searchParams.get('key') === env.ADMIN_KEY) {
      const keys = await listAllKeys(env);
      await Promise.all(keys.map(k => env.LB.delete(k)));
      await env.LB.delete('scores'); // 旧格式残留一并清掉
      return json({ ok: true });
    }

    // 管理页：浏览器里可视化编辑/删除单条记录
    if (url.pathname === '/admin' && env.ADMIN_KEY) {
      if (url.searchParams.get('key') !== env.ADMIN_KEY)
        return new Response(adminLoginHtml(), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
      const { list } = await loadAll(env);
      return new Response(adminPageHtml(list.sort(byRank)), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/admin/save' && request.method === 'POST' && env.ADMIN_KEY) {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      if (b.key !== env.ADMIN_KEY) return json({ error: '密码错误' }, 403);
      const arr = Array.isArray(b.list) ? b.list : null;
      if (!arr) return json({ error: 'bad list' }, 400);
      // 合并模式：按 ts+score 去重后与现有数据合并，避免管理页覆盖游戏新提交
      const { keys, list: existing } = await loadAll(env);
      const seen = new Set();
      const merged = [];
      for (const e of [...arr.map(sanitize).filter(Boolean), ...existing]){
        const k = e.ts + '|' + e.score;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(e);
      }
      merged.sort(byRank);
      // 只写增量、只删多余，不做整表重写
      const keep = new Set(merged.map(keyOf));
      const cur = new Set(keys);
      await Promise.all([
        ...keys.filter(k => !keep.has(k)).map(k => env.LB.delete(k)),
        ...merged.filter(e => !cur.has(keyOf(e))).map(e => env.LB.put(keyOf(e), '1')),
      ]);
      return json({ ok: true, count: merged.length });
    }

    // 其余路径交给静态资产服务（游戏页面等）
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 清洗提交的数据，防止乱填乱注入
function sanitize(b) {
  const score = Math.floor(Number(b.score));
  if (!Number.isFinite(score) || score < 0 || score > 9999999) return null;
  const rawName = String(b.name ?? '').slice(0, 20).trim();
  const anon = !!b.anon || !rawName;
  // 优先采用客户端时间戳（同一局成绩重传时键名一致，天然去重）
  const ts = Math.floor(Number(b.ts));
  return {
    name: anon ? '' : rawName,
    anon,
    score,
    note: String(b.note ?? '').slice(0, 60).trim(),
    ts: (Number.isFinite(ts) && ts > 0) ? Math.min(ts, Date.now() + 600000) : Date.now(),
  };
}

/* ---------- 管理页（米白纸张 × 暗红强调 · 日系杂志 × Swiss Style） ---------- */
function esc(s){
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
const A_STYLE = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Noto+Serif+SC:wght@400;600;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#f7f3ea; --ink:#1c1a17; --ink-soft:#6b655b;
    --accent:#8e2f22; --line:rgba(28,26,23,.16);
    --serif-cn:'Noto Serif SC','Songti SC',serif;
    --serif-en:'Playfair Display',Georgia,serif;
    --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html{background:var(--paper)}
  body{
    background:var(--paper);color:var(--ink);
    font-family:var(--serif-cn),serif;
    background-image:radial-gradient(rgba(28,26,23,.05) 1px,transparent 1.2px);
    background-size:5px 5px;
    min-height:100vh;padding:clamp(18px,4vw,56px);
  }
  body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
    background:radial-gradient(ellipse at center,transparent 52%,rgba(122,92,60,.12) 100%)}
  .sheet{position:relative;z-index:1;max-width:1080px;margin:0 auto}
  .frame{border:1px solid var(--line);outline:1px solid var(--line);outline-offset:5px;
    padding:clamp(16px,3.2vw,44px);background:
    linear-gradient(var(--paper),var(--paper)) padding-box}

  header{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;
    border-bottom:2.5px solid var(--ink);padding-bottom:14px}
  .kicker{font-family:var(--mono);font-size:10px;letter-spacing:.34em;color:var(--accent);text-transform:uppercase;margin-bottom:8px}
  h1{font-weight:900;font-size:clamp(28px,5.6vw,54px);letter-spacing:.06em;line-height:1.04;color:var(--ink)}
  h1 em{font-family:var(--serif-en);font-style:italic;font-weight:400;color:var(--accent);font-size:.6em;letter-spacing:.02em;margin-left:.15em}
  .head-meta{text-align:right;font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--ink-soft);white-space:nowrap}
  .sub-rule{display:flex;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:clamp(14px,2.6vw,26px)}
  .sub-rule span{flex:1;text-align:center;font-family:var(--mono);font-size:10px;letter-spacing:.3em;padding:7px 0;color:var(--ink-soft)}
  .sub-rule span+span{border-left:1px solid var(--line)}

  table{width:100%;border-collapse:collapse}
  thead th{font-family:var(--mono);font-size:10px;letter-spacing:.22em;font-weight:500;
    color:var(--ink-soft);text-transform:uppercase;text-align:left;
    border-bottom:1.5px solid var(--ink);padding:10px 9px}
  tbody tr:hover{background:rgba(142,47,34,.045)}
  td{padding:11px 9px;border-bottom:1px solid var(--line);font-size:15px;vertical-align:middle}
  td.idx{font-family:var(--serif-en);color:var(--accent)}
  td.idx b{font-size:19px;font-weight:600}
  td.time{font-family:var(--mono);font-size:11px;color:var(--ink-soft);white-space:nowrap}
  input{width:100%;background:transparent;border:none;border-bottom:1px solid var(--line);
    font-family:inherit;font-size:15px;color:var(--ink);padding:4px 2px;transition:border-color .15s;border-radius:0}
  input:focus{outline:none;border-bottom:1.5px solid var(--accent);margin-bottom:-.5px}
  input::placeholder{color:rgba(107,101,91,.55);font-style:italic;font-family:var(--serif-en)}
  .f-score{width:72px;font-family:var(--mono);font-size:16px}
  .del{background:none;border:1px solid var(--line);color:var(--ink-soft);width:30px;height:30px;
    border-radius:50%;cursor:pointer;font-size:11px;line-height:1;transition:all .18s}
  tr:hover .del{border-color:var(--accent);color:var(--accent)}
  tr:hover .del:hover{background:var(--accent);color:var(--paper);transform:rotate(90deg)}

  .bar{display:flex;align-items:center;gap:12px;margin-top:clamp(16px,2.8vw,30px);flex-wrap:wrap}
  .btn{font-family:var(--serif-cn);font-weight:600;letter-spacing:.16em;cursor:pointer;
    padding:13px 30px;font-size:14px;border:1px solid var(--ink);background:transparent;
    color:var(--ink);transition:all .18s}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--paper)}
  .btn.danger{border-color:var(--accent);color:var(--accent)}
  .btn.primary:hover,.btn.danger:hover,.btn:not(.primary):not(.danger):hover{background:var(--ink);border-color:var(--ink);color:var(--paper)}
  #tip{font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.08em}
  footer{margin-top:clamp(20px,3vw,32px);display:flex;justify-content:space-between;
    font-family:var(--mono);font-size:10px;color:var(--ink-soft);letter-spacing:.24em}
  .empty{padding:64px 0;text-align:center;color:var(--ink-soft)}
  .empty p{font-size:21px;letter-spacing:.35em;margin-bottom:8px}
  .empty small{font-family:var(--mono);font-size:10px;letter-spacing:.3em}

  /* 竖排装饰文字（仅宽屏） */
  .vertical{position:fixed;top:50%;transform:translateY(-50%);writing-mode:vertical-rl;
    font-family:var(--mono);font-size:10px;letter-spacing:.55em;
    color:rgba(142,47,34,.5);z-index:2;pointer-events:none;user-select:none}
  .vertical.l{left:calc((100vw - 1080px)/2 - 46px)}
  .vertical.r{right:calc((100vw - 1080px)/2 - 46px)}
  @media(max-width:1240px){.vertical{display:none}}

  @media(max-width:700px){
    body{padding:12px}
    .frame{padding:14px 10px;outline-offset:3px}
    header{flex-direction:column;align-items:flex-start}
    .head-meta{text-align:left;display:flex;gap:14px}
    thead .hide-m,td.hide-m{display:none}
    td,th{padding-left:4px;padding-right:4px}
    td{font-size:14px}
    input{font-size:14px}
    .f-score{width:54px;font-size:14px}
    .bar{gap:7px}
    .btn{padding:11px 16px;font-size:13px;letter-spacing:.08em;flex:1;text-align:center}
    footer{font-size:9px;letter-spacing:.12em}
  }
</style>`;

const A_HEAD = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + A_STYLE;

function adminLoginHtml(){
  return '<!DOCTYPE html><html lang="zh-CN"><head>' + A_HEAD + `<title>排行榜管理 · Login</title></head>
<body>
<div class="vertical l">EDITORIAL — ADMIN PORTFOLIO — FUNNY JUMP</div>
<div class="vertical r"> Restricted Area — Keep Out — MMXXVI </div>
<div class="sheet"><div class="frame">
  <header>
    <div><div class="kicker">Restricted Area</div>
      <h1>管理室<em>/ Admin.</em></h1></div>
    <div class="head-meta"><span>NO. 001</span><br><span>ACCESS KEY REQUIRED</span></div>
  </header>
  <div class="sub-rule"><span>LEADERBOARD</span><span>ARCHIVE</span><span>STUDIO</span></div>
  <form method="get" style="display:flex;gap:12px;margin-top:clamp(20px,4vw,36px);flex-wrap:wrap">
    <input type="password" name="key" placeholder="Access Key…" autofocus
      style="flex:1;min-width:200px;border:1px solid var(--line);padding:14px 16px;background:rgba(255,255,255,.4)">
    <button class="btn primary">进入 →</button>
  </form>
  <footer><span>© FUNNY JUMP STUDIO</span><span>EST. MMXXVI</span></footer>
</div></div></body></html>`;
}

function adminPageHtml(list){
  const rows = list.map((e, i) => `
    <tr data-i="${i}">
      <td class="idx"><b>${String(i+1).padStart(2,'0')}</b></td>
      <td><input class="f-name" value="${esc(e.anon ? '' : e.name)}" placeholder="Nameless / 匿名"></td>
      <td><input class="f-score" type="number" value="${e.score}"></td>
      <td><input class="f-note" value="${esc(e.note)}"></td>
      <td class="time hide-m">${new Date(e.ts).toLocaleString('zh-CN')}</td>
      <td><button class="del" title="删除此行" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`).join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head>' + A_HEAD + '<title>排行榜管理 · Records</title></head>' + `
<body>
<div class="vertical l">CURATION — RECORDS — ARCHIVE — MMXXVI</div>
<div class="vertical r"> Funny Jump — Leaderboard Console — Vol.01 </div>
<div class="sheet"><div class="frame">
  <header>
    <div><div class="kicker">Leaderboard Archive</div>
      <h1>云端榜单<em>/ Records</em></h1></div>
    <div class="head-meta"><span>TOTAL ${String(list.length).padStart(3,'0')} ENTRIES</span><br><span>EDIT MODE ON</span></div>
  </header>
  <div class="sub-rule"><span>RANK</span><span>NAME / SCORE / NOTE</span><span>ACTION</span></div>
${list.length ? `
<table><thead><tr>
  <th>No.</th><th>Name 名称</th><th>Score 分数</th><th>Note 备注</th><th class="hide-m">Date 日期</th><th>Del</th>
</tr></thead><tbody id="tb">${rows}</tbody></table>` : `
<div class="empty"><p>暂 无 记 录</p><small>EMPTY ARCHIVE — AWAITING FIRST RECORD</small></div>`}
  <div class="bar">
    <button class="btn primary" id="save">保存修改 Save</button>
    <button class="btn" id="reload">放弃 Reload</button>
    <button class="btn danger" id="clearAll">清空全部 Clear All</button>
    <span id="tip"></span>
  </div>
  <div class="bar" style="border-top:1px solid var(--line);padding-top:clamp(12px,2vw,20px)">
    <span class="kicker" style="margin:0">God Mode 无敌测试</span>
    <button class="btn" id="godLaunch" style="border-color:var(--accent);color:var(--accent);font-weight:bold">🛡 启动无敌模式游戏</button>
    <button class="btn" id="godEnd">结束无敌测试</button>
    <span id="godTip" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
  </div>
  <div class="bar" style="border-top:1px solid var(--line);padding-top:clamp(12px,2vw,20px)">
    <span class="kicker" style="margin:0">本机数据诊断</span>
    <button class="btn" id="diagBtn">🔍 检查本机待同步成绩</button>
    <span id="diagTip" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
  </div>
  <footer><span>FUNNY JUMP — LEADERBOARD CONSOLE</span><span id="ftKey"></span></footer>
</div></div>
<script>
const KEY = new URL(location.href).searchParams.get('key');
document.getElementById('ftKey').textContent = 'KEY ' + (KEY ? KEY.slice(0,3) + '····' : '—');
const ORIG_TS = ${JSON.stringify(list.map(e => e.ts))};
function collect(){
  return [...document.querySelectorAll('#tb tr')].map(tr => ({
    name: tr.querySelector('.f-name').value.trim(),
    anon: !tr.querySelector('.f-name').value.trim(),
    score: Math.max(0, Math.floor(Number(tr.querySelector('.f-score').value) || 0)),
    note: tr.querySelector('.f-note').value.trim(),
    ts: ORIG_TS[Number(tr.dataset.i)] || Date.now(),
  }));
}
document.getElementById('save').onclick = async () => {
  const tipEl = document.getElementById('tip');
  tipEl.textContent = 'Saving…';
  try{
    const r = await fetch('/admin/save', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({key: KEY, list: collect()})});
    const j = await r.json();
    tipEl.textContent = j.ok ? 'Saved ✓ ' + j.count + ' ENTRIES' : 'ERROR: ' + (j.error || '');
    if (j.ok) setTimeout(() => location.reload(), 700);
  }catch(e){ tipEl.textContent = 'NETWORK ERROR'; }
};
document.getElementById('reload').onclick = () => location.href = '/admin?key=' + encodeURIComponent(KEY || '');

/* ---- 本机诊断: 检查离线队列里卡住的成绩 ---- */
document.getElementById('diagBtn')?.addEventListener('click', () => {
  const ob = JSON.parse(localStorage.getItem('funGame_outbox_v1') || '[]');
  const lb = JSON.parse(localStorage.getItem('funGame_leaderboard_v1') || '[]');
  const tipEl = document.getElementById('diagTip');
  if (!ob.length){
    tipEl.textContent = '✓ 本机没有卡住的待同步成绩';
    tipEl.style.color = '#2f9e44';
  } else {
    try{
      fetch('/admin/save', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({key: KEY, list: ob})})
        .then(r => r.json())
        .then(j => {
          if (j.ok){
            localStorage.setItem('funGame_outbox_v1', '[]');
            location.reload();
          } else {
            tipEl.textContent = '补传失败: ' + (j.error || '');
            tipEl.style.color = '#e03131';
          }
        });
      tipEl.textContent = '发现 ' + ob.length + ' 条待同步成绩，正在补传…';
    }catch(e){ tipEl.textContent = '读取失败'; }
  }
});
document.getElementById('clearAll').onclick = async () => {
  if (!confirm('确定清空整个云端榜单？不可恢复。')) return;
  await fetch('/admin/clear?key=' + encodeURIComponent(KEY || ''));
  location.href = '/admin?key=' + encodeURIComponent(KEY || '');
};
/* ---- 无敌模式：在管理页内弹出游戏窗口，游戏自动进入无敌状态 ---- */
function godTip(t){ document.getElementById('godTip').textContent = t; }
document.getElementById('godLaunch').onclick = () => {
  localStorage.setItem('funGame_god', '1');
  const w = window.open('/index.html?god=1&t=' + Date.now(), 'godGame',
    'width=980,height=600,left=80,top=60');
  if (!w){
    // 弹窗被拦截：降级为同页 iframe 面板
    openIframeGame();
  } else {
    godTip('已弹出游窗（无敌中）· 关闭游窗或点「结束」即恢复');
  }
  try{ const bc = new BroadcastChannel('funny_jump_admin'); bc.postMessage({type:'god', on:true}); }catch(e){}
};
document.getElementById('godEnd').onclick = () => {
  localStorage.setItem('funGame_god', '0');
  try{ const bc = new BroadcastChannel('funny_jump_admin'); bc.postMessage({type:'god', on:false}); }catch(e){}
  const fw = document.getElementById('godFrameWrap');
  if (fw) fw.remove();
  const w = window.open('', 'godGame');
  if (w && !w.closed) w.close();
  godTip('无敌测试已结束');
};
function openIframeGame(){
  let wrap = document.getElementById('godFrameWrap');
  if (wrap) { wrap.remove(); return; }
  wrap = document.createElement('div');
  wrap.id = 'godFrameWrap';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(28,26,23,.92);display:flex;flex-direction:column';
  wrap.innerHTML =
    '<div style="display:flex;gap:10px;align-items:center;padding:10px 16px;background:var(--accent);color:#f7f3ea">' +
    '<b style="letter-spacing:.2em;font-size:13px">🛡 无敌测试进行中</b>' +
    '<button id="godFrameEnd" style="margin-left:auto;padding:7px 18px;border:none;border-radius:6px;background:#f7f3ea;color:var(--accent);font-weight:bold;cursor:pointer">结束测试</button></div>' +
    '<iframe src="/index.html?god=1" style="flex:1;border:none;width:100%"></iframe>';
  document.body.appendChild(wrap);
  document.getElementById('godFrameEnd').onclick = () => {
    localStorage.setItem('funGame_god', '0');
    wrap.remove();
    godTip('无敌测试已结束');
  };
}
</script></body></html>`;
}
