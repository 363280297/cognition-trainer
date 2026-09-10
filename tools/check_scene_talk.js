/* 「场景对话」的检查：先给提示词，再建造一个场景。
 *
 * 用户的原话：「语音功能选后者，先给提示词，然后建造一个场景。」
 *
 * 这里要挡住的是一类很隐蔽的回归：**建场景看着成功了，实际没有场景**。
 * 建场景是一次模型调用，模型返回什么都有可能——多了外层键、少了开场白、
 * 字段名换了。如果代码只是把返回值往 session 里一塞，界面会正常切到对话页，
 * 然后卡在「她说：undefined」。这种失败在界面上看不出来，用户只会觉得「语音功能坏了」。
 *
 * 所以断言分两层：
 *   一层检查**界面**（提示词框、示例可点、状态提示），
 *   一层检查**坏输入**（空提示词、缺开场白、外层套了一层）都不许变成能进的会话。
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

/* 造一个字段齐全的假场景，形状抄 data/scenarios.json。 */
const GOOD = {
  title: '周会上被同事当面否了方案',
  stage: '同事',
  difficulty: 2,
  her: '同组同事，比你早来一年，能力强但话直',
  her_state: '他并不是针对你，是想让项目别翻车，但没意识到当众说会让人下不来台',
  opening: '这个方案我觉得有问题，你改完再说吧。',
  goal: '把分歧留在事上，同时让他知道当众这样说你不舒服',
  trap: '当场反驳他，把技术分歧变成谁对谁错',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    localStorage.removeItem('eq-settings');
    V.sess = null;
    go('ai'); setAiSubview('voice');
  });

  // ------------------------------------------------------------ 界面
  console.log('\n[建场景页：提示词在最前面]');
  const ui = await p.evaluate(() => {
    const ta = document.getElementById('scenePrompt');
    const seeds = [...document.querySelectorAll('.seed:not(.preset)')];
    return {
      hasTextarea: !!ta,
      rows: ta ? ta.rows : 0,
      aboveSeeds: !!(ta && seeds.length && ta.compareDocumentPosition(seeds[0]) & 4), // FOLLOWING
      seedCount: seeds.length,
      seedTexts: seeds.map((x) => x.textContent.trim()),
      // 现成场景是另一组按钮：它们点了应该直接开局，不是填提示词
      presetCount: document.querySelectorAll('.seed.preset').length,
      hasBuild: !!document.getElementById('buildBtn'),
      buildLabel: (document.getElementById('buildBtn') || {}).textContent,
      hasSettings: !!document.querySelector('button[onclick="openSettings()"]'),
      hasMeter: !!document.getElementById('askMeter'),   // 会话里的东西不该出现
      /* 「按住说话」那个按钮已经随语音输入一起删了（2.31），拿它当判据会变成
         一条永远为真的空断言。换成现在真实的对话控件：打字回她的输入框。 */
      hasTypeIn: !!document.getElementById('typeIn'),
    };
  });
  chk('有提示词输入框', ui.hasTextarea);
  chk('提示词是多行框（不是单行 input）', ui.rows >= 3, `rows=${ui.rows}`);
  chk('提示词排在示例前面', ui.aboveSeeds);
  chk('示例提示词不是空的', ui.seedCount >= 5, `${ui.seedCount} 条`);
  chk('现成场景是单独一组（不是混在示例里）', ui.presetCount >= 6, `${ui.presetCount} 个`);
  chk('示例都是提示词（说的是"我想练…"这类，不是场景标题）',
    ui.seedTexts.every((t) => t.length >= 8 && !/^[\u4e00-\u9fa5]{2,6}$/.test(t)),
    ui.seedTexts[0]);
  chk('有「建造这个场景」按钮', ui.hasBuild && /建造/.test(ui.buildLabel), ui.buildLabel);
  chk('页面上能进设置填密钥', ui.hasSettings);
  chk('没有会话时不显示对话控件（输入框/温度条不给出来）', !ui.hasMeter && !ui.hasTypeIn);

  // 点示例 → 填进输入框
  console.log('\n[示例：点一下填进输入框，而不是直接开跑]');
  const seed = await p.evaluate(() => {
    document.querySelectorAll('.seed:not(.preset)')[2].click();
    const ta = document.getElementById('scenePrompt');
    return { val: ta.value, focused: document.activeElement === ta, stillSetup: !V.sess };
  });
  chk('点示例把文字填进输入框', seed.val.length > 8, seed.val);
  chk('点示例不会偷偷开始一局', seed.stillSetup);
  chk('点示例把光标放到输入框（可以接着改）', seed.focused);

  // 电脑上打开：要说清楚是降级，别让人以为坏了
  console.log('\n[电脑上打开：降级要说出来]');
  const desk = await p.evaluate(() => {
    const wasNative = V.native; V.native = null;
    renderTalkSetup();
    const t = document.getElementById('view').textContent;
    V.native = wasNative;
    return { mentionsTyping: /打字/.test(t), hasTextarea: !!document.getElementById('scenePrompt') };
  });
  chk('没有原生语音桥时说明可以打字代替', desk.mentionsTyping);
  chk('降级状态下仍然给得出提示词框', desk.hasTextarea);

  // 手机上没有密钥：要提示，并且给一条去填的路
  console.log('\n[没填密钥：说清楚，并给出口]');
  const noKey = await p.evaluate(() => {
    const wasNative = V.native; V.native = {};   // 装成手机端
    renderTalkSetup();
    const t = document.getElementById('view').textContent;
    const btn = [...document.querySelectorAll('.warnbox button')].some((b) => /去填/.test(b.textContent));
    V.native = wasNative;
    return { mentionsKey: /API 密钥/.test(t), hasGoBtn: btn };
  });
  chk('没填密钥时明确说建不了场景', noKey.mentionsKey);
  chk('没填密钥时给一个「去填」的按钮', noKey.hasGoBtn);

  // ------------------------------------------------------------ 坏输入
  console.log('\n[坏输入：不许变成能进的会话]');
  const guard = await p.evaluate(async (GOOD) => {
    const r = {};
    const saved = window.llmCall;
    try {
      window.llmCall = async () => ({ title: 'x' });          // 缺 opening
      r.missing = await buildScenario('练点东西').then(() => 'ok', (e) => e.message);
      window.llmCall = async () => ({ scenario: GOOD });       // 外层套了一层
      r.wrapped = await buildScenario('练点东西').then((s) => s.opening, (e) => 'ERR ' + e.message);
      window.llmCall = async () => GOOD;                       // 正常
      const sc = await buildScenario('练点东西');
      r.good = { title: sc.title, diff: sc.difficulty, hasId: /^gen-/.test(sc.id), opening: sc.opening };
      window.llmCall = async () => ({});
      r.empty = await buildScenario('').then(() => 'ok', (e) => e.message);
    } finally { window.llmCall = saved; }
    return r;
  }, GOOD);
  chk('缺开场白 → 报错，不放行', /不完整/.test(guard.missing), String(guard.missing));
  chk('模型多套了一层外层键 → 自动拆开，不白报错',
    guard.wrapped === GOOD.opening, String(guard.wrapped).slice(0, 40));
  chk('正常返回 → 字段逐个搬过来',
    guard.good.title === GOOD.title && guard.good.opening === GOOD.opening, JSON.stringify(guard.good).slice(0, 60));
  chk('建出来的场景有自己的 id（不覆盖老场景）', guard.good.hasId);
  chk('难度被夹在 1–3', guard.good.diff >= 1 && guard.good.diff <= 3, String(guard.good.diff));
  chk('空提示词 → 先要提示词，不白跑一次模型',
    /提示词|想练/.test(String(guard.empty)), String(guard.empty));

  // 提示词里要写清楚「对方要有立场、有没说出口的期待」
  console.log('\n[给模型的提示词：这就是训练和闲聊的分界]');
  const sys = await p.evaluate(async (GOOD) => {
    let captured = null;
    const saved = window.llmCall;
    window.llmCall = async (m) => { captured = m; return GOOD; };
    await buildScenario('练一句不软不硬的回应');
    window.llmCall = saved;
    return { system: captured[0].content, user: captured[1].content };
  }, GOOD);
  chk('要求对方有自己的立场/没说出口的期待', /没(说出口|有说出)|立场/.test(sys.system));
  chk('要求开场白是口语、能直接说出口', /口语/.test(sys.system));
  chk('要求具体场合（不写成泛泛建议）', /具体/.test(sys.system));
  chk('字段名和老场景一致（her/her_state/opening/goal/trap）',
    ['her_state', 'opening', 'goal', 'trap'].every((k) => sys.system.includes(k)));
  chk('用户的提示词原样带进请求', /不软不硬/.test(sys.user), sys.user);

  // ------------------------------------------------------------ 进得去会话
  console.log('\n[传对象也能开局：老机制一行没动]');
  const sess = await p.evaluate(async (GOOD) => {
    const saved = window.llmCall;
    window.llmCall = async () => GOOD;
    const sc = await buildScenario('练一句不软不硬的回应');
    window.llmCall = async () => ({ her: '好吧，那你说说看。', her_tone: '平淡', her_rating: 3,
      inner: '他倒是没急着辩解，我先听听。', feedback: '开局还行。', score: 3 });
    await startSession(sc);
    const r = {
      hasSess: !!V.sess,
      title: V.sess && V.sess.sc.title,
      /* 原来查的是 pttBtn（「按住说话」）——语音输入 2.31 整块删掉了，那个按钮不存在。
         判据本身（"开局后确实落到对话界面"）没变，指向的控件换成真实存在的那个。 */
      hasTypeIn: !!document.getElementById('typeIn'),
      hasHer: !!document.getElementById('herSlot'),
      temp: V.sess && V.sess.temp,
    };
    window.llmCall = saved;
    return r;
  }, GOOD);
  chk('用生成出来的场景对象能开局', sess.hasSess && sess.title === GOOD.title, String(sess.title));
  chk('开局后是对话界面（打字回她的输入框在）', sess.hasTypeIn);
  chk('她的第一句已经贴出来', sess.hasHer);
  chk('温度条有初值', typeof sess.temp === 'number', String(sess.temp));

  // 老场景按 id 仍然能开（别为了新功能把旧的拆了）
  console.log('\n[老场景：按 id 照样能开]');
  const old = await p.evaluate(async () => {
    V.sess = null;
    const saved = window.llmCall;
    window.llmCall = async () => ({ her: '嗯。', her_tone: '平淡', her_rating: 3, inner: '…', feedback: '…', score: 3 });
    const id = (CONTENT.scenarios.scenarios || [])[0].id;
    await startSession(id);
    const r = { ok: !!V.sess, title: V.sess && V.sess.sc.title };
    window.llmCall = saved;
    return r;
  });
  chk('老场景按 id 仍能开局（两条路都通）', old.ok, String(old.title));

  /* 正文一个字都不许在渲染时被截。
   * 这是用户报的一个真 bug：「部分内容显示不全，比如说如果你一直找话题表」——
   * 数据里那句其实是「如果你一直找话题、表现自己，她会累」。查下来是开局那句
   * 「对方心里其实在想什么」被 slice(0, 40) 砍了，**六个现成场景全中**，
   * 而且砍掉的恰好是最关键的半句。
   * 所以这里逐个场景断言：渲染出来的文字必须**完整包含**数据里的 her_state。
   * 用「包含」而不是「相等」——界面上还有别的字，但正文不能少。 */
  console.log('\n[正文不许被截断]');
  const scenarios = await p.evaluate(() => (CONTENT.scenarios.scenarios || []).map((s) => ({
    id: s.id, title: s.title, ta: s.ta, her: s.her, her_state: s.her_state,
    opening: s.opening, goal: s.goal, trap: s.trap, difficulty: s.difficulty,
  })));
  const whole = await p.evaluate(async (scenes) => {
    const saved = window.llmCall;
    window.llmCall = async () => ({ reply: '嗯。', tone: '平淡' });
    const out = [];
    for (const sc of scenes) {
      /* V.phase / V.speaking 是语音输入留下的字段，2.31 之后不存在了；
         写上去只会给 V 添两个没人读的键，容易让人以为还有免提状态机。 */
      V.sess = null; V.ended = false;
      try { await startSession(sc); } catch (e) { /* 下面的断言会把缺的报出来 */ }
      const txt = document.querySelector('#view').textContent || '';
      out.push({
        id: sc.id, stateLen: sc.her_state.length, herLen: sc.her.length,
        stateFull: txt.indexOf(sc.her_state) >= 0,
        herFull: txt.indexOf(sc.her) >= 0,
      });
    }
    window.llmCall = saved;
    V.sess = null;
    return out;
  }, scenarios);
  const cut = whole.filter((x) => !x.stateFull);
  chk('每个现成场景的 her_state（对方心里在想什么）都完整显示',
    cut.length === 0,
    cut.length ? cut.map((x) => `${x.id}(${x.stateLen} 字，只剩半截)`).join(' ')
      : `${whole.length} 个场景全部完整`);

  /* 选场景页上，「对方心里在想什么」（her）只印在**被挑中的那一张**上
     （dailySceneCard），其余是紧凑按钮，只有标题/阶段/难度——这是设计，
     不是截断。所以这里查三件真事：被挑中那张的 her 完整、默认摊开的
     SCENES_PAGE 张卡各自印着自己的标题、点「看全部」之后 14 个标题全都进 DOM。
     （第一版断言"六个 her 全都在页面上"，那是查了设计上不存在的东西。）

     默认那几张的**选法**后来变了（2.32 有了 AI 情景库）：现在是"练得最少的优先、
     每个关系最多一张"（sceneSample）。所以这里不再断言"就是数据里的前 6 个"——
     那条断言在库长起来之后本来也守不住；改守它真正的用意：**六张卡各自印着自己的
     标题，而且不是一屏全是同一类关系**。 */
  const setup = await p.evaluate(() => {
    V.sess = null;
    scenesExpanded = false;
    setAiSubview('voice');                 // 回到"还没开局"的选场景页
    const all = CONTENT.scenarios.scenarios || [];
    const byTitle = {};
    all.forEach((s) => { byTitle[s.title] = s; });
    const q = () => document.querySelector('#view');
    const shot = () => {
      const view = q();
      const t = view.textContent || '';
      const cards = Array.from(view.querySelectorAll('.seed.preset'));
      return {
        n: cards.length,
        titles: cards.map((c) => ((c.querySelector('b') || {}).textContent || '').trim()),
        full: all.map((s) => ({ id: s.id, full: t.indexOf(s.title) >= 0 })),
      };
    };
    const txt = q().textContent || '';
    const feat = pickDailyScene();
    const first = shot();
    const domains = first.titles.map((t) => (byTitle[t] ? sceneDomain(byTitle[t]) : '?'));
    toggleAllScenes();                     // 摊开全部
    const opened = shot();
    toggleAllScenes();                     // 收回去，别把展开状态留给后面的检查
    return {
      feat: feat ? { id: feat.id, len: (feat.her || '').length, full: txt.indexOf(feat.her) >= 0 } : null,
      first, opened, domains,
      total: all.length, page: SCENES_PAGE,
      collapsed: scenesExpanded,
    };
  });
  chk('选场景页上被挑中的那张卡，her 完整显示',
    !!(setup.feat && setup.feat.full),
    setup.feat ? `${setup.feat.id}（${setup.feat.len} 字）full=${setup.feat.full}` : '没有挑中的场景');
  chk(`选场景页默认摊开 ${setup.page} 个，每张卡印着的都是真场景的标题`,
    setup.first.n === setup.page &&
      setup.first.titles.length === setup.page &&
      setup.first.titles.every((t) => t.length > 0),
    `${setup.first.n} 张：${JSON.stringify(setup.first.titles)}`);
  chk('默认这几张覆盖到多个关系（不是一屏全是同一类）',
    new Set(setup.domains).size >= 4, setup.domains.join('、'));
  chk(`点「看全部」之后 ${setup.total} 个场景的标题全都进 DOM`,
    setup.opened.n === setup.total && setup.opened.full.every((x) => x.full),
    `卡片 ${setup.opened.n} 个；缺标题：${setup.opened.full.filter((x) => !x.full).map((x) => x.id).join(',') || '无'}`);
  chk('看过之后列表收回默认状态（这条检查不留副作用）', setup.collapsed === false,
    String(setup.collapsed));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  await p.screenshot({ path: path.join(__dirname, '_scene_check.png') });
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
