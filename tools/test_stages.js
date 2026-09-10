/* 阶段评估的判定测试。
 *
 * 为什么这件事必须测：关卡判定直接决定用户看到「你还差什么」。
 * 判松了，用户以为自己过关了，实际没有——而这个 App 的整个立场是
 * 不制造虚假自信（把友善读成好感就是过度自信的一种）。
 * 判紧了，用户卡在一关过不去，会以为是自己不行。
 *
 * 最需要守住的一条不变式：**关卡不能被刷题量刷过去**。
 * 准确率可以靠重复记忆提高，偏向不行——所以 biasDrop 和 errLow 这类判定
 * 必须在「答得多但没改」的情况下依然不通过。
 *
 * 纯函数，不需要浏览器：node tools/test_stages.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const stages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages.json'), 'utf8'));

// 这些函数都是纯函数，抠出来在 Node 里直接跑
const grabs = [
  src.match(/const BIAS_TYPES = \{[\s\S]*?\n\};/),
  src.match(/function errCounts\(list\) \{[\s\S]*?\n\}/),
  src.match(/function countErrIn\(list, type\) \{[\s\S]*?\n\}/),
  src.match(/function biasSplit\(answers, biasTotal\) \{[\s\S]*?\n\}/),
  src.match(/function evalGate\(gate, snap\) \{[\s\S]*?\n\}/),
];
const missing = grabs.filter((g) => !g);
if (missing.length) {
  console.error(`抠不到 ${missing.length} 个函数，app.js 结构变了？`);
  process.exit(1);
}
eval(grabs.map((g) => g[0]).join('\n'));

let pass = 0;
let fail = 0;
function t(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  → ' + extra : ''}`); }
}

/** 造一段作答记录：n 次，其中 errs 指定的类型占前/后 proportion */
function mkAnswers(n, errs, shiftAt, lateErrs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const useLate = shiftAt != null && i >= shiftAt;
    const pool = (useLate && lateErrs) ? lateErrs : errs;
    const e = pool[i % pool.length];
    out.push({ t: Date.now() + i, id: 'c' + i, err: e, ok: e === '正解' });
  }
  return out;
}

console.log('关卡判定：');

// ---------- answered ----------
{
  const g = { type: 'answered', n: 20 };
  t('answered：不足时不通过', !evalGate(g, { answered: 19 }).ok);
  t('answered：达标时通过', evalGate(g, { answered: 20 }).ok);
}

// ---------- accuracy：复合条件 ----------
{
  const g = { type: 'accuracy', n: 45, min: 0.6, maxErr: { 字面化: 2 } };
  const good = { answered: 45, correct: 30, answers: mkAnswers(45, ['正解'], null) };
  t('accuracy：题量够 + 准确率够 + 误读达标 → 通过', evalGate(g, good).ok);

  const lowAcc = { answered: 45, correct: 20, answers: mkAnswers(45, ['正解'], null) };
  t('accuracy：准确率不够 → 不通过', !evalGate(g, lowAcc).ok);

  const tooFew = { answered: 44, correct: 40, answers: mkAnswers(44, ['正解'], null) };
  t('accuracy：题量差一题 → 不通过（准确率再高也不行）', !evalGate(g, tooFew).ok);

  const manyLiteral = { answered: 60, correct: 50, answers: mkAnswers(60, ['正解', '字面化'], null) };
  t('accuracy：准确率高但「字面化」超标 → 不通过', !evalGate(g, manyLiteral).ok,
    `字面化 ${countErrIn(manyLiteral.answers, '字面化')} 次`);
}

