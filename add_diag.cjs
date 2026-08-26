// 给手机端用户一个自助补传入口 + 管理页也能看到outbox状态
// 方案: 管理页新增"补传检查"按钮, 读取同浏览器localStorage的outbox并flush
const fs = require('fs');
let s = fs.readFileSync('worker.js', 'utf8');

// 在管理页god mode区域后追加补传按钮
const oldBar = `    <span id="godTip" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
  </div>`;
const newBar = `    <span id="godTip" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
  </div>
  <div class="bar" style="border-top:1px solid var(--line);padding-top:clamp(12px,2vw,20px)">
    <span class="kicker" style="margin:0">本机数据诊断</span>
    <button class="btn" id="diagBtn">🔍 检查本机待同步成绩</button>
    <span id="diagTip" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
  </div>`;

if (s.includes(oldBar)){
  s = s.replace(oldBar, newBar);
  // 在script末尾(clearAll handler后)加诊断逻辑
  const anchor = `document.getElementById('clearAll').onclick`;
  const diagCode = `
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
});`;
  s = s.replace(anchor, diagCode + '\n' + anchor);
  fs.writeFileSync('worker.js', s);
  console.log('✓ 管理页已加入「检查本机待同步成绩」按钮');
} else {
  console.log('✗ 未找到插入点');
}
