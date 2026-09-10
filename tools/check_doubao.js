/* 「像豆包一样对话」的检查：模型默认值 + 旧设置迁移 + 情景直接选好。
 *
 * 这一组的由来是一次真实测量（tools/probe_chat.py，真实请求）：
 *
 *     deepseek-v4-pro    30.65s/轮    推理 5006 字   ← App 原来的默认
 *     deepseek-flash      4.63s/轮    推理 1015 字
 *     deepseek-chat       1.59s/轮    推理    0 字   ← 像豆包的是这个
 *
 * 也就是说**对话功能本身一直是通的**（多轮、字段齐、内容像真人），
 * 「不像豆包」几乎只由默认模型这一项决定：一轮三十秒，那不是对话是写信。
 *
 * 这里最要紧的一条断言是**迁移**：
 * 用户手机上 localStorage 里已经存着 deepseek-v4-pro 了，
 * 只改代码里的默认值对他一点效果都没有——默认值只在「没存过」时生效。
 * 所以必须真的模拟「旧设置已存在」再去载入，验证它被换掉、并且说明了原因。
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
const SET_KEY = 'eq-settings-v1';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });

  // ======================================================================
  // 1) 全新安装：默认就是快的那个
  // ======================================================================
  console.log('\n[全新安装：默认模型]');
  {
    const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    await p.evaluate(() => localStorage.clear());
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const r = await p.evaluate(() => ({
      model: settings().model,
      fast: MODEL_FAST,
      choices: MODEL_CHOICES.map((m) => m.id),
      slowNoted: MODEL_CHOICES.filter((m) => /30 秒|推理/.test(m.note)).map((m) => m.id),
    }));
    chk('默认模型是实测最快的那个', r.model === 'deepseek-chat', r.model);
    chk('默认模型 == MODEL_FAST（一处定义）', r.model === r.fast, `${r.model} / ${r.fast}`);
    chk('设置页能选到三个实测过的模型', r.choices.length === 3, r.choices.join('、'));
    chk('慢模型在选项里明确标了「一轮约 30 秒 / 带推理」', r.slowNoted.length >= 1, r.slowNoted.join('、'));
    chk('全新安装没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  // ======================================================================
  // 2) 迁移：已经装好的旧设置（这一条是本次改动的关键）
  // ======================================================================
  console.log('\n[迁移：手机上已经存着旧模型的情况]');
  {
    const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    // 模拟「用户手机上的旧设置」：存的就是老默认值
    await p.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ apiKey: 'sk-keep-me', model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/chat/completions', rate: 1, pitch: 1 }));
      localStorage.removeItem('eq-model-switched');
    }, SET_KEY);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const r = await p.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      return {
        model: s.model,
        keyKept: s.apiKey,
        urlKept: s.baseUrl,
        flag: localStorage.getItem('eq-model-switched'),
        runtime: settings().model,
      };
    }, SET_KEY);
    chk('旧模型被换成了快的（只改默认值对老用户无效，所以必须迁移）',
      r.model === 'deepseek-chat', r.model);
    chk('迁移后运行时的模型也是快的', r.runtime === 'deepseek-chat', r.runtime);
    chk('密钥和其它设置没被动过', r.keyKept === 'sk-keep-me'
      && r.urlKept === 'https://api.deepseek.com/chat/completions', JSON.stringify(r.keyKept));
    chk('记下了「换过模型」这件事（要跟用户说明白）', !!r.flag, String(r.flag));

    // 设置页要说清楚为什么换
    const notice = await p.evaluate(() => {
      document.querySelectorAll('.sheet').forEach((x) => x.remove());
      // 设置页现在有分区，模型那一栏在「AI 陪练」里——默认落的是「声音」，
      // 所以要显式打开那一段（重构设置页时这条断言就是这么红的）
      openSettings('ai');
      const txt = document.querySelector('.sheet').textContent;
      /* 只数「AI 陪练」这一段里的模型胶囊。设置页 2.31 起顶上多了一排分区导航
         （.chips.set-nav，6 个分区），用 '.chips .chip-btn' 会把那 6 个一起数进来
         （3 个模型 + 6 个分区 = 7，重构设置页时这条就是这么红的）。 */
      const chips = [...document.querySelectorAll('#setBody .chips .chip-btn')].map((x) => x.textContent.trim());
      const on = [...document.querySelectorAll('#setBody .chips .chip-btn.on')].map((x) => x.textContent.trim());
      const nav = [...document.querySelectorAll('.chips.set-nav button')].map((x) => x.textContent.trim());
      return {
        txt, chips, on, nav,
        hint: (document.getElementById('modelHint') || {}).textContent,
        hasOldName: /deepseek-v4-pro/.test(txt),
        explainsWhy: /30 秒|推理/.test(txt),
      };
    });
    chk('设置页在模型那一栏说明了「自动换过」', notice.txt.includes('已经被') || /换成了|从 /.test(notice.txt));
    chk('说明了为什么（带实测数字）', notice.explainsWhy);
    chk('设置页有模型选择按钮', notice.chips.length === 3, notice.chips.join('、'));
    chk('设置页顶上的分区导航是 6 个分区，且没混进模型胶囊里', notice.nav.length === 6,
      notice.nav.join('、'));
    chk('当前模型被高亮', notice.on.length === 1 && notice.on[0] === 'deepseek-chat', notice.on.join('、'));
    chk('下面写了当前模型的速度', /1\.6 秒|秒一轮/.test(notice.hint || ''), String(notice.hint));

    // 点另一个模型：填进输入框 + 提示跟着变
    const swap = await p.evaluate(() => {
      chooseModel('deepseek-v4-pro');
      return {
        val: document.getElementById('setModel').value,
        hint: document.getElementById('modelHint').textContent,
        on: [...document.querySelectorAll('#setBody .chips .chip-btn.on')].map((x) => x.textContent.trim()),
      };
    });
    chk('点模型名会填进输入框', swap.val === 'deepseek-v4-pro', swap.val);
    chk('提示跟着换成这个模型的实测速度', /30 秒/.test(swap.hint), swap.hint);
    chk('高亮跟着换', swap.on.length === 1 && swap.on[0] === 'deepseek-v4-pro', swap.on.join('、'));

    // 用户自己填的其它名字不能被迁移逻辑碰
    const custom = await p.evaluate(async (k) => {
      localStorage.setItem(k, JSON.stringify({ model: 'my-own-proxy-model' }));
      localStorage.removeItem('eq-model-switched');
      return true;
    }, SET_KEY);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    const keep = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').model, SET_KEY);
    chk('用户手填的其它模型名不会被迁移动到', keep === 'my-own-proxy-model', keep);
    chk('这一组没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  // ======================================================================
  // 3) 慢的时候主动说 + 情景直接选好
  // ======================================================================
  console.log('\n[一轮特别慢时会主动提示]');
  {
    const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

    // 真的量一次：让桩慢 60ms，验 V.lastTurnMs 被写进去（不是只信一个手填的值）
    const timed = await p.evaluate(async () => {
      V.native = null;
      window.llmCall = async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { reply: '嗯。', tone: '平淡', inner: '…', signal: '…', rating: '平',
                 rating_why: '…', temp: 50, temp_delta: 0 };
      };
      await startSession((CONTENT.scenarios.scenarios || [])[0]);
      // 开局那一轮是本地拼的、不发请求，量它是 0 才对；
      // 真正要量的是「用户说了一句之后」那一轮。
      const opening = V.lastTurnMs;
      await userSaid('你到了有一会儿了吧？');
      return { opening, turn: V.lastTurnMs };
    });
    chk('开局那一轮不调模型，所以不记耗时', timed.opening === 0, `${timed.opening}ms`);
    chk('用户说话后的那一轮真的在量耗时', timed.turn >= 50, `${timed.turn}ms`);

    const slow = await p.evaluate(() => {
      // 前提必须是「当前用的是慢模型」——否则新的文案会（正确地）不提换模型，
      // 那样这条断言就测不到「建议」这条路径了
      saveSettings({ model: 'deepseek-v4-pro' });
      V.lastTurnMs = 12000; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      if (el) el.textContent = '';
      noteTurnLatency();
      return { hint: (document.getElementById('turnHint') || {}).textContent,
               warned: V.latencyWarned, model: settings().model };
    });
    chk('一轮超过 8 秒会主动提示', /等了 12\.0 秒/.test(slow.hint || ''), String(slow.hint));
    chk('用的是慢模型时，提示给出具体该换成哪个',
      slow.model === 'deepseek-v4-pro' && /deepseek-chat/.test(slow.hint || ''),
      `${slow.model}：${String(slow.hint).slice(0, 50)}`);

    const once = await p.evaluate(() => {
      const first = document.getElementById('turnHint').textContent;
      noteTurnLatency();     // 再来一次不该重复覆盖（一局只提醒一次）
      return { same: document.getElementById('turnHint').textContent === first };
    });
    chk('一局只提醒一次，不刷屏', once.same);

    const fast = await p.evaluate(() => {
      V.lastTurnMs = 1500; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      if (el) el.textContent = '（清空过）';
      noteTurnLatency();
      return { after: el ? el.textContent : '', warned: V.latencyWarned };
    });
    // 先清空再比，否则「前后一样」是句废话（原来就是这么写的，等于永不失败）
    chk('正常速度（1.5 秒）不会瞎提示',
      fast.after === '（清空过）' && !fast.warned, `${fast.after} / warned=${fast.warned}`);

    // 已经在用快模型时，不能再劝他换它自己
    const selfAdvice = await p.evaluate(() => {
      V.lastTurnMs = 12000; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      if (el) el.textContent = '';
      saveSettings({ model: MODEL_FAST });
      noteTurnLatency();
      return { hint: el ? el.textContent : '', model: settings().model };
    });
    chk('已经在用最快模型时，提示不说「换成它自己」这种废话',
      !/换成 deepseek-chat/.test(selfAdvice.hint)
        && /网络|地址|服务端/.test(selfAdvice.hint),
      selfAdvice.hint.slice(0, 60));

    // ---------------- 情景直接选好 ----------------
    console.log('\n[情景：一进 AI 页就已经选好一个]');
    /* 2.33 起 AI 页最上面多了一张「上次没聊完」（离开 App 再回来时一步接上）。
       前面刚聊过一局、没点结束，所以此刻最上面应该是它、不是「今天就练这个」。
       两种顺序都钉住，免得哪天加了个东西把"继续"挤到下面去。 */
    const withUn = await p.evaluate(() => {
      V.sess = null; V.ended = false; dailySceneId = null;
      go('ai'); setAiSubview('voice');
      const cards = [...document.querySelectorAll('#view .card')];
      const un = document.querySelector('.resume-card');
      const daily = document.querySelector('.daily-scene');
      return {
        unIdx: un ? cards.indexOf(un) : -1,
        dailyIdx: daily ? cards.indexOf(daily) : -1,
        unText: un ? un.textContent.replace(/\s+/g, ' ').slice(0, 200) : '',
      };
    });
    chk('有没聊完的局时，「上次没聊完」排在「今天就练这个」前面',
      withUn.unIdx === 0 && withUn.dailyIdx === 1, JSON.stringify(withUn));
    chk('并且写明了是哪一局、聊了几轮', /上次没聊完/.test(withUn.unText) && /轮/.test(withUn.unText),
      withUn.unText);

    // 清掉没聊完的局之后，最上面才是「今天就练这个」
    await p.evaluate(() => { state.talks = []; save(); go('ai'); setAiSubview('voice'); });
    await p.waitForTimeout(300);
    const deck = await p.evaluate(() => {
      const card = document.querySelector('.daily-scene');
      return {
        hasCard: !!card,
        first: /今天就练这个/.test((card || {}).textContent || ''),
        // 推荐的必须在页面最上面（不用往下找）
        isFirstCard: card === document.querySelector('#view .card'),
        title: (document.querySelector('.daily-scene h2') || {}).textContent,
        hasStart: !!document.querySelector('.daily-scene button[onclick^="startSession"]'),
        hasSwap: !!document.querySelector('.daily-scene button[onclick="nextDailyScene()"]'),
        meta: [...document.querySelectorAll('.daily-scene .tag')].map((x) => x.textContent.trim()),
      };
    });
    chk('AI 页顶部就是「今天就练这个」', deck.hasCard && deck.first && deck.isFirstCard);
    chk('直接给了一个具体情景（有标题）', (deck.title || '').length > 3, String(deck.title));
    chk('一个按钮就能开始', deck.hasStart);
    chk('能换一个（本地换，不发请求）', deck.hasSwap);
    chk('标了关系阶段/难度/练过几次',
      deck.meta.some((x) => /难度/.test(x)) && deck.meta.some((x) => /练过|没练过/.test(x)),
      deck.meta.join('、'));

    // 轮换：优先推练得最少的
    const rotate = await p.evaluate(() => {
      state.scenes = {};
      const all = CONTENT.scenarios.scenarios.map((s) => s.id);
      // 除了 s3 之外都练过 3 次 → 应该推 s3
      all.forEach((id) => { state.scenes[id] = 3; });
      state.scenes[all[2]] = 0;
      dailySceneId = null;
      const picked = pickDailyScene();
      // 再让两个都没练过，难度低优先
      state.scenes = {};
      all.forEach((id) => { state.scenes[id] = 0; });
      dailySceneId = null;
      const byDiff = pickDailyScene();
      return { want: all[2], picked: picked && picked.id, byDiff: byDiff && byDiff.id,
               diffs: CONTENT.scenarios.scenarios.map((s) => [s.id, s.difficulty]) };
    });
    chk('优先推荐练得最少的那个', rotate.picked === rotate.want, `${rotate.picked} vs ${rotate.want}`);
    chk('都没练过时优先推荐难度低的', rotate.byDiff === 's1', `${rotate.byDiff} / ${JSON.stringify(rotate.diffs)}`);

    const cycle = await p.evaluate(async () => {
      dailySceneId = null;
      go('ai'); setAiSubview('voice');
      const a = document.querySelector('.daily-scene h2').textContent;
      nextDailyScene();
      await new Promise((r) => setTimeout(r, 100));
      const bfb = document.querySelector('.daily-scene h2').textContent;
      nextDailyScene();
      await new Promise((r) => setTimeout(r, 100));
      const c = document.querySelector('.daily-scene h2').textContent;
      return { a, bfb, c };
    });
    chk('「换一个」真的换（不是同一个）', cycle.a !== cycle.bfb, `${cycle.a} → ${cycle.bfb}`);
    chk('换两次会到第三个（在轮换，不是来回抖）', cycle.bfb !== cycle.c, `→ ${cycle.c}`);

    // 练完一局要记一笔，否则推荐永远是同一个
    const record = await p.evaluate(async () => {
      state.scenes = {};
      V.sess = null; V.ended = false;
      window.llmCall = async () => ({ reply: '嗯。', tone: '平淡', inner: '…', signal: '…',
        rating: '平', rating_why: '…', temp: 50, temp_delta: 0 });
      const sid = (CONTENT.scenarios.scenarios || [])[0].id;
      await startSession(sid);
      V.sess.log.push({ reply: 'x', rating: '平', temp: 50, userText: 'y', inner: 'z' });
      endSession();
      return { scenes: JSON.parse(JSON.stringify(state.scenes)), sid,
               saved: JSON.parse(localStorage.getItem('eq-state-v2') || '{}').scenes || {} };
    });
    chk('练完一局会给这个情景记一笔', record.scenes[record.sid] === 1, JSON.stringify(record.scenes));
    chk('记的一笔落盘了', record.saved[record.sid] === 1, JSON.stringify(record.saved));

    const noDouble = await p.evaluate(() => {
      const before = JSON.parse(JSON.stringify(state.scenes));
      endSession();   // 再渲染一次结束页，不该重复计数
      return { before, after: state.scenes };
    });
    chk('重复渲染结束页不会重复计数',
      JSON.stringify(noDouble.before) === JSON.stringify(noDouble.after),
      JSON.stringify(noDouble.after));

    // 现造的那个不该被记进轮换表（每次 id 都不同，记了就是垃圾数据）
    const gen = await p.evaluate(() => {
      const before = Object.keys(state.scenes).length;
      state.scenes['gen-123456'] = (state.scenes['gen-123456'] || 0) + 1;
      return { before, has: !!state.scenes['gen-123456'] };
    });
    chk('（护栏）轮换表只存现成情景的 id', gen.has, '这条靠 endSession 里的 /^gen-/ 判断守住');

    chk('这一组没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
