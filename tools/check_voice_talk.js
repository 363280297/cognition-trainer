/* 打字对话 / 随机场景 / 对话后复盘 的检查。
 *
 * 用户的原话（纠正我上一版的误解）：
 *   「你要加入一个语音输入，相当于跟大模型对话。是自己选择场景，或者说你随机
 *     给我一些场景，让我自己来训练，随机的。然后对话完之后给我评价，以及改进措施。」
 *
 * 后来用户又把这套语音输入整个否掉了：
 *   「做情景模拟 ai 对话的时候，等他说完话，我这边就会自动录音，停止这个功能。
 *     直接把这个录音的功能删除。我直接打字算了。」
 * 所以 2.31 把「听你说话」（麦克风 + 语音识别 + 免提循环）整块删掉了。
 *
 * **这个文件里最要紧的一段现在是「打字回她」那一节。**
 *
 * 原来这里装了一个 native 桩，把 __onSpeech / __onSpeak 手动打进去，验免提状态机的
 * 三条不变式（出声期间绝不开麦 / 没听到声音不许无限重试 / 打断之后状态要落回来）。
 * 那些函数（startListen / stopListen / micTap / setHandsFree / maybeAutoListen /
 * onNoSpeech / setPhase / renderTalkBar / window.__onSpeech / V.hf / V.phase /
 * V.noSpeech / V.pendingMic）在 public/ 里一个都不剩了，所以连同那几条断言一起删除——
 * **不是**换个写法糊回来。免提不存在了，就不该有断言假装它还在。
 *
 * 删掉语音输入之后，输入方式只剩打字。所以「打字 → 她回 → 逐轮记录 → 追问计数」
 * 这条链现在是唯一的对话入口，必须由这个文件盯着：它坏掉的症状和当初免提那三条
 * 一样——不抛异常、不打印错误，只是「感觉不好用」。
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

const GOOD = {
  title: '周会上被同事当面否了方案', stage: '同事', difficulty: 2,
  her: '同组男同事，比你早来一年，能力强但话直',
  her_state: '他不是针对你，是想让项目别翻车，但没意识到当众说会让人下不来台',
  opening: '这个方案我觉得有问题，你改完再说吧。',
  goal: '把分歧留在事上，同时让他知道当众这样说你不舒服',
  trap: '当场反驳他，把技术分歧变成谁对谁错',
};

const TURN = {
  reply: '好吧，那你说说看。', tone: '平淡',
  inner: '他倒是没急着辩解，我先听听。', signal: '接住了，但没有追下去',
  rating: '好', rating_why: '没有当场顶回去', temp: 54, temp_delta: 4,
};

const DEBRIEF = {
  verdict: '这一局你没有当场反驳，这是对的。但整局没有一个追问，所以话题一直停在事上，没往人身上走。',
  pattern: '你一直在回答，没有一次把话头递回去。',
  keeps: ['被当面否定时先问了一句「你担心哪一块」', '没有用「但是」接他的话'],
  fixes: [{ act: '至少追问一次他的顾虑', say: '你最担心的是哪一块？我想先听这个。',
            why: '追问会让他觉得你真在听，而不是等着轮到自己说。' }],
  one: '每一局至少追问一次对方刚说的细节',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    V.native = null; V.sess = null; V.ended = false;
    go('ai'); setAiSubview('voice');
  });

  // ---------------------------------------------------------------- 设置页
  console.log('\n[设置页：三条路都要有——现成的、自己写的、随机的]');
  const setup = await p.evaluate(() => {
    const presets = [...document.querySelectorAll('.seed.preset')];
    return {
      presetCount: presets.length,
      presetClickable: presets.every((x) => /startSession\('/.test(x.getAttribute('onclick') || '')),
      firstPresetTitle: presets.length ? presets[0].querySelector('b').textContent.trim() : '',
      hasRandom: !!document.getElementById('randBtn'),
      hasPrompt: !!document.getElementById('scenePrompt'),
      hasBuild: !!document.getElementById('buildBtn'),
      seedCount: document.querySelectorAll('.seed:not(.preset)').length,
      // 点开就练的入口不能悄悄开始一局，也不能缺少元信息
      presetHasMeta: presets.every((x) => (x.querySelector('.seed-meta') || {}).textContent),
    };
  });
  chk('现成场景列表回来了（上一版被我删掉了）', setup.presetCount >= 6, `${setup.presetCount} 个`);
  chk('现成场景是可点开就练的（不是只能填提示词）', setup.presetClickable, setup.firstPresetTitle);
  chk('现成场景标了关系阶段和难度', setup.presetHasMeta);
  chk('有「随机来一个」', setup.hasRandom);
  chk('提示词和「建造」都还在', setup.hasPrompt && setup.hasBuild);
  chk('示例提示词也还在', setup.seedCount >= 5, `${setup.seedCount} 条`);

  /* ------------------------------------------------- 按缺口造一个（原来的「随机」）
   *
   * 2.32 把这条路改了形状，用户拍板的话：「不能随机生成，只要有环境，你得给一些
   * 比较好的提示词让 AI 生成」，选的是「只按缺口铺开」。
   * 所以原来那四条断言（五轴零件拼装、弱项喂进提示词、每次零件都不同）**整块作废**——
   * 它们守的东西已经不存在了。换成守新形状的四条：缺口算得对、枚举给全、
   * 已有标题拿去去重、弱项**不再**掺进生成（这是他明确选的，得钉住）。 */
  console.log('\n[按缺口造一个：造什么由缺口表决定，不是掷骰子]');
  const rand = await p.evaluate(async (GOOD) => {
    const saved = window.llmCall;
    let sent = '';
    window.llmCall = async (m) => { sent = m[1].content; return GOOD; };
    // 偏差画像本身照旧要能算（它还在给卡片加权，只是不再影响造场景）
    state.bias['字面化'] = 5; state.bias['过度让步'] = 4;
    const focus = biasFocus();
    const gap = sceneGap();
    const taken = sceneTaken();
    const prompt = randomPrompt();
    const libBefore = genScenes().length;
    document.getElementById('randBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    const r = {
      focus, prompt, sent, gap,
      takenTitles: taken.titles,
      libBefore, libAfter: genScenes().length,
      hasSess: !!V.sess, title: V.sess && V.sess.sc.title,
      // 原来那套零件拼装的写法，一个都不该再出现
      oldParts: ['关系是', '场合是', '我要练的是', '难度来源', '最容易犯的错'].filter((x) => prompt.includes(x)),
      stagesGiven: SCENE_STAGES.every((k) => prompt.includes(k)),
    };
    window.llmCall = saved;
    return r;
  }, GOOD);
  chk('偏差画像算出了弱项（它还在给卡片加权）', rand.focus.length >= 1, JSON.stringify(rand.focus));
  chk('造场景的 brief 点名了最缺的关系（缺口表算得对）',
    rand.gap.order.slice(0, 3).every((k) => rand.prompt.includes(k)),
    `缺口顺序：${rand.gap.order.join('>')}`);
  chk('brief 里给了固定的关系枚举（关系名不许自己编，否则分组全废）',
    rand.stagesGiven);
  chk('已有的标题被拿去去重了（含 14 个现成的）',
    rand.takenTitles.length >= 14 && rand.prompt.includes(rand.takenTitles[0]),
    `${rand.takenTitles.length} 个`);
  chk('五轴零件拼装已经删干净（不再出现"关系是「」、场合是「」"）',
    rand.oldParts.length === 0, rand.oldParts.join('、'));
  chk('弱项不再掺进造场景（用户选的是"只按缺口铺开"）',
    rand.focus.every((f) => !rand.prompt.includes(f)), JSON.stringify(rand.focus));
  chk('点「按缺口造一个」直接开局', rand.hasSess && rand.title === GOOD.title, String(rand.title));
  chk('造的这一个也进库了（造过的留着，回头能再练）',
    rand.libAfter === rand.libBefore + 1, `${rand.libBefore} → ${rand.libAfter}`);

  /* ------------------------------------------------- 打字回她（唯一的输入方式）
   *
   * 这一段是原来「免提状态机」那一节的位置。免提删掉之后，用户怎么说一句话
   * 这件事就只剩打字这一条路了——所以它成了这个文件里最该盯的链路：
   *   输入框 #typeIn → sendTyped() → userSaid() → nextTurn() → 她的回话进 #herSlot
   * 而且每一轮都要落进 V.sess.log（复盘要引用用户的原话）。
   *
   * 走**真实入口**，不直接调 userSaid：点「发出」按钮、以及在输入框里敲回车——
   * 这两条是用户在界面上真正会做的事，也是唯一能证明「输入框还接得上」的方式。
   * （以前这里断言的是 autoListen / micTap / phase 文案，那些跟着功能一起删了。）
   */
  console.log('\n[打字回她：输入框 → 发出 / 回车 → 她回话 + 逐轮记录]');
  const typed = await p.evaluate(async (args) => {
    V.native = null; V.caps = { tts: false, http: false, music: false };
    V.sess = null; V.ended = false;
    window.llmCall = async () => args.turn;
    await startSession(args.good);

    const slot = document.getElementById('herSlot');
    const el = document.getElementById('typeIn');
    const before = {
      cards: slot.querySelectorAll('.her-card').length,       // 她的开场白已经在那儿
      bubbleBefore: slot.querySelectorAll('.bub.me').length,
      hasInput: !!el,
      placeholder: el ? el.placeholder : '',
      hasSendBtn: !![...document.querySelectorAll('#talkCard button')]
        .find((x) => x.textContent.trim() === '发出'),
      meterBefore: document.getElementById('askMeter').textContent,
    };

    // 第一条：点「发出」
    el.value = '你担心的是哪一块？';
    [...document.querySelectorAll('#talkCard button')]
      .find((x) => x.textContent.trim() === '发出').click();
    await new Promise((r) => setTimeout(r, 400));
    const one = {
      bubbles: [...slot.querySelectorAll('.bub.me')].map((x) => x.textContent),
      cards: slot.querySelectorAll('.her-card').length,
      lastHer: (slot.querySelector('.her-card:last-child .her-line') || {}).textContent,
      cleared: el.value,
      meter: document.getElementById('askMeter').textContent,
      log: V.sess.log.length,
      userText: (V.sess.log[0] || {}).userText,
      asked: V.sess.asked,
      followUps: V.sess.followUps,
    };

    // 第二条：在输入框里敲回车（框里写着「回车也能发」）
    el.value = '那你当时是怎么想的？';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const two = {
      bubbles: [...slot.querySelectorAll('.bub.me')].map((x) => x.textContent),
      cards: slot.querySelectorAll('.her-card').length,
      lastHer: (slot.querySelector('.her-card:last-child .her-line') || {}).textContent,
      cleared: el.value,
      meter: document.getElementById('askMeter').textContent,
      log: V.sess.log.length,
      userText2: (V.sess.log[1] || {}).userText,
      asked: V.sess.asked,
      followUps: V.sess.followUps,
    };
    return { before, one, two };
  }, { good: GOOD, turn: TURN });

  chk('对话页上有那个输入框，而且写明可以打字/回车',
    typed.before.hasInput && /打字/.test(typed.before.placeholder) && /回车/.test(typed.before.placeholder),
    typed.before.placeholder);
  chk('输入框旁边就是「发出」', typed.before.hasSendBtn);
  chk('开局时她的开场白已经画进 #herSlot（不是空屏）', typed.before.cards === 1,
    String(typed.before.cards));
  chk('还没说话时不假报提问数', /还没提过问题/.test(typed.before.meterBefore), typed.before.meterBefore);

  chk('点「发出」→ 我说的那句进了 #herSlot',
    typed.one.bubbles.length === typed.before.bubbleBefore + 1
    && /你担心的是哪一块/.test(typed.one.bubbles.join('')), typed.one.bubbles.join(' / '));
  chk('她回的那句也进 #herSlot（一轮一卡）',
    typed.one.cards === typed.before.cards + 1 && /那你说说看/.test(typed.one.lastHer || ''),
    `${typed.before.cards} → ${typed.one.cards}「${typed.one.lastHer}」`);
  chk('发出去之后输入框清空（不用手动删）', typed.one.cleared === '', JSON.stringify(typed.one.cleared));
  chk('这一轮进了逐轮记录（复盘要引用原话）',
    typed.one.log === 1 && typed.one.userText === '你担心的是哪一块？',
    `${typed.one.log} 轮 / ${typed.one.userText}`);

  chk('在输入框里敲回车也能发（不是只有按钮能用）',
    typed.two.bubbles.length === typed.one.bubbles.length + 1
    && /那你当时是怎么想的/.test(typed.two.bubbles.join('')), typed.two.bubbles.join(' / '));
  chk('回车发的那一轮同样有她的回话和记录',
    typed.two.cards === typed.one.cards + 1 && typed.two.log === 2
    && typed.two.userText2 === '那你当时是怎么想的？',
    `卡 ${typed.two.cards} / 记录 ${typed.two.log} / ${typed.two.userText2}`);

  chk('提问计数跟着走（提了 2 个问题）',
    typed.two.asked === 2 && /提了 2 个问题/.test(typed.two.meter || ''), typed.two.meter);
  chk('追问被单独认出来（「那你当时」这种指代回指也算追问，不靠字面重合）',
    typed.two.followUps === 1 && /其中 1 个/.test(typed.two.meter || '')
    && /刚才这个就是追问/.test(typed.two.meter || ''), typed.two.meter);
  chk('计数只在会话里，不写死（第一轮确实没被当成追问）', typed.one.followUps === 0,
    String(typed.one.followUps));

  // ---------------------------------------------------------------- 复盘
  console.log('\n[对话后：评价 + 改进措施]');
  await p.evaluate(async (args) => {
    V.native = null; V.caps = { tts: false, http: false, music: false };
    V.sess = null; V.ended = false;
    window.llmCall = async (m) => {
      // 第一次是开场白那一轮，之后是复盘：用 system 里有没有「复盘」区分
      return /复盘/.test(m[0].content) ? args.debrief : args.turn;
    };
    await startSession(args.good);
    await userSaid('你担心的是哪一块？我想先听这个。');
    // 补一个「漏着」的回合：这样「最该回头看的一句」那张卡才会渲染，
    // 才能验证加了复盘卡之后别的卡没被挤掉（我第一版的数据里全是「好」，白测了这一条）
    V.sess.log[0].rating = '漏着';
    V.sess.log[0].rating_why = '只顾着解释方案，没接住他的担心';
  }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
  await p.evaluate(() => endSession());
  await p.waitForTimeout(500);
  const deb = await p.evaluate(() => {
    const t = document.getElementById('view').textContent;
    return {
      hasCard: !!document.getElementById('debriefBody'),
      filled: !!document.querySelector('.deb-verdict'),
      hasFix: !!document.querySelector('.deb-fix'),
      hasSay: !!document.querySelector('.deb-say'),
      hasOne: !!document.querySelector('.deb-one'),
      hasKeeps: !!document.querySelector('.deb-list li'),
      text: t.slice(0, 0),
      verdict: (document.querySelector('.deb-verdict') || {}).textContent,
      say: (document.querySelector('.deb-say') || {}).textContent,
      // 统计那一块还在（不能为了加复盘把原来的内容挤掉）
      stillHasAsk: /提了多少问题/.test(t),
      stillHasWorst: /最该回头看的一句/.test(t),
      ended: V.ended === true,
    };
  });
  chk('结束页有复盘区', deb.hasCard && deb.filled);
  chk('给出了整体评价', (deb.verdict || '').length > 10, String(deb.verdict).slice(0, 40));
  chk('给出了要改的动作', deb.hasFix);
  chk('每条改进带「下一次可以这么说」的原话', deb.hasSay, String(deb.say).slice(0, 40));
  chk('给出了「下一局只盯这一件事」', deb.hasOne);
  chk('做对的也列了', deb.hasKeeps);
  chk('原来的统计没有被挤掉（提问数、最该回头看的一句）', deb.stillHasAsk && deb.stillHasWorst);
  chk('结束之后这一局被标记为已结束', deb.ended === true);

  // 复盘的提示词要求引用原话、不许恭维
  const psys = await p.evaluate(async (DEBRIEF) => {
    let cap = null;
    const saved = window.llmCall;
    window.llmCall = async (m) => { cap = m; return DEBRIEF; };
    await makeDebrief(V.sess);
    window.llmCall = saved;
    return { sys: cap[0].content, user: cap[1].content };
  }, DEBRIEF);
  chk('复盘提示词要求引用原话', /引用原话|真正说过的话/.test(psys.sys));
  chk('复盘提示词明确说不许恭维', /不要恭维|不许恭维/.test(psys.sys));
  chk('复盘提示词要求给原话示例、禁掉「多倾听」这类空话', /可以这么说|原话示例/.test(psys.sys) && /多倾听/.test(psys.sys));
  chk('复盘真的把用户的原话和对方的内心一起送进去了',
    psys.user.includes('你担心的是哪一块') && /心里的想法/.test(psys.user),
    '');
  chk('复盘带上了她的开场白（否则判不出他第一句有没有接上）',
    psys.user.includes(GOOD.opening) && /她开口/.test(psys.user),
    '');
  chk('复盘的数据里有开场白这一轮', /第 0 轮/.test(psys.user));

  // 复盘失败要给重试，不许留一个空框
  console.log('\n[复盘失败：要说出来并给重试]');
  await p.evaluate(async () => {
    window.llmCall = async () => { throw new Error('模型返回 404'); };
    await fillDebrief();
  });
  await p.waitForTimeout(300);
  const dbad = await p.evaluate(() => {
    const b = document.getElementById('debriefBody');
    return { text: b ? b.textContent : '', retry: !!(b && b.querySelector('button')) };
  });
  chk('复盘失败会写出原因', /没生成出来/.test(dbad.text) && /404/.test(dbad.text), dbad.text.slice(0, 50));
  chk('复盘失败给一个「再试一次」', dbad.retry);

  // 再来一局：随机场景按 id 查不到，这是原来那个静默失效的 bug
  console.log('\n[再来一局：随机场景必须也能重开]');
  const replay = await p.evaluate(async (args) => {
    V.sess = null; V.ended = false;
    window.llmCall = async () => args.good;
    const sc = await buildScenario('随便练点什么');   // id 是 gen-…
    await startSession(sc);
    const genId = V.sess.sc.id;
    V.sess.log.push({ reply: 'x', rating: '平', temp: 50, userText: 'y', inner: 'z' });
    // 结束 → 点「再来一局」
    await new Promise((r) => setTimeout(r, 50));
    const beforeTitle = V.sess.sc.title;
    document.querySelector('button.primary').click();   // 再来一局
    await new Promise((r) => setTimeout(r, 300));
    return { genId, opened: !!V.sess, title: V.sess && V.sess.sc.title, beforeTitle };
  }, { good: GOOD });
  chk('随机场景的 id 是 gen- 开头（按 id 查不到，这正是原来那个 bug）', /^gen-/.test(replay.genId), replay.genId);
  chk('「再来一局」对随机场景真的能重开（原来点了没反应且不报错）',
    replay.opened && replay.title === replay.beforeTitle, `${replay.opened} / ${replay.title}`);

  // 人称：随机到男性角色时界面不能还写「她」
  console.log('\n[人称：跟着场景走]');
  const pron = await p.evaluate(async (args) => {
    V.sess = null; V.ended = false;
    window.llmCall = async () => args.turn;
    await startSession(Object.assign({}, args.good, { ta: '他' }));
    const t = document.getElementById('view').textContent;
    const before = {
      temp: /他的温度/.test(t), inner: /他的内心/.test(t), tone: /他的语气/.test(t),
      noShe: !/她的温度|她的内心|她的语气/.test(t),
    };
    V.sess = null;
    await startSession(args.good);            // 老场景没有 ta → 默认「她」
    const t2 = document.getElementById('view').textContent;
    return { before, fallback: /她的温度/.test(t2) && /她的内心/.test(t2) };
  }, { good: GOOD, turn: TURN });
  chk('男性角色时界面用「他」', pron.before.temp && pron.before.inner && pron.before.tone,
    JSON.stringify(pron.before));
  chk('男性角色时界面上没有残留的「她」', pron.before.noShe);
  chk('老场景（没有 ta 字段）仍然默认「她」', pron.fallback);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
