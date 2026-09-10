/* 对话历史 —— 用户这一轮的要求：
 *   「ai对话，可以给出一个结束功能，点击结束之后，对于整段对话进行一个综合分析，
 *     以及提出建议，之后保存到历史记录，有一个小图标，可以点进去查看。以及不用的可以删除。」
 *
 * 这台电脑上没有手机的原生桥，所以这里测的是**网页这一层**：
 * 存的东西全不全、看得到看不到、删得掉不掉、失败的时候会不会丢数据。
 *
 * 这个文件原来还有四节是围绕**本地（离线）识别**的：本地识别的路由（一）、
 * 模型解包/不静默开麦（二）、识别诊断三层（三）、麦克风权限（八）。
 * 用户当时的要求是
 *   「你可以装上呀，比如说开源的识别服务，就像各种输入法之类，它就有语音转文字那种。」
 * 后来他自己把这条路整个否掉了：
 *   「做情景模拟 ai 对话的时候，等他说完话，我这边就会自动录音，停止这个功能。
 *     直接把这个录音的功能删除。我直接打字算了。」
 * 2.31 删掉「听你说话」之后，那四节依赖的东西在 public/ 和 android/ 里一个都不剩：
 *   asrCap / asrEngineName / startListen / stopListen / asrDiagnose / micTap /
 *   V.local / V.caps.mic / requestMic / asrLocalState / asrLocalPrepare /
 *   listenLocal / stopListeningLocal / __onLocalAsr / window.__onPerm('mic')
 * 所以连同假原生桥里对应的那几个方法一起删除——**不是**换个写法糊回来。
 * 真正在手机上能不能识别，本来也只能装上去试，不在这里假装测过。
 *
 * 留下的是历史记录本身：存（四、六、九）/ 看（五）/ 删（五）/ 续聊（九）/ 老存档（七）。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let bad = 0;
let browser = null;
function chk(name, ok, extra) {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : '   -> ' + extra}`);
  if (!ok) bad++;
}

const GOOD = {
  id: 'sc-fix-1', title: '同事在群里否了你的方案', ta: '她', stage: '职场',
  difficulty: 3, her: '同组同事，刚在群里说你的方案「再想想」',
  her_state: '她其实担心的是上线之后出问题算谁的', goal: '不软不硬地把方案推回去',
  trap: '要么硬顶，要么直接认了', opening: '那我们先按你说的改？',
};

const TURN = {
  reply: '行，那就先改。', tone: '平淡', inner: '他好像不太想争。',
  signal: '顺着对方走', rating: '平', rating_why: '没有表态', temp: 50,
};

const DEBRIEF = {
  verdict: '这一局你一直在解释方案，没有一次回应对方的担心。',
  pattern: '把技术问题当成说服问题。',
  keeps: ['语气没有对抗'],
  fixes: [{ act: '先接住担心', say: '你担心的是哪一块？', why: '先确认再解释' }],
  one: '每次先问一句再解释。',
};

const SEED = { talks: [] };

/* 开一页，并先把存档塞好。
   假原生桥早就删了：识别那四节（需要 requestMic / asrLocalState / listenLocal…）
   整节删除之后，剩下的几节全是网页这一层的存取删，一条原生调用都不需要。
   所以现在照常开页就行——真机上 V.native 的取法本来也不在这里验。 */
async function open() {
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript((args) => {
    localStorage.setItem('eq-state-v2', JSON.stringify(args.seed));
  }, { seed: SEED });
  await p.goto(OFFLINE);
  await p.waitForTimeout(400);
  return { p, errs };
}

