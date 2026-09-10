/* 直接抓「谁往 #view 里写了不属于当前 tab 的内容」。
 *
 * 前面两次诊断都不可靠：我用文字关键词判断「这一页是谁」，而
 * 「今天」页里就有「第 0 关」、「1 条微课」这些字样，于是误报一堆。
 *
 * 这次换个思路：**不去判断页面是谁**，而是拦下每一次对 #view 的写入，
 * 记录当时的 currentTab 和调用栈。然后再判断「这次写入是不是当前 tab 该做的事」。
 * 这样不用猜页面身份，直接看写入者。
 *
 * 拦截办法：在 #view 这个元素实例上重定义 innerHTML 的 setter
 * （只影响这一个元素，不动原型）。写入时抓 new Error().stack 的第一行当调用者。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

/* 哪些渲染函数属于哪个 tab。用来判断「写入者是不是当前 tab 的人」。 */
const OWNER = {
  renderToday: 'today',
  viewCards: 'practice', renderCard: 'practice', renderPlans: 'growth', renderBias: 'growth',
  viewCalib: 'practice', renderCalib: 'practice', viewLearn: 'practice', openLesson: 'practice',
  renderStages: 'growth', renderPractice: 'ai', renderTalkSetup: 'ai',
  viewCheckup: 'ai', viewReplay: 'ai', renderReplayStep1: 'ai', renderReplayStep2: 'ai',
  renderReplayReveal: 'ai', renderCheckup: 'ai',
  renderGate: 'gate', openGate: 'gate',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);

  // 这里必须把 OWNER 传进去：漏了第二个参数时页面里的 OWNER 是 undefined，
  // Object.keys 直接抛 TypeError，整个诊断一行都跑不出来。
  await p.evaluate((OWNER) => {
    window.__OWNER = OWNER;
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.EQNative = {
      /* 能力只有这三项——2.31 删掉「听你说话」之后 V.caps 就长这样，
         原来这里写的 asr / mic 已经没有任何地方读了。 */
      capabilities: () => JSON.stringify({ tts: true, http: true, music: false }),
      httpPost: async (id) => window.__onHttp(id, JSON.stringify({
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          reply: '嗯。', tone: '平淡', inner: '…', signal: '…', rating: '平',
          rating_why: '…', temp: 50, temp_delta: 0 }) } }] }),
      })),
      speak: () => { }, stopSpeak: () => { },
    };
    V.native = window.EQNative;
    V.caps = { tts: true, http: true, music: false };
    saveSettings({ apiKey: 'sk-x', model: 'deepseek-chat' });

    /* ---- 记录「哪个渲染函数被调用」 ----
       不去拦 innerHTML 的 setter：innerHTML 定义在 Element.prototype 上，
       在实例上取 getOwnPropertyDescriptor 拿不到，而且调用栈里第一帧是 setter 自己，
       名字不干净。直接包住那几个渲染函数更准也更好读——
       它们是普通函数声明，会挂在 window 上，可以替换。 */
    window.__writes = [];
    Object.keys(window.__OWNER).forEach((name) => {
      const fn = window[name];
      if (typeof fn !== 'function') return;
      window[name] = function () {
        window.__writes.push({ who: name, tab: window.__tabNow || currentTab, cv: cardsView });
        return fn.apply(this, arguments);
      };
    });
    // go() 里也记一笔，作为「期望值」
    window.__gos = [];
    const origGo = window.go;
    window.go = function (t) {
      window.__gos.push({ t, sub: { p: practiceSubview, a: aiSubview, g: growthSubview } });
      window.__tabNow = t;
      return origGo(t);
    };
  }, OWNER);

  /* 走一圈用户可能做的事，尽量覆盖各种交错 */
  const steps = [
    ['go ai', () => go('ai')],
    ['AI→体检', () => setAiSubview('checkup')],
    ['go practice', () => go('practice')],
    ['练习→微课', () => setPracticeSubview('learn')],
    ['go growth', () => go('growth')],
    ['成长→预案', () => setGrowthSubview('plans')],
    ['go practice', () => go('practice')],
    ['go ai', () => go('ai')],
    ['AI→复盘', () => setAiSubview('replay')],
    ['go today', () => go('today')],
    ['go ai', () => go('ai')],
    ['AI→对话', () => setAiSubview('voice')],
    ['开一局', async () => { V.sess = null; V.ended = false; await startSession((CONTENT.scenarios.scenarios || [])[0]); }],
    ['说一句', async () => { await userSaid('你好'); }],
    ['结束', () => endSession()],
    ['go practice', () => go('practice')],
    ['练习→卡片', () => setPracticeSubview('cards')],
    ['判局', () => { const c = CONTENT.cards.cards.find((x) => x.genre); session.queue = [c]; session.i = 0; session.genrePick = null; renderCard(); const gb = document.querySelector('#genreStep .genre-btn'); if (gb) gb.click(); }],
    ['go ai', () => go('ai')],
    ['go practice 再切回', () => go('practice')],
    ['答一题', () => { const c = session.queue[0]; const r = (c.options || []).find((o) => o.id === c.best) || { id: 'A' }; answerCard(r.id); }],
    ['go growth', () => go('growth')],
    ['成长→偏差画像', () => setGrowthSubview('bias')],
    ['go practice', () => go('practice')],
    ['go ai', () => go('ai')],
  ];

  console.log('\n[逐步走，看每一步之后有没有「不属于当前 tab」的写入]');
  const bad = [];
  for (const [label, fn] of steps) {
    await p.evaluate(async (src) => { await (0, eval)('(' + src + ')')(); }, fn.toString());
    await p.waitForTimeout(120);
    const r = await p.evaluate(() => {
      const w = window.__writes.slice();
      window.__writes = [];
      const tab = currentTab;
      const out = [];
      /* viewCards 是共用的分发器：卡片页 / 预案 / 偏差画像都从它进，
         所以它属于谁要看它当时按 cardsView 画了哪一页，不能一刀切成 practice。
         （切错了会漏报——原来那个「练习页下渲染出预案」的 bug 正是这种。）
         判据仍保留牙齿：练习 tab 下 cardsView='plans' 时 owner=grouwth≠practice，照样报。 */
      const ownerOf = (x) => {
        if (x.who === 'viewCards') return (x.cv === 'plans' || x.cv === 'bias') ? 'growth' : 'practice';
        return window.__OWNER[x.who];
      };
      for (const x of w) {
        const owner = ownerOf(x);
        // 允许：gate（浮层盖在谁上面都合理）、以及未登记的辅助渲染
        if (owner && owner !== 'gate' && owner !== tab) out.push(x);
      }
      return { tab, writes: w, bad: out,
               sub: { p: practiceSubview, a: aiSubview, g: growthSubview, c: cardsView } };
    });
    if (r.bad.length) {
      bad.push({ label, ...r });
      console.log(`  !! ${label}：currentTab=${r.tab} 但写了`);
      r.bad.forEach((x) => console.log(`       ${x.who}（属于 ${OWNER[x.who]}）`));
      console.log(`       subview=${JSON.stringify(r.sub)}`);
    } else {
      console.log(`  ok ${label}  tab=${r.tab}  写入=${r.writes.map((x) => x.who).join(',') || '无'}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(bad.length ? `发现 ${bad.length} 步存在「跨 tab 写入」` : '没有跨 tab 写入');
  if (bad.length) console.log('第一处明细：' + JSON.stringify(bad[0], null, 1).slice(0, 900));
  console.log('页面报错：' + (errs.length ? errs.slice(0, 3).join(' | ') : '无'));
  await b.close();
})();
