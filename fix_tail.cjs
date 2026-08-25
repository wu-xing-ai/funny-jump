// L279的 `; 是多余的(它本应属于redesign脚本写入语句,被误保留)
// 删除L279整行: "`;"
const fs = require('fs');
let lines = fs.readFileSync('worker.js', 'utf8').split('\n');
const BT = String.fromCharCode(96);
if (lines[278] === BT + ';'){
  lines.splice(278, 1);
  fs.writeFileSync('worker.js', lines.join('\n'));
  console.log('已删除多余反引号行, 总行数:', lines.length);
} else {
  console.log('L279:', JSON.stringify(lines[278]));
}
