// 修复L315: 错误的 "=\" 行尾 → 应为 "+"
const fs = require('fs');
let lines = fs.readFileSync('worker.js', 'utf8').split('\n');
if (lines[314] === '  wrap.innerHTML = \\'){
  lines[314] = '  wrap.innerHTML =';
  fs.writeFileSync('worker.js', lines.join('\n'));
  console.log('FIXED L315');
} else {
  console.log('L315:', JSON.stringify(lines[314]));
}
