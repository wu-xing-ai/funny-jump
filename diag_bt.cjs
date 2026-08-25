// L280是空行但esbuild报280:0未终止字符串
// 说明前面某处的反引号数量为奇数。全文扫描反引号计数:
const fs = require('fs');
const src = fs.readFileSync('worker.js', 'utf8');
let inStr = null, inTemplate = false, templateStack = [];
let line = 1;
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const SQ = String.fromCharCode(39), DQ = String.fromCharCode(34);
for (let i = 0; i < src.length; i++){
  const c = src[i];
  if (c === '\n') line++;
  if (c === BS){ i++; continue; }
  if (inStr){
    if (c === inStr) inStr = null;
    continue;
  }
  if (c === SQ || c === DQ){ inStr = c; continue; }
  if (c === BT){ inTemplate = !inTemplate; console.log('L' + line + ': 反引号 → ' + (inTemplate ? 'OPEN' : 'CLOSE')); }
}
console.log('最终模板状态:', inTemplate ? '未闭合!' : '正常');
