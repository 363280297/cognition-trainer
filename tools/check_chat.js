/* 闲聊「球在谁手里」的检查。
 *
 * 用户的要求：「要查阅资料，要锻炼我闲聊的能力，加一些案例或者说游戏」。
 *
 * 这一局和现有的 84 张卡有一个本质区别，也是这个文件最该钉住的东西：
 * **卡是单发的**（选完就结束），而这一局里你选什么、对方下一句就变。
 * 所以这里最重要的一条断言是「选不同的句子 → 对方的回应真的不同」。
 * 如果哪天有人把它改回「不管选什么下一句都一样」，这一局就退化成了普通选择题，
 * 而**界面上完全看不出来**——正是那种要靠断言才守得住的东西。
 *
 * 另外两条也是「机制有没有真的发生」，不是「DOM 在不在」：
 *   · 选项上不许提前暴露动作名字（先标名字等于送答案，练不到任何东西）；
 *   · 结局必须由「一个场合里保住了几个球」决定，不是随便给一段话。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const DATA = path.join(__dirname, '..', 'data', 'chat.json');

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  // ---------------------------------------------------------- 内容层
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const MOVE_KEYS = (d.moves || []).map((m) => m.key);
  const KEEP = (d.moves || []).filter((m) => m.keep).map((m) => m.key);

  console.log('[内容结构]');
  chk('每个场合 3 句、每句 3 个选项', (d.cases || []).every((c) =>
    c.steps.length === 3 && c.steps.every((s) => s.choices.length === 3)),
    `${d.cases.length} 个场合`);
  chk('同一个选项组里不出现两个同类动作（否则是重复选项）',
    d.cases.every((c) => c.steps.every((s) =>
      new Set(s.choices.map((x) => x.move)).size === 3)));
  chk('动作名都是图例里定义过的那几种',
    d.cases.every((c) => c.steps.every((s) => s.choices.every((x) => MOVE_KEYS.includes(x.move)))),
    MOVE_KEYS.join('/'));
  chk('每一步的 keep 标记和图例一致（不能自己另立一套对错）',
    d.cases.every((c) => c.steps.every((s) => s.choices.every((x) =>
      x.keep === KEEP.includes(x.move)))));
  chk('三种结局都写了', d.cases.every((c) =>
    ['all', 'some', 'few'].every((k) => (c.endings[k] || {}).text)));
  chk('每个选项都写了为什么', d.cases.every((c) =>
    c.steps.every((s) => s.choices.every((x) => (x.why || '').length > 20))));
  chk('第 1 步的两种分支写的一致（开场只有一个，不能分岔）',
    d.cases.every((c) => JSON.stringify(c.steps[0].ask.keep) === JSON.stringify(c.steps[0].ask.drop)
      && JSON.stringify(c.steps[0].ask.keep) === JSON.stringify(c.open)));
  /* 第 2 步起，两条分支必须真的不同——这是「你选什么他就怎么回」的数据侧保证。
     注意第 1 步是例外：那时候还没有你的上一句可选，所以两条分支就是同一段开场。

     （这一条我第一版写错了：要求**每一步**的 keep/drop 都不同，于是第 1 步必然失败。
     断言把我自己的错误抓出来了，但错的是断言不是数据——所以这里要写清为什么第 1 步例外。） */
  chk('第 2 步起，两条分支的下一句真的不同（对方的回应跟着你变）',
    d.cases.every((c) => c.steps.slice(1).every((s) =>
      (s.ask.keep || []).length && (s.ask.drop || []).length
      && JSON.stringify(s.ask.keep) !== JSON.stringify(s.ask.drop))),
    '这一局的核心机制');
  chk('依据和它的边界都在（查阅资料那部分）',
    (d.evidence || []).length >= 3 && (d.caveat || '').length > 40,
    `${(d.evidence || []).length} 条依据`);

  // ---------------------------------------------------------- 机制层
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

  console.log('\n[说明页：依据要看得见，不能只在数据里]');
  const intro = await p.evaluate(() => {
    chatGame = null;
    go('practice'); setPracticeSubview('chat');
    const t = document.getElementById('view').textContent;
    return {
      hasMoves: t.includes('抢球') && t.includes('追问'),
      hasEvidence: t.includes('Huang') || t.includes('Boothby'),
      hasCaveat: t.includes('勘误'),
      movesShown: (CONTENT.chat.moves || []).filter((m) => t.includes(m.name)).length,
    };
  });
  chk('六种动作都列出来了', intro.movesShown === 6, `${intro.movesShown}/6`);
  chk('研究依据写在页面上（不是只躺在 json 里）', intro.hasEvidence);
  chk('证据的边界也写在页面上（含那份勘误）', intro.hasCaveat);

  /* 核心机制：选不同的句子，对方的回应必须不同。
     这一条要是破了，这一局就只是「换个皮的选择题」，而且看不出来。 */
  console.log('\n[核心机制：你选什么，他就怎么回]');
  const branch = await p.evaluate(() => {
    const c = CONTENT.chat.cases[0];
    const run = (stepIdx, wantKeep) => {
      // 用真的开始入口建状态，再把题目换成固定的那一案——
      // 手写一个对象字面量容易漏字段（我第一版就漏了 picks，answerChat 直接炸）。
      startChatGame();
      chatGame.queue = [c];
      chatGame.i = 0;
      // 先按 keep/drop 把前几步走完，再看这一步的下一句
      for (let s = 0; s < stepIdx; s++) {
        const ch = c.steps[s].choices.find((x) => x.keep === true);
        chatGame.step = s; answerChat(c.steps[s].choices.indexOf(ch)); nextChatStep();
      }
      chatGame.step = stepIdx; chatGame.picked = null; renderChatStep();
      const opts = [...document.querySelectorAll('#view .opts .opt')].map((x) => x.textContent.trim());
      const movesInOpts = CONTENT.chat.moves.filter((m) => opts.join(' ').includes(m.name)).map((m) => m.name);
      const idx = c.steps[stepIdx].choices.findIndex((x) => x.keep === wantKeep);
      answerChat(idx);
      const next = (document.getElementById('chatNext') || {}).textContent || '';
      return { opts, movesInOpts, next: next.replace(/\s+/g, ' ').trim() };
    };
    const keep = run(0, true);
    const drop = run(0, false);
    return { keep, drop, sameLen: keep.next === drop.next };
  });
  chk('选项上不提前暴露动作名字（先看名字=送答案）',
    branch.keep.movesInOpts.length === 0, branch.keep.movesInOpts.join('/') || '干净');
  chk('选项数字对得上', branch.keep.opts.length === 3, `${branch.keep.opts.length} 个`);
  chk('选「保住球」和「掉了球」→ 对方的下一句不一样',
    branch.keep.next !== branch.drop.next,
    `keep: ${branch.keep.next.slice(0, 26)}… / drop: ${branch.drop.next.slice(0, 26)}…`);

  /* 把「对方的话跟着你变」逐条核到**每一个场合、每一步**上。
     原来这里写的是「掉球之后对方的话更短」——那条太弱也太巧：长短是我写内容时的
     副产品，不是这个机制的判据。真正的判据是：屏幕上显示的那一句，
     必须等于数据里对应该分支的那一句。这样才能挡住「两个分支都渲染成同一个」。 */
  const wired = await p.evaluate(() => {
    const bad = [];
    (CONTENT.chat.cases || []).forEach((c) => {
      for (let s = 0; s + 1 < c.steps.length; s++) {
        [true, false].forEach((want) => {
          startChatGame();
          chatGame.queue = [c];
          chatGame.i = 0;
          for (let k = 0; k < s; k++) {          // 先把前面几步都走成「接住」
            chatGame.step = k; chatGame.picked = null;
            const j = c.steps[k].choices.findIndex((x) => x.keep === true);
            answerChat(j); nextChatStep();
          }
          chatGame.step = s; chatGame.picked = null; renderChatStep();
          const j = c.steps[s].choices.findIndex((x) => x.keep === want);
          answerChat(j);
          const shown = ((document.getElementById('chatNext') || {}).textContent || '')
            // 界面上每一句都包着「」，比较时去掉——不然是拿带引号的跟不带引号的比，
            // 这条断言会因为格式而不是因为机制失败（我第一版就是这么错的）。
            .replace(/[「」\s]/g, '');
          const wantLines = (c.steps[s + 1].ask[want ? 'keep' : 'drop'] || [])
            .join('').replace(/\s+/g, '');
          if (!shown.includes(wantLines)) {
            bad.push(`${c.id} 第${s + 1}步 ${want ? 'keep' : 'drop'}`);
          }
        });
      }
    });
    return bad;
  });
  chk('每一个场合、每一步：屏幕上那句 = 数据里对应分支那句',
    wired.length === 0,
    wired.length ? `对不上：${wired.slice(0, 4).join('、')}` : '全部对上（共 6 案 × 2 步 × 2 分支）');


  console.log('\n[走完一局：结局、复盘、统计]');
  const full = await p.evaluate(() => {
    const c = CONTENT.chat.cases[0];
    startChatGame();
    chatGame.queue = [c];
    chatGame.i = 0;
    const seen = [];
    // 第 1 步故意掉球，后两步接住 → 应该是「some」那一档（保住 2/3）
    for (let s = 0; s < 3; s++) {
      chatGame.step = s; chatGame.picked = null; renderChatStep();
      const want = s === 0 ? false : true;
      const i = c.steps[s].choices.findIndex((x) => x.keep === want);
      answerChat(i);
      seen.push((document.getElementById('chatNext') || {}).textContent || '');
      nextChatStep();
    }
    const t = document.getElementById('view').textContent;
    return {
      phase: chatGame.phase,
      caught: chatGame.caught,
      review: chatGame.review.length,
      byMove: Object.keys(chatGame.byMove).length,
      showsRate: /接住率/.test(t),
      showsReview: /掉球的那些句/.test(t),
      showsEvidenceAgain: /别人对你的评价比你以为的高|Liking gap|liking gap/i.test(t) || t.includes('低估'),
      saved: !!(state.chat && state.chat.plays.length),
      savedByMove: !!(state.chat && Object.keys(state.chat.byMove || {}).length),
      allSeen: seen.every((x) => x.trim().length > 0),
      movedOn: seen[0] !== seen[1],
    };
  });
  chk('一局走完会进入结果页', full.phase === 'done', full.phase);
  chk('接住数按实际选的算（掉一句 / 接两句 = 2）', full.caught === 2, String(full.caught));
  chk('掉球的那句进了复盘', full.review === 1, `${full.review} 句`);
  chk('结果页有接住率', full.showsRate);
  chk('结果页有掉球复盘那一段', full.showsReview);
  chk('结果页把「别人比你以为的更喜欢你」也讲了', full.showsEvidenceAgain);
  chk('每一步都看到对方的下一句（回应是连贯的）', full.allSeen && full.movedOn);
  chk('成绩存进了 state.chat', full.saved && full.savedByMove,
    `plays + byMove ${full.byMove} 种动作`);

  console.log('\n[掉球的复盘：要说清这一句怎么了]');
  const rev = await p.evaluate(() => {
    toggleChatReview(0);
    const el = document.getElementById('chatrev0');
    return { shown: el && el.style.display !== 'none', len: el ? el.textContent.trim().length : 0 };
  });
  chk('复盘可以展开，而且写的是原因不是标签', rev.shown && rev.len > 30, `${rev.len} 字`);

  console.log('\n[累计习惯：第二局要看得见上一局]');
  const again = await p.evaluate(() => {
    chatGame = null;
    go('practice'); setPracticeSubview('chat');
    const t = document.getElementById('view').textContent;
    return { showsHabit: /出手习惯/.test(t), showsLast: /上一局/.test(t) };
  });
  chk('回来说明页能看到出手习惯', again.showsHabit);
  chk('也能看到上一局的成绩', again.showsLast);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' / '));

  await b.close();
  console.log(`\n结果：${fail ? '失败 ' + fail + ' 项' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