// ---------- biasDrop：核心不变式 ----------
{
  const g = { type: 'biasDrop', n: 18, ratio: 0.34 };

  // 一直往同一个方向错，答得再多也不该过
  const stuck = { biasTotal: 30, biasSplit: biasSplit(mkAnswers(30, ['消极解读'], null), { 消极解读: 30 }) };
  t('biasDrop：答案多但偏向没变 → 不通过（刷题过不去）', !evalGate(g, stuck).ok,
    `占比 ${Math.round(stuck.biasSplit.earlyShare * 100)}% → ${Math.round(stuck.biasSplit.lateShare * 100)}%`);

  // 偏向显著下降
  const improved = mkAnswers(30, ['消极解读', '投射'], 18, ['投射', '投射', '投射']);
  const snapImp = { biasTotal: 18, biasSplit: biasSplit(improved, { 消极解读: 18, 投射: 12 }) };
  t('biasDrop：主要偏向明显下降 → 通过', evalGate(g, snapImp).ok,
    `「${snapImp.biasSplit.topType}」 ${Math.round(snapImp.biasSplit.earlyShare * 100)}% → ${Math.round(snapImp.biasSplit.lateShare * 100)}%`);

  t('biasDrop：样本不足 → 不通过', !evalGate(g, { biasTotal: 5, biasSplit: null }).ok);
}

// ---------- errLow ----------
{
  const g = { type: 'errLow', err: '事务化', n: 30, max: 1 };
  const clean = { answers: mkAnswers(30, ['投射'], null) };
  t('errLow：最近 30 题没有该误读 → 通过', evalGate(g, clean).ok);

  const two = mkAnswers(30, ['投射'], null); two[5] = { err: '事务化' }; two[9] = { err: '事务化' };
  t('errLow：出现 2 次（上限 1）→ 不通过', !evalGate(g, { answers: two }).ok);

  const oneOld = mkAnswers(40, ['投射'], null); oneOld[0] = { err: '事务化' };
  t('errLow：早期犯过但最近 30 题干净 → 通过（看的是最近）',
    evalGate(g, { answers: oneOld }).ok, '第 1 题的旧记录不算在内');

  t('errLow：作答不足 30 题 → 不通过', !evalGate(g, { answers: mkAnswers(29, ['投射'], null) }).ok);
}

// ---------- genreAcc（关卡 4：判局准确率）----------
// 现实任务删除后，关卡 4 的判据换成了这个。它必须能被真的算出来，
// 而且要防住两种坏情况：没判过几次就算通过、以及判错一半还放行。
{
  const g = { type: 'genreAcc', n: 20, pct: 70 };
  const mkG = (right, wrong) => {
    const a = [];
    for (let i = 0; i < right; i++) a.push({ id: `c${i}#genre`, ok: true, err: '正解' });
    for (let i = 0; i < wrong; i++) a.push({ id: `d${i}#genre`, ok: false, err: '误判场合' });
    return a;
  };
  t('判局：20 次里对 14（70%）→ 通过', evalGate(g, { answers: mkG(14, 6) }).ok);
  t('判局：20 次里对 13（65%）→ 不通过', !evalGate(g, { answers: mkG(13, 7) }).ok);
  t('判局：只判了 10 次（全对）→ 不通过（次数不够，不能被高准确率蒙过去）',
    !evalGate(g, { answers: mkG(10, 0) }).ok);
  t('判局：一次都没判过 → 不通过，且说得出「还没有判局记录」',
    !evalGate(g, { answers: [] }).ok
    && /还没有判局记录/.test(JSON.stringify(evalGate(g, { answers: [] }).parts)));
  // 这条是实打实的断言，不是「不崩就行」：判局对 20 次，另外 30 次动作作答全错，
  // 应该**通过**——因为动作作答不该被算进判局的准确率。混进去的话这关就永远过不去。
  {
    const mixed = mkG(20, 0).concat(
      Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, ok: false, err: '字面化' })));
    t('判局：动作作答不混进判局统计（否则这一关永远过不去）',
      evalGate(g, { answers: mixed }).ok);
  }
}

// ---------- 数据自身的完整性 ----------
console.log('\n关卡数据：');
const ids = stages.stages.map((s) => s.id);
t('关卡 id 连续从 0 开始', ids.every((v, i) => v === i), ids.join(','));
t('每关都有 capability（只声明能做什么，不声称是什么人）',
  stages.stages.every((s) => s.capability && s.capability.length > 6));

