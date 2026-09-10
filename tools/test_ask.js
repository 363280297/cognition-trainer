/* 追问计数器的测试。
 *
 * 为什么值得测：这个数字会直接印在每局结束的报告上，而它背后是一个
 * 有实验支持的说法（提问多的人被更喜欢，追问尤其有效）。判错了就是在
 * 用一个看起来精确的数字误导用户，比不显示更糟。
 *
 * 两类追问都要覆盖：
 *   - 字面重合（「李姐为什么打回来」重复了她上一句里的词）
 *   - 回指（「那你当时怎么说的」一个字都没重复，但它显然是追问）
 * 第二类是第一版的漏洞，只认字面重合会把它判成「不是追问」。
 *
 * node tools/test_ask.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'voice.js'), 'utf8');

const qmark = src.match(/const QMARK = [\s\S]*?;/);
const anaphor = src.match(/const ANAPHOR = [\s\S]*?;/);
const bigr = src.match(/function bigrams\(s\) \{[\s\S]*?\n\}/);
if (!qmark || !anaphor || !bigr) {
  console.error('抠不到 QMARK / ANAPHOR / bigrams，voice.js 结构变了？');
  process.exit(1);
}

// 复刻 noteQuestion 的判定（原函数依赖 V.sess，这里只取判定部分）
const judgeFn = eval(`
${qmark[0]}
${anaphor[0]}
${bigr[0]}
function judge(user, her) {
  if (!QMARK.test(user)) return '不是问题';
  let hit = ANAPHOR.test(user);
  if (!hit) {
    const mine = bigrams(user), hers = bigrams(her);
    for (const g of mine) if (hers.has(g)) { hit = true; break; }
  }
  return hit ? '追问' : '提问（但不是追问）';
}
judge
`);

const HER = '今天开会开到六点半，那个方案又被李姐打回来了';
const CASES = [
  // 字面重合型
  ['你那会开到几点', '追问', '重合·时间'],
  ['李姐为什么打回来', '追问', '重合·人物'],
  ['这个方案还要改多久', '追问', '重合·时长'],
  // 回指型——第一版全漏
  ['那你当时怎么说的', '追问', '回指·那你当时'],
  ['后来呢', '追问', '回指·后来呢'],
  ['你刚才说她打回来了？', '追问', '回指·你刚才'],
  ['结果呢', '追问', '回指·结果呢'],
  // 是问题但不是追问
  ['你平时喜欢看电影吗', '提问（但不是追问）', '泛问'],
  ['周末有什么打算', '提问（但不是追问）', '泛问'],
  // 不是问题
  ['我今天也加班了', '不是问题', '陈述'],
  ['嗯', '不是问题', '嗯'],
  ['', '不是问题', '空'],
];

let pass = 0;
let fail = 0;
console.log('追问判定：');
for (const [u, want, label] of CASES) {
  const got = judgeFn(u, HER);
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(14)}` +
    `${JSON.stringify(u).padEnd(24)}-> ${got.padEnd(20)}${ok ? '' : `(期望 ${want})`}`);
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
