// 精确诊断: 打印文件末尾每行的字符码
const fs = require('fs');
const lines = fs.readFileSync('worker.js', 'utf8').split('\n');
console.log('总行数:', lines.length);
for (let i = lines.length - 5; i < lines.length; i++){
  const l = lines[i];
  let codes = [];
  for (const c of l) codes.push(c.charCodeAt(0));
  console.log('L' + (i+1) + ':', JSON.stringify(l), '→ codes:', codes.join(','));
}
