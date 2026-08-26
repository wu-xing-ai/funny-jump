// 修复: apiGet/apiPost/flushOutbox 支持同源模式(LEADERBOARD_API为空时用相对路径)
const fs = require('fs');
let s = fs.readFileSync('index.html', 'utf8');

// apiGet: 空配置 → 相对路径 /scores
s = s.replace(
`async function apiGet(){
  if (!CFG.LEADERBOARD_API) return [];
  try {
    const r = await fetch(CFG.LEADERBOARD_API.replace(/\\/$/, '') + '/scores?limit=100', { cache: 'no-store' });`,
`function apiBase(){
  return (CFG.LEADERBOARD_API || '').replace(/\\/$/, '');   // 空 = 同源模式
}
async function apiGet(){
  try {
    const r = await fetch(apiBase() + '/scores?limit=100', { cache: 'no-store' });`);

// apiPost: 空配置 → 同样可用
s = s.replace(
`async function apiPost(entry){
  if (!CFG.LEADERBOARD_API) return false;
  try {
    const r = await fetch(CFG.LEADERBOARD_API.replace(/\\/$/, '') + '/scores', {`,
`async function apiPost(entry){
  try {
    const r = await fetch(apiBase() + '/scores', {`);

// flushOutbox: 移除空配置拦截（同源模式也要能补传）
s = s.replace(
`async function flushOutbox(){
  if (!CFG.LEADERBOARD_API) return;
  const box = outboxGet();`,
`async function flushOutbox(){
  if (!CFG.LEADERBOARD_API && !apiBase()) return;   // 双保险：完全未配置任何接口时跳过
  const box = outboxGet();`);

fs.writeFileSync('index.html', s);
console.log('修复完成');
console.log('验证: apiBase出现', (s.match(/apiBase\(\)/g)||[]).length, '次');
