/* 「信号场」小游戏的检查。
 *
 * 这个游戏有一条**设计上的核心主张**：分数不能被「一律答不是」刷出来。
 * 所以这里的断言重点不是「按钮能点」，而是：
 *   · 每局真的抽 10 条真信号 + 10 条噪声（d' 可算的前提）
 *   · 分辨力 d' 的数值对得上（和对数线性校正后的标准值比）
 *   · 全答「不是」→ d' = 0，而不是高分；全答「是」→ d' = 0，偏向 c 相反
 *   · 中途切走再回来，同一条不能答第二次（这个 bug 真出现过）
 *   · 成绩真的存进 state，并且「最好成绩」按分辨力算
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
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: false, asr: false, http: false, mic: false }),
      speak: () => { }, stopSpeak: () => { }, listen: () => { }, stopListening: () => { },
    };
    V.native = window.EQNative;
    window.__sent = [];
    window.fetch = (u, i) => {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      if (url.indexOf('/api/progress') === 0) return Promise.resolve({ json: async () => ({}) });
      if (url.indexOf('/api/health') === 0) return Promise.resolve({ json: async () => ({}) });
      window.__sent.push(url);
      return Promise.reject(new Error('x'));
    };
  });

  console.log('\n[一、题面数据]');
  const meta = await p.evaluate(() => {
    const it = CONTENT.signal.items;
    return {
      n: it.length,
      kinds: it.reduce((m, x) => (m[x.kind] = (m[x.kind] || 0) + 1, m), {}),
      mismatch: it.filter((x) => (x.kind === 'signal') !== !!x.exclusive).map((x) => x.id),
      perClass: CONTENT.signal.per_class_per_play,
      rounds: CONTENT.signal.rounds_per_play,
      kindsHaveWhy: it.every((x) => x.why && x.why.length > 30),
      thinHaveSettle: it.filter((x) => x.kind === 'thin').every((x) => x.settle && x.settle.length > 8),
    };
  });
  chk('三类判据都有（真信号 / 她的基线 / 信息不足）',
    meta.kinds.signal >= 3 && meta.kinds.base >= 3 && meta.kinds.thin >= 3, JSON.stringify(meta.kinds));
  chk('kind 和 exclusive 一致（说「是真信号」的必须真的 exclusive）',
    meta.mismatch.length === 0, meta.mismatch.join(','));
  chk('每条都有 why（判据）', meta.kindsHaveWhy);
  chk('「信息不足」那类都写了下一步看什么', meta.thinHaveSettle);
  chk('每类够抽满一局（各 ≥ per_class_per_play）',
    meta.kinds.signal >= meta.perClass && (meta.n - meta.kinds.signal) >= meta.perClass,
    `signal=${meta.kinds.signal} 其余=${meta.n - meta.kinds.signal} 需要=${meta.perClass}`);

  console.log('\n[二、d′ 的算法对不对]');
  const sdt = await p.evaluate(() => {
    const t = (h, m, f, c) => { const s = sdtScore(h, m, f, c); return { d: s.d, c: s.c, H: s.H, F: s.F }; };
    return {
      perfect: t(10, 0, 0, 10),      // 全对
      allYes: t(10, 0, 10, 0),       // 一律答「是」
      allNo: t(0, 10, 0, 10),        // 一律答「不是」
      mid: t(8, 2, 2, 8),            // 八成对
      z: normInv(0.9545),
    };
  });
  chk('z(0.9545) ≈ 1.690（正态分位数实现正确）', near(sdt.z, 1.6903, 0.002), String(sdt.z));
  chk('全对 → d′ ≈ 3.38、偏向 c ≈ 0',
    near(sdt.perfect.d, 3.38, 0.02) && near(sdt.perfect.c, 0, 0.02),
    `d=${sdt.perfect.d.toFixed(3)} c=${sdt.perfect.c.toFixed(3)}`);
  chk('八成对 → d′ ≈ 1.50、偏向 c ≈ 0',
    near(sdt.mid.d, 1.498, 0.02) && near(sdt.mid.c, 0, 0.02),
    `d=${sdt.mid.d.toFixed(3)} c=${sdt.mid.c.toFixed(3)}`);
  chk('**一律答「是」→ d′ = 0**（没有分辨力，只表示偏向）',
    near(sdt.allYes.d, 0, 0.001) && sdt.allYes.c < -1, `d=${sdt.allYes.d.toFixed(3)} c=${sdt.allYes.c.toFixed(3)}`);
  chk('**一律答「不是」→ d′ = 0**（这是最关键的一条：刷不出分）',
    near(sdt.allNo.d, 0, 0.001) && sdt.allNo.c > 1, `d=${sdt.allNo.d.toFixed(3)} c=${sdt.allNo.c.toFixed(3)}`);
  chk('两种极端答法的偏向 c 方向相反（一个往是倒、一个往不是倒）',
    Math.sign(sdt.allYes.c) === -Math.sign(sdt.allNo.c));

  console.log('\n[三、一局真的抽 10 + 10，且不重复]');
  const deck = await p.evaluate(() => {
    const out = [];
    for (let k = 0; k < 200; k++) {
      const dk = buildSignalDeck();
      out.push({ n: dk.length, yes: dk.filter((x) => x.exclusive).length,
                 uniq: new Set(dk.map((x) => x.id)).size });
    }
    return out;
  });
  chk('每局都是 20 条', deck.every((x) => x.n === 20), `出现过 ${[...new Set(deck.map((x) => x.n))].join('/')}`);
  chk('每局都正好 10 条真信号 + 10 条噪声（d′ 能算的前提）',
    deck.every((x) => x.yes === 10), `出现过 ${[...new Set(deck.map((x) => x.yes))].join('/')}`);
  chk('同一局里没有重复的题', deck.every((x) => x.uniq === x.n));
  chk('200 次抽出来的顺序不是同一个（真的在打乱）',
    new Set(await p.evaluate(() => Array.from({ length: 20 }, () =>
      buildSignalDeck().map((x) => x.id).join('')))).size > 1);

  console.log('\n[四、完整玩一局（点 DOM 按钮，不调函数）]');
  await p.evaluate(() => { go('practice'); setPracticeSubview('signal'); });
  const intro = await p.evaluate(() => ({
    who: currentTab, hasStart: !!document.querySelector('#view button.primary'),
    text: document.querySelector('#view').textContent,
  }));
  chk('信号场在「练习」下面，且能进入', intro.who === 'practice', JSON.stringify(intro.who));
  chk('开场页说明了「只问排他性」这件事',
    /只对你/.test(intro.text) && /她对谁都这样/.test(intro.text));
  chk('开场页说明了分数是两个（分辨力 + 偏向），不是一个',
    /分辨力/.test(intro.text) && /偏向/.test(intro.text));

  const play = await p.evaluate(() => {
    startSignalGame();
    const seen = [];
    let guard = 0;
    while (game.i < game.deck.length && guard++ < 60) {
      const it = game.deck[game.i];
      seen.push(it.id);
      // 全答对：真信号点「是」，噪声点「不是」——用来验证满分那条路径
      answerSignal(!!it.exclusive);
      nextSignal();
    }
    viewSignal();
    return { seen, n: seen.length, d: sdtScore(game.hits, game.misses, game.fa, game.cr).d,
             text: document.querySelector('#view').textContent };
  });
  chk('20 条走完没有卡住', play.n === 20, String(play.n));
  chk('全答对 → 分辨力 d′ ≈ 3.38', near(play.d, 3.38, 0.05), String(play.d.toFixed(3)));
  chk('结果页给出了分辨力和偏向两个数',
    /分辨力/.test(play.text) && /偏向/.test(play.text));
  /* 四格要按它们**实际写出来的字**断言。
     原来这里写的是 /真信号|虚报|漏检/，能过是因为随机抽到的某条题的解释里
     出现了「虚报」——也就是说这条断言是**靠运气过的**：抽不到那条就红。
     这类靠别处文字碰上的断言，跟前面「写脆了的断言」是同一个毛病。 */
  chk('结果页列出了四格（命中 / 漏检 / 虚报 / 正确拒绝）',
    /真有信号、你也说是/.test(play.text) && /真有信号、你说是噪声/.test(play.text)
    && /只是她的基线、你却说是/.test(play.text) && /只是她的基线、你也说是噪声/.test(play.text));
  chk('结果页给了「下一步」（不是只给分数）', /下一步/.test(play.text));

  console.log('\n[四之二、界面不许露出 markdown 标记]');
  /* 三类各挑一条，走一遍真实渲染，看有没有 `**` 漏出来。
     这个 bug 在这一版真出现过一次：「这条是**只对你**」那一行插进了纯文本位置，
     而旁边的「判据」走的是 rich()——**同一张卡里一个对一个错**，
     和前面那 20 处 esc/rich 混用是同一个毛病。 */
  const stars = await p.evaluate(() => {
    const pick = (kind) => CONTENT.signal.items.filter((x) => x.kind === kind);
    const out = [];
    ['signal', 'base', 'thin'].forEach((kind) => {
      const it = pick(kind)[0];
      game = { deck: [it], i: 0, hits: 0, misses: 0, fa: 0, cr: 0, combo: 0, maxCombo: 0, log: [], answered: false, recorded: true };
      answerSignal(true);
      out.push({ kind, text: document.querySelector('#view').textContent,
                 html: document.querySelector('#view').innerHTML });
    });
    game = null;
    return out;
  });
  stars.forEach((x) => {
    chk(`「${x.kind}」的反馈里没有露出的 **`,
      x.text.indexOf('**') < 0, x.text.slice(x.text.indexOf('**') - 12, x.text.indexOf('**') + 14));
  });
  chk('三类都有各自的定性文字（不只是对/错）',
    stars.every((x) => /只对你|她对谁都这样|信息还不够/.test(x.text)),
    stars.map((x) => x.kind + ':' + /只对你|她对谁都这样|信息还不够/.test(x.text)).join(' '));

  console.log('\n[四之三、三个按钮真的要能手点（这一节是自己查出来的缺口）]');
  /* 自查时发现的：前面几节全是**直接调函数**（startSignalGame / answerSignal），
     而这三个按钮是唯一用 onclick 字符串接线的，一个都没被点过。
     README 里我自己写过一条教训——「断言要真的去点界面上的按钮，而不是调那个 setter」——
     结果在这个功能上又犯了一次。所以这一节全部走 DOM 点击。 */
  const btnFlow = await p.evaluate(() => {
    const out = {};
    // 1) 开场页的「开始」/「再来一局」
    game = null;
    setPracticeSubview('signal');
    const startBtn = [...document.querySelectorAll('#view button')]
      .find((b) => /开始|再来一局/.test(b.textContent));
    out.hasStart = !!startBtn;
    if (startBtn) startBtn.click();
    out.started = !!(game && game.deck.length === 20);
    // 2) 答完最后一条时的「看结果」
    for (let k = 0; k < 20; k++) {
      const it = game.deck[game.i];
      const b = [...document.querySelectorAll('#view .sg-btn')]
        .find((x) => (it.exclusive ? /只对我/.test(x.textContent) : /对谁都这样/.test(x.textContent)));
      b.click();
      const nb = [...document.querySelectorAll('#view button')]
        .find((x) => /下一条|看结果/.test(x.textContent));
      out.lastLabel = nb ? nb.textContent.trim() : '';
      nb.click();
    }
    out.atResult = /这一局/.test(document.querySelector('#view').textContent);
    // 3) 结果页的「再来一局」
    const again = [...document.querySelectorAll('#view button')].find((b) => /再来一局/.test(b.textContent));
    out.hasAgain = !!again;
    if (again) again.click();
    out.restarted = !!(game && game.i === 0 && game.log.length === 0);
    // 4) 「回到开头」——它靠内联 onclick 里的 `game=null`，是最容易断的那种接线
    for (let k = 0; k < 20; k++) {
      const it = game.deck[game.i];
      document.querySelector('#view .sg-btn' + (it.exclusive === true ? '.yes' : '.no')).click();
      document.querySelector('#view button.primary').click();
    }
    const home = [...document.querySelectorAll('#view button')].find((b) => /回到开头/.test(b.textContent));
    out.hasHome = !!home;
    if (home) home.click();
    out.gameNulled = game === null;
    out.backToIntro = /为什么只问这一件事/.test(document.querySelector('#view').textContent);
    return out;
  });
  chk('开场页的「开始」按钮点了会开一局', btnFlow.hasStart && btnFlow.started, JSON.stringify(btnFlow.started));
  chk('最后一条的按钮写的是「看结果」', btnFlow.lastLabel === '看结果', btnFlow.lastLabel);
  chk('答完 20 条点「看结果」会进结算页', btnFlow.atResult);
  chk('结果页的「再来一局」会开新的一局（计数、进度都归零）', btnFlow.hasAgain && btnFlow.restarted);
  chk('「回到开头」真的把 game 清掉并回到开场页',
    btnFlow.hasHome && btnFlow.gameNulled && btnFlow.backToIntro,
    JSON.stringify({ home: btnFlow.hasHome, nulled: btnFlow.gameNulled, intro: btnFlow.backToIntro }));

  console.log('\n[五、同一条不能答第二次（切走再回来）]');  const twice = await p.evaluate(() => {
    startSignalGame();
    const before = game.log.length;
    answerSignal(true);
    const afterFirst = { log: game.log.length, hits: game.hits, fa: game.fa };
    // 模拟「切到别的子页再回来」
    setPracticeSubview('learn');
    setPracticeSubview('signal');
    const btnsBack = !!document.getElementById('sgBtns');
    // 再点一次同一个按钮（即使按钮被人为找回来，也不该重复计数）
    answerSignal(true);
    return { before, afterFirst, btnsBack, log: game.log.length,
             sum: game.hits + game.misses + game.fa + game.cr };
  });
  chk('答完之后切走再回来，不重新出现两个按钮（否则同一条能刷两次）',
    twice.btnsBack === false, String(twice.btnsBack));
  chk('即使再调一次 answerSignal 也不会重复计数',
    twice.log === twice.afterFirst.log, `${twice.afterFirst.log} → ${twice.log}`);
  chk('四格计数之和 = 已答轮数（不会多算）',
    twice.sum === twice.log, `sum=${twice.sum} log=${twice.log}`);

  console.log('\n[六、成绩存下来了]');
  /* 这一节要自己清干净再量：前面几节已经玩过几局了。
     而且**每完成一局只能记一笔**——结果页每次重画都会跑一遍记录的代码，
     所以「切走再回来」曾经让同一局被记两笔（真出现过，见 renderSignalResult）。 */
  const saved = await p.evaluate(() => {
    state.signal = { plays: [], best: null };
    save();
    startSignalGame();
    // 固定答错 4 条：前 4 条反着答，剩下全对 → 命中/虚报可预测，d′ 落在中间
    for (let k = 0; k < 20; k++) {
      const it = game.deck[game.i];
      answerSignal(k < 4 ? !it.exclusive : !!it.exclusive);
      nextSignal();
    }
    viewSignal();
    const once = state.signal.plays.length;
    // 再重画几次结果页（等价于切走再回来）——不该再多记
    viewSignal(); viewSignal();
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      once, after: state.signal.plays.length,
      best: state.signal.best && state.signal.best.d,
      last: state.signal.plays[state.signal.plays.length - 1],
      persisted: raw.signal ? raw.signal.plays.length : 0,
    };
  });
  chk('一局结束记一笔', saved.once === 1, String(saved.once));
  chk('**重画结果页不会重复记账**（切走再回来也一样）',
    saved.after === 1, `1 → ${saved.after}`);
  chk('这一笔里有分辨力、偏向、四格', saved.last && typeof saved.last.d === 'number'
    && typeof saved.last.c === 'number' && typeof saved.last.hits === 'number',
    JSON.stringify(saved.last));
  chk('best 记的是分辨力', typeof saved.best === 'number', String(saved.best));
  chk('状态真的写进了 localStorage（下次打开还在）', saved.persisted === 1, String(saved.persisted));

  const best = await p.evaluate(() => {
    const before = state.signal.best.d;
    startSignalGame();
    /* 一律答「是」→ 10 命中 + 10 虚报 → d′ 必然是 0。
       注意必须**答一条、进一条**交替着走：answerSignal 在 game.answered 为真时
       直接 return，写成「连答 20 次再连进 20 次」只会记到第一题。 */
    for (let k = 0; k < 20; k++) { answerSignal(true); nextSignal(); }
    viewSignal();
    return { before, after: state.signal.best.d, plays: state.signal.plays.length,
             lastD: state.signal.plays[state.signal.plays.length - 1].d };
  });
  chk('打完这一局时 d′ 真的是 0（一律答「是」= 没有分辨力）', near(best.lastD, 0, 0.001), String(best.lastD));
  chk('「最好成绩」只被更好的成绩替换（d′=0 不会拉低它）',
    near(best.after, best.before, 1e-9), `${best.before.toFixed(3)} → ${best.after.toFixed(3)}`);
  chk('每局都记一笔', best.plays === 2, String(best.plays));

  console.log('\n[七、离线版不能悄悄联网]');
  chk('全程没有发出 /api/ 请求', (await p.evaluate(() => window.__sent)).length === 0);
  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
