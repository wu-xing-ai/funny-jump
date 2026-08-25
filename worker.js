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

    // 管理接口：清空榜单（需在 wrangler.toml 配置 ADMIN_KEY）
    if (url.pathname === '/admin/clear' && env.ADMIN_KEY
        && url.searchParams.get('key') === env.ADMIN_KEY) {
      await env.LB.delete('scores');
      return json({ ok: true });
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
