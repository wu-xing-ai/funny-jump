/**
 * 趣味游戏 · 主 Worker（静态网站 + 云端排行榜 API 一体）
 * ------------------------------------------------
 * 静态资源由 wrangler.toml 的 [assets] 自动托管；
 * 本脚本只处理排行榜接口，其余路径回落到静态资产：
 *   GET  /scores            拉取榜单（?limit=N，默认50，最大100）
 *   POST /scores            提交成绩 {name, score, note, anon}
 *   GET  /admin/clear?key=  清空榜单（需在配置中设置 ADMIN_KEY）
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const MAX_LIST = 2000; // KV 里最多保留多少条原始记录

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/scores') {
      // 拉取榜单
      if (request.method === 'GET') {
        const q = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
        const limit = Math.min(Math.max(q, 1), 100);
        const list = (await env.LB.get('scores', 'json')) || [];
        return json(list.sort((a, b) => b.score - a.score).slice(0, limit));
      }
      // 提交成绩
      if (request.method === 'POST') {
        let b = {};
        try { b = await request.json(); } catch (e) { /* 忽略 */ }
        const entry = sanitize(b);
        if (!entry) return json({ error: 'bad request' }, 400);
        const list = (await env.LB.get('scores', 'json')) || [];
        list.push(entry);
        await env.LB.put('scores', JSON.stringify(list.slice(-MAX_LIST)));
        return json({ ok: true });
      }
    }

    // 管理接口：清空榜单（需在配置中设置 ADMIN_KEY）
    if (url.pathname === '/admin/clear' && env.ADMIN_KEY
        && url.searchParams.get('key') === env.ADMIN_KEY) {
      await env.LB.delete('scores');
      return json({ ok: true });
    }

    // 管理页：浏览器里可视化编辑/删除单条记录
    if (url.pathname === '/admin' && env.ADMIN_KEY) {
      if (url.searchParams.get('key') !== env.ADMIN_KEY)
        return new Response(adminLoginHtml(), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
      const list = (await env.LB.get('scores', 'json')) || [];
      return new Response(adminPageHtml(list), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/admin/save' && request.method === 'POST' && env.ADMIN_KEY) {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      if (b.key !== env.ADMIN_KEY) return json({ error: '密码错误' }, 403);
      const arr = Array.isArray(b.list) ? b.list : null;
      if (!arr) return json({ error: 'bad list' }, 400);
      const clean = arr.map(sanitize).filter(Boolean).sort((a, b2) => b2.score - a.score);
      await env.LB.put('scores', JSON.stringify(clean));
      return json({ ok: true, count: clean.length });
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
  return {
    name: anon ? '' : rawName,
    anon,
    score,
    note: String(b.note ?? '').slice(0, 60).trim(),
    ts: Date.now(),
  };
}

/* ---------- 管理页（浏览器可视化编辑） ---------- */
function esc(s){
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function adminLoginHtml(){
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>排行榜管理 · 登录</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;padding-top:15vh;background:#f5f0e6}
.box{background:#fff;border-radius:16px;padding:30px;box-shadow:0 8px 24px rgba(0,0,0,.12);text-align:center}
input{padding:10px;font-size:16px;border:2px solid #ffd93d;border-radius:8px;width:240px}
button{padding:10px 26px;margin-left:8px;border:none;border-radius:8px;background:#7048e0;color:#fff;font-size:15px;cursor:pointer}</style></head>
<body><div class="box"><h2>🔐 排行榜管理</h2><p>请输入管理员密码</p>
<form method="get"><input type="password" name="key" placeholder="ADMIN_KEY" autofocus>
<button>进入</button></form></div></body></html>`;
}
function adminPageHtml(list){
  const rows = list.map((e, i) => `
    <tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input class="f-name" value="${esc(e.anon ? '' : e.name)}" placeholder="(匿名)"></td>
      <td><input class="f-score" type="number" value="${e.score}"></td>
      <td><input class="f-note" value="${esc(e.note)}"></td>
      <td>${new Date(e.ts).toLocaleString('zh-CN')}</td>
      <td><button class="del" onclick="this.closest('tr').remove()">删除</button></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>排行榜管理</title>
<style>
body{font-family:system-ui;background:#f5f0e6;margin:20px}
h1{color:#7048e0} table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.08)}
th,td{padding:9px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:left}
th{background:#efe7ff;color:#5f3dc4}
input{width:95%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:14px}
.f-score{width:70px}.del{background:#ff5d8f;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer}
.bar{display:flex;gap:10px;margin:14px 0} .bar button{padding:10px 22px;border:none;border-radius:8px;font-size:15px;cursor:pointer}
#save{background:#40c057;color:#fff} #reload{background:#868e96;color:#fff}
#tip{margin-left:auto;align-self:center;font-weight:bold;color:#2f9e44}
tr:hover{background:#faf6ff}
@media(max-width:700px){.hide-m{display:none}}
</style></head><body>
<h1>🏆 云端排行榜管理</h1>
<table><thead><tr><th>#</th><th>名字(空=匿名)</th><th>分数</th><th>备注</th><th class="hide-m">时间</th><th>操作</th></tr></thead>
<tbody id="tb">${rows}</tbody></table>
<div class="bar">
  <button id="save">💾 保存全部修改</button>
  <button id="reload">↩ 放弃修改并刷新</button>
  <a href="/admin/clear?key=${encodeURIComponent(new URL(location.href).searchParams.get('key'))}"
     onclick="return confirm('确定清空整个云端榜单吗？')"><button style="background:#fa5252;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:15px;cursor:pointer">🗑 清空全部</button></a>
  <span id="tip"></span>
</div>
<script>
const KEY = new URL(location.href).searchParams.get('key');
document.getElementById('save').onclick = async () => {
  const list = [...document.querySelectorAll('#tb tr')].map(tr => ({
    name: tr.querySelector('.f-name').value.trim(),
    anon: !tr.querySelector('.f-name').value.trim(),
    score: Math.floor(Number(tr.querySelector('.f-score').value) || 0),
    note: tr.querySelector('.f-note').value.trim(),
    ts: Number('${esc(JSON.stringify(list.map(e => e.ts)))}' ? ORIG_TS[tr.dataset.i] || Date.now() : Date.now()),
  }));
  const r = await fetch('/admin/save', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({key: KEY, list})});
  const j = await r.json();
  document.getElementById('tip').textContent = j.ok ? '已保存 ✓ (' + j.count + ' 条)' : '失败: ' + (j.error||'');
  if (j.ok) setTimeout(() => location.reload(), 800);
};
const ORIG_TS = ${JSON.stringify(list.map(e => e.ts))};
document.getElementById('reload').onclick = () => location.reload();
</script></body></html>`;
}
