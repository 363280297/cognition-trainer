/* 预案表述校验的单元测试。
 *
 * 为什么这个值得单独测：用户写下的「我就……」会被这几条规则拦下来重写，
 * 规则错了有两种代价——拦太松，用户存进去一堆背不住的台词；
 * 拦太紧，用户点「照着改」再保存会被自己的 App 顶回来。
 * 所以既测规则本身，也测 36 条种子预案必须全部能通过。
 *
 * 纯函数，不需要浏览器：node tools/test_plan.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// 从 app.js 里抠出校验相关的声明和函数——它们是纯函数，可以直接在 Node 里跑
const parts = [
  src.match(/const PROHIBIT = \[[\s\S]*?\];/),
  src.match(/const SCRIPTY = [\s\S]*?;/),
  src.match(/function planProblem\(then\) \{[\s\S]*?\n\}/),
];
if (parts.some((p) => !p)) {
  console.error('抠不到 PROHIBIT / SCRIPTY / planProblem，app.js 结构变了？');
  process.exit(1);
}
eval(parts.map((p) => p[0]).join('\n'));

const cases = [
  // [输入, 是否应该通过, 说明]
  ['不要急着给她讲道理', false, '禁止式·不要'],
  ['别辩解', false, '禁止式·别'],
  ['忍住不说话', false, '禁止式·忍住'],
  ['我就说想吃啥就吃啥', false, '台词·就说'],
  ['我直接说一句你先忙', false, '台词·说一句'],
  ['跟她讲一句我理解你', false, '台词·讲一句'],
  ['我就跟她说，你别多想', false, '台词·跟她说'],
  ['我就说', false, '台词·就说（带标点）'],
  ['先复述一遍再问她我理解得对不对', true, '合格·复述+确认'],
  ['先给两个具体选项让她挑，她不挑我就定一家', true, '合格·给选项'],
  ['保持耐心', false, '空话'],
  ['注意沟通', false, '空话'],
  ['好好回应她', false, '空话'],
  ['多关心她', false, '空话'],
  ['', false, '空'],
  ['   ', false, '空白'],
  ['a'.repeat(61), false, '超长'],
  ['先问她今天最累的是哪件事', true, '合格·问具体的事'],
];

let pass = 0;
let fail = 0;
console.log('预案表述校验：');
for (const [input, wantOk, label] of cases) {
  const prob = planProblem(input);
  const ok = prob === null;
  const good = ok === wantOk;
  if (good) pass++; else fail++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label.padEnd(16)}` +
    `${JSON.stringify(input.length > 24 ? input.slice(0, 22) + '…' : input).padEnd(28)}` +
    `->  ${prob ? prob.slice(0, 26) : '通过'}`);
}

// 种子预案必须全部通过，否则用户点「照着改」再保存会被自己拦住
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
let seedFail = 0;
for (const c of data.cards) {
  const p = planProblem(c.plan.then);
  if (p) {
    console.log(`  FAIL  种子 ${c.id} 通不过自己的校验：${p.slice(0, 30)}`);
    console.log(`        ${c.plan.then}`);
    seedFail++;
  }
}
console.log(`\n  种子预案 ${data.cards.length} 条，通不过的：${seedFail}`);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail + seedFail ? 1 : 0);
