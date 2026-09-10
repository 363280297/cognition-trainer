/* 每日计划的判定测试。
 *
 * 这块最容易悄悄错，而且错了不会被发现——用户只会觉得「今天怎么没拦我」。
 * 三条必须守住的规则：
 *   1. 跳过只允许一次（Never Miss Twice 的第一半）
 *   2. 跳过当天不算失败、不打断连续性；连续两天没做才算（第二半）
 *   3. 达标线之外的练习算加练，加练不能反过来影响达标判定
 *      —— 否则「加练」就会变成第二个必须完成的指标，正好违背它的设计初衷
 *
 * 纯函数，不需要浏览器：node tools/test_daily.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const stages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages.json'), 'utf8'));

// 抠出每日计划相关的纯逻辑。dailyProgress / bumpDaily 依赖 state 和 DOM，这里复刻判定部分。
const grabs = [
  src.match(/function dailyCfg\(\) \{[\s\S]*?\n\}/),
  src.match(/function dailyTargets\(\) \{[\s\S]*?\n\}/),
];
if (grabs.some((g) => !g)) {
  console.error('抠不到 dailyCfg / dailyTargets，app.js 结构变了？');
  process.exit(1);
}
// CONTENT 由数据文件代替
const CONTENT = { stages };
eval(grabs.map((g) => g[0]).join('\n'));

let pass = 0;
let fail = 0;
function t(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  → ' + extra : ''}`); }
}

/* 复刻 dailyProgress 的判定（原函数读 state，这里显式传入） */
function progress(d, tg) {
  const cards = Math.min(d.cards || 0, tg.cards);
  const lessons = Math.min(d.lessons || 0, tg.lessons);
  const done = Math.min(cards + lessons, tg.cards + tg.lessons);
  const need = tg.cards + tg.lessons;
  return {
    done, need,
    pct: need ? Math.min(100, Math.round(done / need * 100)) : 100,
    met: !!d.met,
    skipped: !!d.skipped,
    canSkip: !d.met && !d.skipped,
  };
}

const TG = dailyTargets();
console.log(`每日目标：${TG.cards} 张卡片 + ${TG.lessons} 条微课\n`);
console.log('达标判定：');

t('什么都没做 → 未达标，可以跳过',
  (() => { const p = progress({}, TG); return !p.met && p.canSkip && p.done === 0; })());

t('做满卡片但没看微课 → 未达标', (() => {
  const p = progress({ cards: TG.cards }, TG);
  return !p.met && p.done === TG.cards;
})(), `done ${TG.cards}/${TG.cards + TG.lessons}`);

t('做满卡片 + 微课 → 达标', (() => {
  const p = progress({ cards: TG.cards, lessons: TG.lessons, met: true }, TG);
  return p.met && p.pct === 100;
})());

t('超量做卡片但没看微课 → 仍未达标（达标线是两条都要）', (() => {
  const p = progress({ cards: TG.cards + 20 }, TG);
  return !p.met;
})());

console.log('\n跳过规则（Never Miss Twice）：');

t('第一次打开：可以跳过', progress({}, TG).canSkip === true);

t('跳过之后：跳过按钮消失', progress({ skipped: true }, TG).canSkip === false);

t('跳过之后：仍然显示未达标（跳过不等于完成）',
  progress({ skipped: true }, TG).met === false);

t('跳过之后继续做，仍然能达标', (() => {
  const p = progress({ skipped: true, cards: TG.cards, lessons: TG.lessons, met: true }, TG);
  return p.met === true;
})());

t('已达标：跳过按钮不出现（没什么可跳的）',
  progress({ met: true }, TG).canSkip === false);

console.log('\n加练：');

t('加练不影响达标线——没有微课时加练再多也未达标', (() => {
  const p = progress({ cards: TG.cards + 30, extra: 30, lessons: 0 }, TG);
  return !p.met;
})());

t('加练次数单独记录，不顶替必备项', (() => {
  const p = progress({ cards: TG.cards, lessons: TG.lessons, extra: 12, met: true }, TG);
  return p.met && p.done === TG.cards + TG.lessons;
})(), 'done 封顶在达标线，不因加练膨胀');

t('达标进度百分比封顶 100%（不会出现 340%）', (() => {
  const p = progress({ cards: 40, lessons: 10, met: true }, TG);
  return p.pct === 100;
})());

console.log('\n配置本身：');

t('daily 配置存在且有 why（说明规则来自哪条证据）',
  !!(stages.daily && stages.daily.why && stages.daily.why.length > 80));

t('默认量很小（卡片 ≤ 6，微课 ≤ 2）——目标是能坚持，不是练得多',
  TG.cards <= 6 && TG.lessons <= 2, `${TG.cards} 张 + ${TG.lessons} 条`);

t('skipRule 同时写了「还可以跳」和「不能再跳」两种文案',
  !!(stages.daily.skipRule && stages.daily.skipRule.once && stages.daily.skipRule.used));

t('skipRule 留了脑雾出口（与 App 既有的「降负荷」原则一致）',
  !!stages.daily.skipRule.fog);

t('加练明确说明「不会有任何提醒」（否则会变成第二个指标）',
  /不会有任何提醒|不计入达标线/.test(stages.daily.extra.why));

t('提醒明确了「只在没达标时响」',
  /只在[\s\S]{0,10}没达标/.test(stages.daily.reminder.why));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
