/**
 * 趣味游戏 · 云端排行榜 Worker（可选组件）
 * ------------------------------------------------
 * 只有想让“所有玩家共享一个榜单”时才需要部署它。
 * 只用本地排行榜的话，忽略这个文件即可。
 *
 * 部署步骤：
 *   1. 安装 wrangler：npm install -g wrangler
 *   2. wrangler login
 *   3. 创建 KV：wrangler kv namespace create LB
 *      把输出的 id 填进 wrangler.toml
 *   4. wrangler deploy
 *   5. 把得到的 workers.dev 地址填进 config.js 的 LEADERBOARD_API
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

    // 简易管理接口：清空榜单（需在 wrangler.toml 配置 ADMIN_KEY）
    if (url.pathname === '/admin/clear' && env.ADMIN_KEY
        && url.searchParams.get('key') === env.ADMIN_KEY) {
      await env.LB.delete('scores');
      return json({ ok: true });
    }

    // 根路径：友好提示（避免浏览器直接访问时看到 404）
    if (url.pathname === '/')
      return json({ service: '趣味游戏 · 云端排行榜', usage: 'GET /scores 拉取榜单, POST /scores 提交成绩' });

    return new Response('Not found', { status: 404, headers: CORS });
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
