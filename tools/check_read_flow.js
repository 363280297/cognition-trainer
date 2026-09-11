/* 「读局」「偏重出题」两项新机制 +「今日复盘已删干净」的检查。
 *
 * 各件事的来源：
 *
 * 1. 判局那一步（读局卡）——用户说「训练我说话之前思考，我经常说话不动脑子」。
 *    证据约束：Wilkinson（1975）把冲动的孩子分纯延迟训练、语言自我指导、对照三组，
 *    两组反应延迟都变长，但**只有语言自我指导那一组的错误减少**。
 *    所以「停一下」没用，停顿里那一步才有用——这一步就被做成了**必须走过**的关口。
 *    要验的是：选项在判局之前真的出不来（否则这一步就白做了）。
 *
 * 2. 偏重出题——用户要「根据每日的答题情况调整下一次的出题方向，有偏重」。
 *    要验三件事：样本太小时不偏（不放大噪声）、有数据时真的偏、以及**不是只出弱项**
 *    （只出弱项会把它和惩罚绑在一起，其他类型也会永远没数据）。
 *
 * 3. 今日复盘——用户后来要求删掉。这里改成验「删干净了」，并且验换人称那条边界
 *    还留在微课里（功能可以删，两边都有的那条证据不该跟着消失）。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    go('practice'); setPracticeSubview('cards');
  });

  // ---------------------------------------------------------------- 判局
  console.log('\n[判局：这一步真的挡在选项前面]');
  const gate = await p.evaluate(() => {
    const card = CONTENT.cards.cards.find((c) => c.genre);
    session.queue = [card]; session.i = 0; session.genrePick = null;
    renderCard();
    const opts = document.getElementById('opts');
    const step = document.getElementById('genreStep');
    return {
      id: card.id, genre: card.genre,
      optsHidden: opts ? opts.style.display === 'none' : null,
      optsVisibleWidth: opts ? opts.getBoundingClientRect().width : -1,
      hasStep: !!step,
      buttons: [...document.querySelectorAll('#genreStep .genre-btn')].map((x) => x.textContent.trim()),
      genreInButtons: [...document.querySelectorAll('#genreStep .genre-btn')]
        .some((x) => x.textContent.trim() === card.genre),
    };
  });
  chk('读局卡有判局步骤', gate.hasStep);
  chk('判局之前选项被藏起来（否则这一步白做）', gate.optsHidden === true);
  chk('可点选项里包含这张卡的标准答案', gate.genreInButtons, gate.genre);
  chk('八个可点选项都在', gate.buttons.length === 8, gate.buttons.join('/'));

  const afterPick = await p.evaluate(() => {
    const card = CONTENT.cards.cards.find((c) => c.genre);
    const btn = [...document.querySelectorAll('#genreStep .genre-btn')]
      .find((x) => x.textContent.trim() === card.genre);
    btn.click();
    const opts = document.getElementById('opts');
    const clueStep = document.getElementById('clueStep');
    return {
      // 2.37 起：判完局**还看不到**动作选项，得先指一句依据
      optsShownAfterGenre: opts.style.display !== 'none',
      clueShown: clueStep ? clueStep.style.display !== 'none' : false,
      clueCount: clueStep ? clueStep.querySelectorAll('.genre-btn').length : 0,
      pick: session.genrePick,
      marked: !!document.querySelector('#genreStep .genre-btn.picked'),
      // 只数判局那一组：.genre-btn 现在也用在「指依据」那一步上，
      // 用全局选择器会把依据那组的按钮一起算进来（它们这时还没被点，自然没有 disabled）
      othersDisabled: [...document.querySelectorAll('#genreStep .genre-btn')].every((x) => x.disabled),
    };
  });
  chk('判完局还看不到动作选项（必须先指一句依据）', afterPick.optsShownAfterGenre === false);
  chk('判完局出现了「指依据」那一步', afterPick.clueShown && afterPick.clueCount >= 3,
    `依据 ${afterPick.clueCount} 条`);
  chk('判的选择被记住', !!afterPick.pick, afterPick.pick);
  chk('选中的那个被标记、其余全部禁用（不能改）',
    afterPick.marked && afterPick.othersDisabled);

  const afterClue = await p.evaluate(() => {
    const card = CONTENT.cards.cards.find((c) => c.genre);
    const i = (card.clues || []).findIndex((x) => x.ok);
    document.querySelectorAll('#clueStep .genre-btn')[i].click();
    const opts = document.getElementById('opts');
    return {
      shown: opts.style.display !== 'none',
      pick: session.cluePick,
      disabled: [...document.querySelectorAll('#clueStep .genre-btn')].every((x) => x.disabled),
    };
  });
  chk('指完依据才放出动作选项', afterClue.shown);
  chk('依据的选择被记住', typeof afterClue.pick === 'number' && afterClue.pick >= 0,
    String(afterClue.pick));
  chk('依据那组选完也全部禁用', afterClue.disabled);

  // 判错要记进「误判场合」，且跟动作作答分开记
  const wrongGenre = await p.evaluate(() => {
    const before = biasTotal();
    const card = CONTENT.cards.cards.find((c) => c.genre && c.genre !== '纯闲聊');
    session.queue = [card]; session.i = 0; session.genrePick = null; session.cluePick = null;
    renderCard();
    const bad = [...document.querySelectorAll('#genreStep .genre-btn')]
      .find((x) => x.textContent.trim() === '纯闲聊');
    bad.click();
    // 依据故意指一条**对的**：这样「没达标」只会由判局那一项造成，
    // 不会和依据指错混在一起（2.37 起依据也要算对）
    const ci = (card.clues || []).findIndex((x) => x.ok);
    if (ci >= 0) document.querySelectorAll('#clueStep .genre-btn')[ci].click();
    answerCard(card.best);           // 动作选对，只有判局错了
    const answers = state.answers.slice(-3);
    return {
      biasGained: biasTotal() - before,
      misjudged: (state.bias['误判场合'] || 0),
      ids: answers.map((a) => a.id),
      errs: answers.map((a) => a.err),
      verdict: (document.querySelector('.genre-verdict') || {}).textContent || '',
    };
  });
  chk('判错会记进「误判场合」', wrongGenre.biasGained >= 1 && wrongGenre.misjudged >= 1,
    `+${wrongGenre.biasGained}`);
  // 2.37 起是三笔：判局 / 依据 / 动作，各记一条（混成一条就分不出他缺哪一半）
  chk('判局 / 依据 / 动作三笔分开记（不混成一条）',
    wrongGenre.ids.some((i) => i.endsWith('#genre')) &&
    wrongGenre.ids.some((i) => i.endsWith('#clue')) &&
    wrongGenre.ids.some((i) => !i.includes('#')),
    wrongGenre.ids.some((i) => !i.endsWith('#genre')),
    wrongGenre.ids.join(' , '));
  chk('反馈里给出「你判的局 vs 这局其实是」', /这局其实是/.test(wrongGenre.verdict),
    wrongGenre.verdict.replace(/\s+/g, ' ').slice(0, 40));
  const goodGenre = await p.evaluate(() => {
    const card = CONTENT.cards.cards.find((c) => c.genre);
    session.queue = [card]; session.i = 0; session.genrePick = null;
    renderCard();
    [...document.querySelectorAll('#genreStep .genre-btn')]
      .find((x) => x.textContent.trim() === card.genre).click();
    answerCard(card.best);
    return (document.querySelector('.genre-verdict') || {}).textContent || '';
  });
  chk('判对时显示判对了', /判对了/.test(goodGenre), goodGenre.replace(/\s+/g, ' ').slice(0, 30));

  // ------------------------------------------------------------ 偏重出题
  console.log('\n[偏重出题：样本小不偏、有数据才偏、且不只是弱项]');
  const w = await p.evaluate(() => {
    const fresh = () => { state.bias = {}; state.stats.wrongIds = []; };
    // 样本太小 → 不偏
    fresh();
    state.bias['误判场合'] = 3;
    const small = biasFocus();
    // 有数据 → 偏，且只取最高的一档
    state.bias = { '误判场合': 8, '该停不停': 3, '消极解读': 1 };
    const big = biasFocus();
    // 权重：命中弱项的卡更重，做错过的更重
    const hit = CONTENT.cards.cards.find((c) => c.options.some((o) => o.err === '误判场合'));
    const miss = CONTENT.cards.cards.find((c) => !c.options.some((o) => o.err === '误判场合'));
    const wHit = cardWeight(hit, big), wMiss = cardWeight(miss, big);
    // 加权随机仍然能取到非弱项（不是硬筛）
    const pool = CONTENT.cards.cards.slice();
    let sawMiss = false;
    for (let i = 0; i < 200 && !sawMiss; i++) {
      if (weightedPick(pool, 6, big).some((c) => c.id === miss.id)) sawMiss = true;
    }
    // 一组里不重复出同一张卡
    const one = weightedPick(pool, 6, big);
    fresh();
    return {
      small, big, wHit, wMiss, sawMiss,
      distinct: new Set(one.map((c) => c.id)).size === one.length,
    };
  });
  chk('样本不足 6 次时不偏重（不放大噪声）', w.small.length === 0, `${w.small.length}`);
  chk('有数据时按最高一档偏重', w.big.join('/'), w.big.join('/'));
  chk('命中弱项的卡权重更高', w.wHit > w.wMiss, `${w.wHit} > ${w.wMiss}`);
  chk('不是硬筛——非弱项仍然会被选中', w.sawMiss);
  chk('同一组里不重复出同一张卡', w.distinct);

  const focusUi = await p.evaluate(() => {
    state.bias = { '误判场合': 8, '该停不停': 6 };
    const card = CONTENT.cards.cards[0];
    session.queue = [card]; session.i = 0; renderCard();
    const bar = document.querySelector('.focus-bar');
    return { text: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : '' };
  });
  chk('界面上说明了「为什么最近偏重这类」', /偏重出题/.test(focusUi.text),
    focusUi.text.slice(0, 54));

  // ------------------------------------------------------- 今日复盘（已删）
  // 用户要求删掉这一项。删干净的意思是：代码、状态、界面文本、样式，一处不剩。
  // 「换人称」那条边界没有丢——它在微课 p33.warn 里（那条证据是两边都有的，
  // 见课程里 Giovanetti 2019 与 Kross & Ayduk 2009 的对照）。
  console.log('\n[今日复盘已删干净]');
  const gone = await p.evaluate(() => {
    go('today');
    const txt = (document.querySelector('#view').textContent || '');
    return {
      inText: txt.indexOf('今日复盘') >= 0,
      inFn: typeof window.todayReview !== 'undefined' || typeof window.reviewCard !== 'undefined' ||
            typeof window.saveReview !== 'undefined',
      inState: Object.prototype.hasOwnProperty.call(state, 'reviews'),
      inDom: !!document.querySelector('.review-card, .review-past, #reviewText, #reviewMsg'),
      whyBlock: !!document.querySelector('.why-block'),
    };
  });
  chk('今天页上没有复盘卡', !gone.inText && !gone.inDom);
  chk('函数删了（不是只把界面藏起来）', !gone.inFn);
  chk('状态里也没有 reviews 了', !gone.inState);
  chk('样式类一起清了（.why-block / .review-past 留一个都是残留）', !gone.whyBlock);
  const p33 = await p.evaluate(() => {
    let out = '';
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (typeof o.warn === 'string' && /换人称|第三人称/.test(o.warn)) out = o.warn;
      Object.keys(o).forEach((k) => walk(o[k]));
    })(CONTENT.curriculum);
    return out;
  });
  chk('换人称那条边界还在微课里（删功能不等于丢知识）',
    /Giovanetti/.test(p33) && /Kross/.test(p33) && /状态很差的那几天别写|漏几天没有代价/.test(p33),
    `${p33.length} 字`);

  chk('无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