(async () => {
  browser = await chromium.launch({ executablePath: EXE });

  /* ============== 一、二、三：本地（离线）识别 —— 整块删除
   *
   * 这里原来是三节：本地识别的路由（listenLocal > listenViaActivity 的顺序）、
   * 第一次用的模型解包（先说清"要准备一下"、准备期间不许开麦、松手之后不许偷偷开麦）、
   * 以及识别诊断三层（系统的识别服务 / App 自带的离线识别 / 系统的识别界面）。
   *
   * 用户后来又把这套否掉了：「直接把这个录音的功能删除。我直接打字算了。」
   * 2.31 删掉听你说话之后，这一节依赖的 API（asrCap / asrEngineName / startListen /
   * stopListen / asrDiagnose / V.local / __onLocalAsr / listenLocal / asrLocalPrepare）
   * 在 public/ 里一个都不剩，所以整节删除——**不是**换个写法糊回来。
   * 现在剩的是历史记录本身：存 / 看 / 删 / 续聊 / 老存档。
   */

  /* ==================================================== 四、一局结束 → 历史 */
  console.log('\n[四、结束一局：分析 + 存进历史]');
  {
    const { p, errs } = await open();
    await p.evaluate(async (args) => {
      V.native = null; V.caps = { tts: false, asr: false, http: false, mic: false };
      window.llmCall = async (m) => (/复盘|分析/.test(m[0].content) ? args.debrief : args.turn);
      V.sess = null; V.ended = false;
      await startSession(args.good);
      await userSaid('你担心的是哪一块？我想先听这个。');
      endSession();
    }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(600);

    const saved = await p.evaluate(() => {
      const t = (state.talks || [])[0];
      return {
        n: (state.talks || []).length,
        has: !!t,
        id: t && t.id, title: t && t.sc && t.sc.title,
        turns: t && t.turn, log: t && t.log && t.log.length,
        userText: t && t.log && t.log[0] && t.log[0].userText,
        deb: t && t.debrief && t.debrief.verdict,
        sidMatches: t && V.sess && t.id === V.sess.sid,
        // 别把给模型的消息历史一起塞进去（体积翻倍、没有用处）
        hasHistory: t && 'history' in t,
        line: /已经存进[\s\S]{0,20}对话历史/.test(document.getElementById('debriefBody').textContent),
      };
    });
    chk('结束之后自动存了一条', saved.n === 1 && saved.has, JSON.stringify({ n: saved.n }));
    chk('记录里存的是这一局（标题、轮数、逐轮）',
      saved.title === GOOD.title && saved.turns >= 1 && saved.log >= 1, JSON.stringify(saved));
    chk('逐轮里存了他自己的原话', /你担心的是哪一块/.test(saved.userText || ''), saved.userText);
    chk('分析也一起存了', /解释方案/.test(saved.deb || ''), String(saved.deb).slice(0, 30));
    chk('记录 id 就是这一局的 sid（重生成分析不会多出一条）', saved.sidMatches);
    chk('没有把给模型的 messages 历史一起存进来', !saved.hasHistory);
    chk('结束页上说明了「已经存进对话历史」', saved.line);

    /* 重开一局 + 再结束，不该出现重复的一条。
       注意读长度必须**等一会儿再读**：endSession 里生成分析是异步的，
       跟着 return 一起读的话，读到的是"分析还没回来"的那一刻（第一版就是这么红的）。 */
    await p.evaluate(async (args) => {
      V.sess = null; V.ended = false;
      await startSession(args.good);
      await userSaid('你担心的是哪一块？');
      endSession();
    }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(600);
    const again = await p.evaluate(() => (state.talks || []).length);
    const ids = await p.evaluate(() => (state.talks || []).map((t) => t.id));
    chk('再来一局 → 历史里多一条（不是覆盖上一条）', again === 2, String(again));
    chk('两条的 id 不同（每局一条，不会并成一条）',
      ids.length === 2 && ids[0] !== ids[1], ids.join(','));
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ============================================ 五、列表 / 详情 / 删除 */
  console.log('\n[五、历史列表、查看、删除]');
  {
    const { p, errs } = await open();
    await p.evaluate(() => {
      state.talks = [
        { id: 'a1', at: Date.now() - 86400000, done: true, gen: false, turn: 6, temp: 62, asked: 2,
          followUps: 1, goods: 4, bads: 1,
          sc: { id: 'sc-fix-1', title: '同事在群里否了你的方案', ta: '她', opening: '那我们先按你说的改？',
                goal: '不软不硬地把方案推回去' },
          log: [{ userText: '你担心的是哪一块？', reply: '我怕上线出问题', rating: '好',
                  rating_why: '先问再解释', temp: 56 }],
          debrief: { verdict: '这一局比上次稳。', fixes: [{ act: '先接住', say: '你担心的是哪一块？' }], one: '先问一句' } },
        { id: 'b2', at: Date.now(), done: true, gen: true, turn: 3, temp: 44, asked: 0, followUps: 0,
          goods: 1, bads: 2,
          sc: { id: 'gen-1', title: '自己出的题', ta: '他', opening: '你这算什么？' },
          log: [{ userText: '我理解你', reply: '行吧', rating: '失误', rating_why: '没有具体内容', temp: 44 }],
          debrief: null },
      ];
      save();
      setAiSubview('voice');
      renderTalkSetup();
      return true;
    });
    /* 历史入口现在挂在二级切换条上（由 showTab → injectSubnav 注入），
       不再放在 renderTalkSetup 里了，所以要先真正进一次 AI 这一路才看得到它。
       判据一个字没松：数字跟着历史条数走 + 点了确实走 openTalkHistory。 */
    const icon = await p.evaluate(() => {
      go('ai');
      const b2 = document.querySelector('.subnav-act');
      return { text: b2 ? b2.textContent.trim() : '',
               click: b2 ? /openTalkHistory/.test(b2.getAttribute('onclick')) : false };
    });
    chk('历史入口上的数字跟着历史条数走', /历史 2/.test(icon.text) && icon.click, icon.text);

    const list = await p.evaluate(() => {
      openTalkHistory();
      const t = document.querySelector('#view').textContent;
      return { t, rows: document.querySelectorAll('.his-row').length,
               noDeb: /还没生成分析/.test(t) };
    });
    chk('点进去能看到列表（两条）', list.rows === 2, String(list.rows));
    chk('列表上标出哪一条还没生成分析', list.noDeb);

    /* 浮层没拆就跳页 → 新页面渲在全屏浮层**下面**，看着像「点了没反应」。
       对照一下：先开设置（浮层），再点历史入口，浮层必须没了。
       这条钉的不是当前 UI 上真能走到的路径（设置开着时点不到切换条），
       而是那个更大的坑——「状态换了、屏幕没换」。 */
    const overSheet = await p.evaluate(() => {
      go('ai');
      openSettings('ai');
      const before = document.querySelectorAll('.sheet').length;
      openTalkHistory();
      return { before, after: document.querySelectorAll('.sheet').length,
               isHistory: /对话历史/.test(document.querySelector('#view').textContent) };
    });
    chk('浮层开着的时候进历史：浮层被拆掉，历史真的在屏幕上',
      overSheet.before === 1 && overSheet.after === 0 && overSheet.isHistory,
      JSON.stringify(overSheet));

    const det = await p.evaluate(() => {
      renderTalkRecord('a1');
      const t = document.querySelector('#view').textContent;
      return { t, say: !!document.querySelector('.deb-say'), rounds: document.querySelectorAll('.round').length };
    });
    chk('详情页显示那一局的分析', /比上次稳/.test(det.t) && det.say);
    chk('详情页显示逐轮记录（含他当时的原话）',
      det.rounds === 1 && /你担心的是哪一块/.test(det.t));
    chk('详情页不显示「生成分析」按钮（本来就有）', !/现在生成分析/.test(det.t));

    const nod = await p.evaluate(() => {
      renderTalkRecord('b2');
      return document.querySelector('#view').textContent;
    });
    chk('没分析的那条给一个「生成分析」的入口', /生成分析/.test(nod));

    // 补生成分析
    const re = await p.evaluate(async (DEBRIEF) => {
      window.llmCall = async () => DEBRIEF;
      await reanalyzeTalk('b2');
      return { t: document.getElementById('debriefBody').textContent,
               stored: !!(state.talks.find((x) => x.id === 'b2') || {}).debrief,
               n: state.talks.length };
    }, DEBRIEF);
    chk('补生成的分析会显示出来，并写回这条记录',
      /解释方案/.test(re.t) && re.stored, re.t.slice(0, 30));
    chk('补生成不会多出一条记录', re.n === 2, String(re.n));

    // 删除：两步
    const del = await p.evaluate(() => {
      renderTalkHistory();
      askDeleteTalk('a1');
      const mid = (document.querySelector('.his-confirm') || {}).textContent || '';
      const still = state.talks.length;
      deleteTalk('a1');
      const t = document.querySelector('#view').textContent;
      return { mid, still, n: state.talks.length, t,
               gone: !/同事在群里否了你的方案/.test(t) };
    });
    chk('点删除先问一次，不直接删掉', /删掉这一局/.test(del.mid) && del.still === 2, del.mid.slice(0, 20));
    chk('确认之后真的删掉，列表也跟着变', del.n === 1 && del.gone, JSON.stringify({ n: del.n }));

    const clr = await p.evaluate(() => {
      askClearTalks();
      const mid = (document.querySelector('.his-confirm') || {}).textContent || '';
      clearTalks();
      return { mid, n: state.talks.length,
               t: document.querySelector('#view').textContent };
    });
    chk('清空全部也要先问一次', /清空全部/.test(clr.mid), clr.mid.slice(0, 20));
    chk('清空之后列表变成空的并且说明去哪开一局',
      clr.n === 0 && /还没有记录/.test(clr.t), String(clr.n));

    // 删干净之后不该崩，也不该留下一个点不动的入口
    const iconAfter = await p.evaluate(() => {
      go('ai');            // 让二级切换条按清零后的条数重画一次
      const b2 = document.querySelector('.subnav-act');
      return { text: b2 ? b2.textContent.trim() : '' };
    });
    chk('历史空了之后入口还在，只是没有数字', /历史/.test(iconAfter.text) && !/\d/.test(iconAfter.text),
      iconAfter.text);
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ========================================== 六、分析失败也不能丢这一局 */
  console.log('\n[六、分析生成失败：记录不能跟着丢]');
  {
    const { p, errs } = await open();
    await p.evaluate(async (args) => {
      V.native = null; V.caps = { tts: false, asr: false, http: false, mic: false };
      window.llmCall = async (m) => {
        if (/复盘|分析/.test(m[0].content)) throw new Error('模型返回 500');
        return args.turn;
      };
      V.sess = null; V.ended = false;
      await startSession(args.good);
      await userSaid('你担心的是哪一块？');
      endSession();
    }, { good: GOOD, turn: TURN });
    await p.waitForTimeout(600);
    const r = await p.evaluate(() => {
      const b = document.getElementById('debriefBody');
      return { text: b.textContent, retry: !!(b && b.querySelector('button')),
               n: (state.talks || []).length,
               deb: (state.talks || [])[0] && (state.talks || [])[0].debrief };
    });
    chk('分析失败要说原因 + 给重试', /没生成出来/.test(r.text) && r.retry, r.text.slice(0, 40));
    chk('但这一局还是存进了历史（分析为空，之后可以补）', r.n === 1 && r.deb === null,
      JSON.stringify({ n: r.n, deb: r.deb }));
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ============================================== 七、老存档（没有 talks 键） */
  console.log('\n[七、老存档：没有 talks 这个键也不能崩]');
  {
    const p = await browser.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.addInitScript(() => {
      localStorage.setItem('eq-state-v2', JSON.stringify({ srs: {}, cal: {}, lessons: {} }));
    });
    await p.goto(OFFLINE);
    await p.waitForTimeout(400);
    const r = await p.evaluate(() => {
      setAiSubview('voice');
      renderTalkSetup();
      openTalkHistory();
      const t = document.querySelector('#view').textContent;
      return { isArr: Array.isArray(state.talks), t };
    });
    chk('老存档进历史页不崩，显示"还没有记录"', r.isArr && /还没有记录/.test(r.t), r.t.slice(0, 30));
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ============== 八、麦克风权限 —— 整块删除
   *
   * 这一节原来测的是「权限没给时 App 自己要一次、点了允许接着把收音跑起来、
   * 拒绝之后不留一个永远等着的状态、老桥没有 requestMic 时降级成一句说明」。
   * 麦克风本身已经删了（manifest 的 RECORD_AUDIO 也一起删了），
   * micTap / V.pendingMic / requestMic 都不存在了，所以整节删除。
   */

  /* ==================================== 九、没结束也存、还能接着聊 */
  console.log('\n[九、中途就存 + 接着聊（不用先点结束）]');
  {
    const { p, errs } = await open();
    // 说一轮就走人——不点结束
    await p.evaluate(async (args) => {
      V.native = null; V.caps = { tts: false, asr: false, http: false, mic: false };
      window.llmCall = async (m) => (/复盘|分析/.test(m[0].content) ? args.debrief : args.turn);
      V.sess = null; V.ended = false;
      await startSession(args.good);
      await userSaid('你担心的是哪一块？');
      // 到这里就"走人"：不调 endSession
    }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(300);

    const mid = await p.evaluate(() => {
      const t = (state.talks || [])[0] || {};
      return { n: (state.talks || []).length, done: t.done, log: (t.log || []).length,
               sid: t.id, sessSid: V.sess && V.sess.sid };
    });
    chk('只聊了一轮、没点结束 → 历史里就已经有了',
      mid.n === 1 && mid.log === 1, JSON.stringify(mid));
    chk('而且标的是「没聊完」（done !== true）', mid.done !== true);
    chk('存的就是正在进行的这一局（id 对得上）', mid.sid === mid.sessSid);

    const list = await p.evaluate(() => {
      openTalkHistory();
      const t = document.querySelector('#view').textContent;
      return { t, live: !!document.querySelector('.his-go'),
               tag: (document.querySelector('.his-tag') || {}).textContent || '' };
    });
    chk('列表上标明「没聊完」', /没聊完/.test(list.t) && /没聊完/.test(list.tag), list.tag);
    chk('并且给一个「接着聊」的按钮', list.live && /接着聊/.test(list.t));

    // 切走再切回来：屏幕上的对话不能丢（这是原来真的会丢的）
    const back = await p.evaluate(() => {
      setAiSubview('checkup');          // 切到体检
      setAiSubview('voice');            // 切回对话
      const slot = document.getElementById('herSlot');
      return { txt: slot ? slot.textContent : '', n: slot ? slot.querySelectorAll('.her-card').length : 0 };
    });
    chk('切到别的子页再切回来，聊过的那几轮还在屏幕上',
      back.n >= 1 && /你担心的是哪一块/.test(back.txt), JSON.stringify({ n: back.n }));

    // 从历史里「接着聊」：把会话整个重建回来
    const res = await p.evaluate((args) => {
      const id = state.talks[0].id;
      V.sess = null; V.ended = false;      // 模拟"App 重开之后从历史里回来"
      resumeTalk(id);
      const slot = document.getElementById('herSlot');
      return {
        sc: V.sess && V.sess.sc && V.sess.sc.title,
        opening: V.sess && V.sess.sc && V.sess.sc.opening,
        sid: V.sess && V.sess.sid, ended: V.ended,
        hist: (V.sess && V.sess.history || []).map((h) => h.role).join(','),
        histText: (V.sess && V.sess.history || []).map((h) => h.content).join('|'),
        logLen: (V.sess && V.sess.log || []).length,
        // 屏幕上要能看到前面聊过的（她的开场 + 那一轮）
        shown: slot ? slot.textContent : '',
        cards: slot ? slot.querySelectorAll('.her-card').length : 0,
        bubbles: slot ? slot.querySelectorAll('.bub.me').length : 0,
        turns: V.sess && V.sess.turn,
        temp: V.sess && V.sess.temp,
      };
    }, {});
    chk('接着聊 → 场景还原（标题、开场白都在）',
      res.sc === GOOD.title && res.opening === GOOD.opening, JSON.stringify({ sc: res.sc }));
    chk('接着聊 → 会话 id 还是原来那条（不会另开一条历史）', res.sid === mid.sid, String(res.sid));
    chk('接着聊 → 结束状态被清掉（可以继续聊）', res.ended === false);
    chk('接着聊 → 给模型的上下文按原形状重建（开局元消息 + 开场白 + 一来一往）',
      res.hist === 'user,assistant,user,assistant', res.hist);
    chk('上下文里带着他当时说的原话', /你担心的是哪一块/.test(res.histText));
    chk('接着聊 → 温度、轮数接着原来的算', res.turns >= 2 && res.temp === TURN.temp,
      JSON.stringify({ turns: res.turns, temp: res.temp }));
    chk('接着聊 → 屏幕上把前面聊过的重放出来（她的开场 + 她那一句 + 我说的那句）',
      res.cards >= 2 && res.bubbles >= 1 && /你担心的是哪一块/.test(res.shown),
      JSON.stringify({ cards: res.cards, bubbles: res.bubbles }));

    // 接着聊之后又来一轮：还是同一条记录，不是新的一条
    await p.evaluate(async (args) => {
      window.llmCall = async (m) => (/复盘|分析/.test(m[0].content) ? args.debrief : args.turn);
      await userSaid('那你先说说你担心哪一块？');
      // 系统开启后如果 history 接错了，上面这句会带着错误上下文——这里只查记录有没有续上
      endSession();
    }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(500);
    const cont = await p.evaluate(() => {
      const t = (state.talks || [])[0] || {};
      return { n: (state.talks || []).length, done: t.done, log: (t.log || []).length,
               hasDeb: !!(t.debrief && t.debrief.verdict) };
    });
    chk('接着聊完之后还是同一条记录（没多出一条）', cont.n === 1, String(cont.n));
    chk('接着聊的那一轮也进了逐轮记录', cont.log === mid.log + 1,
      `${mid.log} → ${cont.log}`);
    chk('点过结束之后 done 变成 true，并且有分析', cont.done === true && cont.hasDeb,
      JSON.stringify(cont));

    // 已结束的那一局不能再「接着聊」（应该用再来一局重开）
    const noResume = await p.evaluate(() => {
      const id = state.talks[0].id;
      const before = JSON.stringify(V.sess && V.sess.sid);
      resumeTalk(id);
      return { same: JSON.stringify(V.sess && V.sess.sid) === before, toast: document.body.textContent };
    });
    chk('已经结束的一局不会被「接着聊」覆盖掉当前会话', noResume.same === true);
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ============================== 十、离开 App 再回来，必须一步接得上
   *
   * 用户的原话：「认知训练中AI模块上下文很容易丢失。」
   * 实测定位：在 App 里切页**不丢**（第九节那条守着）；丢的是"离开 App 再回来"——
   * 手机上被系统杀掉 / 划掉 / 放置太久重建 WebView，内存里的会话就没了。
   * 内容其实一直在（逐轮都存了），丢的是"他知道还能接着聊"这件事：
   * 回来只看到一个干净的选场景页，那条没聊完的记录躺在历史里要自己翻。
   * 所以这一节钉的是**入口**：AI 首页最上面那张「上次没聊完」的卡。 */
  console.log('\n[十、离开 App 再回来：顶部要有「上次没聊完」，一步接得上]');
  {
    /* 这一节**不能用 open()**：它用 addInitScript 在每次导航时把存档重置成空，
       而这里要验的恰恰是"重载之后存档还在、并且一眼能接上"——用它会自己把
       记录清掉，看起来就像这张卡没做出来（第一版就是这么红的）。 */
    const p = await browser.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE);
    await p.evaluate(() => localStorage.setItem('eq-state-v2', JSON.stringify({ talks: [] })));
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    await p.evaluate(async (args) => {
      V.native = null; V.ended = false; V.sess = null;
      state.talks = []; state.genScenes = []; save();
      /* 每次返回**一份新的**：nextTurn 会往返回值上写 userText / temp 这些字段，
         两次调用共用同一个对象的话，第二轮会把第一轮那条记录里的 userText 覆盖掉——
         看起来像"第一句丢了"，其实是桩串了（第一版就是这么红的）。 */
      window.llmCall = async (m) => Object.assign({},
        /复盘|分析/.test(m[0].content) ? args.debrief : args.turn);
      await startSession(args.good);
      await userSaid('你担心的是哪一块？');
      await userSaid('那你想怎么办？');
    }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(200);

    const empty = await p.evaluate(() => {
      // 刚开局时（没有"没聊完"的记录）这张卡不该出现
      const before = state.talks.slice();
      state.talks = [before[0] ? Object.assign({}, before[0], { done: true }) : {}].filter((x) => x.id);
      renderTalkSetup();
      const hasCard = !!document.querySelector('.resume-card');
      state.talks = before;
      return { hasCard };
    });
    chk('没有没聊完的局时，这张卡不出现', empty.hasCard === false, String(empty.hasCard));

    // 真正的那一步：整页重载（= 手机上被系统杀掉再打开）
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const after = await p.evaluate(() => {
      document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
      go('ai'); setAiSubview('voice');
      const card = document.querySelector('.resume-card');
      return {
        hasSess: !!V.sess,
        hasCard: !!card,
        isFirst: card ? document.querySelector('#view .card') === card : false,
        text: card ? card.textContent : '',
        btn: card ? (card.querySelector('button') || {}).getAttribute
          ? card.querySelector('button').getAttribute('onclick') : '' : '',
        rounds: (state.talks[0] || {}).log ? state.talks[0].log.length : -1,
      };
    });
    chk('重载之后内存里的会话确实没了（这就是"上下文丢失"那一步）', after.hasSess === false);
    chk('重载之后顶部出现「上次没聊完」', after.hasCard && /上次没聊完/.test(after.text), after.text.slice(0, 40));
    chk('它在最上面（不用往下翻）', after.isFirst === true);
    chk('写了这一局的情况（轮数按"你回过几次"算）',
      new RegExp(`聊了 ${after.rounds} 轮`).test(after.text), `${after.rounds} 轮 → ${after.text.slice(0, 60)}`);
    chk('按钮直接指向接着聊', /resumeTalk\('/.test(after.btn), after.btn);

    const resumed = await p.evaluate(async () => {
      const btn = document.querySelector('.resume-card button');
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const slot = document.getElementById('herSlot');
      return {
        hasSess: !!V.sess, log: (V.sess && V.sess.log || []).length,
        shown: slot ? slot.textContent : '',
        cards: slot ? slot.querySelectorAll('.her-card').length : 0,
        bubbles: slot ? slot.querySelectorAll('.bub.me').length : 0,
        input: !!document.getElementById('typeIn'),
      };
    });
    chk('点它真的接上了（会话重建、输入框回来了）',
      resumed.hasSess && resumed.log >= 2 && resumed.input,
      JSON.stringify({ log: resumed.log, input: resumed.input }));
    chk('屏幕上把之前聊过的重放出来了（一进来就能接着往下说）',
      resumed.cards >= 2 && resumed.bubbles >= 2 && /你担心的是哪一块/.test(resumed.shown),
      JSON.stringify({ cards: resumed.cards, bubbles: resumed.bubbles,
                       shown: (resumed.shown || '').replace(/\s+/g, ' ').slice(0, 120) }));

    // 聊完之后这张卡要消失
    await p.evaluate(async (args) => {
      window.llmCall = async (m) => (/复盘|分析/.test(m[0].content) ? args.debrief : args.turn);
      endSession();
    }, { turn: TURN, debrief: DEBRIEF });
    await p.waitForTimeout(500);
    const gone = await p.evaluate(() => {
      V.sess = null; renderTalkSetup();
      return { hasCard: !!document.querySelector('.resume-card'),
               done: (state.talks[0] || {}).done };
    });
    chk('点过结束之后这张卡就不再出现了', gone.hasCard === false && gone.done === true,
      JSON.stringify(gone));
    chk('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  await browser.close();
  console.log(bad ? `\n结果：${bad} 项未通过` : '\n结果：全部通过');
  process.exit(bad ? 1 : 0);
})();