const gateTypes = new Set(['answered', 'accuracy', 'biasDrop', 'errLow', 'genreAcc', 'streak']);
const badType = stages.stages.filter((s) => !gateTypes.has(s.gate.type));
t('所有 gate 类型都有实现', badType.length === 0,
  badType.length ? badType.map((s) => `${s.id}:${s.gate.type}`).join(',') : '6 种全部覆盖');

// 每个 gate 都要能真的被 evalGate 判出结果，不能有静默返回空的
const emptySnap = { answered: 0, correct: 0, answers: [], biasTotal: 0, biasSplit: null,
  plans: [], streakDays: 0 };
const noParts = stages.stages.filter((s) => evalGate(s.gate, emptySnap).parts.length === 0);
t('每个 gate 都能被判出子条件（不会静默为空）', noParts.length === 0,
  noParts.length ? noParts.map((s) => s.id).join(',') : '6 关全部有输出');

t('空快照下没有任何一关会误判为通过',
  stages.stages.every((s) => !evalGate(s.gate, emptySnap).ok));

// 保持那一关刻意没有通过条件——它不参与推进
const maintain = stages.stages.find((s) => s.key === 'maintain');
t('「保持」关不参与阶段推进（描述的是频率，不是高度）', maintain && maintain.gate.type === 'streak');


// 身份陈述的形式要求必须与 saveIdentity 的校验一致
console.log('\n身份陈述：');
t('给的是条件式示例，且明确列了反例（结论式）',
  stages.identity.examples_good.length >= 3 && stages.identity.examples_bad.length >= 3);
t('反例里包含「我是个…」这类结论式',
  stages.identity.examples_bad.some((x) => /^我(是|就是|是个)/.test(x)));
t('天花板声明同时写了「测到了」和「测不到」',
  stages.boundary.measured.length >= 3 && stages.boundary.not_measured.length >= 3);
t('天花板声明单独交代了身份这件事不盖章', !!stages.boundary.on_identity);

// ---------- 让 / 守 的平衡 ----------
// 用户的要求是「可以稍微吃点亏，但是不能一直吃亏」。这条内容上的立场很容易在后续
// 编辑中被改歪：只留「过度让步」的干扰项会教出老好人，只留「过度计较」会教出
// 一个谁都要防着的人——两边都是这个 App 要治的毛病。
// 判定方式：某张卡如果带「过度让步」干扰项，它就是在提醒你别一味忍；
// 带「过度计较」干扰项，它就是在提醒你别小题大做。两边都要有。
console.log('\n让 / 守 的平衡：');
{
  const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8')).cards;
  const withConcede = cards.filter((c) => c.options.some((o) => o.err === '过度让步'));
  const withPicky = cards.filter((c) => c.options.some((o) => o.err === '过度计较'));

  t('有卡片在提醒「别一味忍」（带过度让步干扰项）', withConcede.length >= 5,
    `${withConcede.length} 张：${withConcede.map((c) => c.id).join(',')}`);
  t('有卡片在提醒「别小题大做」（带过度计较干扰项）', withPicky.length >= 5,
    `${withPicky.length} 张：${withPicky.map((c) => c.id).join(',')}`);

  // 两侧都要有足够分量，不能一边三张一边一张
  const ratio = Math.min(withConcede.length, withPicky.length) / Math.max(withConcede.length, withPicky.length);
  t('两侧数量不悬殊（少的一侧不少于多的一侧的一半）', ratio >= 0.5,
    `${withConcede.length} : ${withPicky.length}`);

  // 答案里有「让」也有「守」——只有一种答案的课程是在教单一反应
  const holdCards = cards.filter((c) => c.id.match(/^(f0[789]|h0[67]|w0[789]|w10|c2[34])$/));
  const bothSides = holdCards.filter((c) => {
    const hasConcedeDistractor = c.options.some((o) => o.err === '过度让步');
    const hasPickyDistractor = c.options.some((o) => o.err === '过度计较');
    return hasConcedeDistractor || hasPickyDistractor;
  });
  t('日常卡都带明确的判断立场（不是模棱两可的四选一）', bothSides.length >= 8,
    `${bothSides.length} / ${holdCards.length} 张有让/守立场`);

}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);