/* 「接话提示」+「模型给白话时直接当她的话」两件事的检查。
 *
 * 这两条都是用户的原话：
 *   1. 「我对话的时候，有时候完全不知道怎么回，能不能给提示呢？就在旁边，
 *      点击可以查看提示。我感觉我完全不会说话了。」
 *   2. 「他的对话还会加上一个前缀，叫做返回的不是json。这个前缀删掉，
 *      直接输出对话就行。」
 *
 * 两条最要紧的断言不是"按钮能点"，而是：
 *   · 提示**必须是本地的**——他卡住那一刻最需要帮助，那时如果要等模型、
 *     或者因为没密钥/没网而不可用，这个功能就等于不存在。所以这里要验
 *     「打开提示一次模型调用都没有」。
 *   · 提示给的是方向不是答案，而且**不同形状的话要给不同方向**
 *     （写死一个方向等于没提示）。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

const SC = {
  id: 's1', title: '刚认识两周，第一次单独出来', stage: '认识试探', difficulty: 2,
  her: '26 岁，做设计的，性格偏慢热。', her_state: '她有点紧张，也怕尴尬。',
  opening: '你好，等很久了吗？', goal: '让她放松地说话', trap: '一直找话题表现自己',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    window.__calls = [];
    // 原生桥：记录每一次模型调用（提示那条必须一次都不多）
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, asr: false, asrAct: false, http: true, mic: true, music: false }),
      voices: () => '[]', currentVoice: () => '', speak: () => {}, stopSpeak: () => {},
      listen: () => {}, stopListening: () => {}, setVoice: () => {},
      httpPost: async (id, url, hdrs, body) => {
        window.__calls.push(JSON.parse(body));
        const spec = window.__nextReply || { content: '{"reply":"嗯","tone":"平淡","inner":"x","signal":"y","rating":"平","rating_why":"z","temp":50,"temp_delta":0}' };
        window.__onHttp(id, JSON.stringify({ status: 200, body: JSON.stringify({
          model: 'deepseek-flash', usage: { prompt_tokens: 900, completion_tokens: 80 },
          choices: [{ message: spec, finish_reason: spec.__finish || 'stop' }] }) }));
      },
    };
    // 关键：V.native 是**载入时**捕获的，页面加载完再挂 window.EQNative 不会自动生效
    // （这个项目的老坑，原生桥那一整片都是这个形状），所以这里必须显式接上再探一次能力。
    V.native = window.EQNative;
    probeNative();
    saveSettings({ apiKey: 'sk-test', autoSpeak: false, audioAsk: false });
  });

  console.log('[一、提示按钮在旁边，而且是本地的（不调模型）]');
  await p.evaluate(async (sc) => {
    // 现成场景带开场白，开局这一步本来就不调模型（forcedReply 那条路）。
    // 这里**不能**覆盖 window.llmCall —— 那会把整条发送链路短路掉，
    // 于是"调了几次模型"数的是假的（第一版就是这么红的）。
    await startSession(sc);
  }, SC);
  const btn = await p.evaluate(() => {
    const b2 = document.getElementById('hintBtn');
    const row = b2 ? b2.parentElement : null;
    const input = document.getElementById('typeIn');
    return {
      exists: !!b2, text: b2 && b2.textContent.trim(),
      sameRowAsInput: !!(row && input && row.contains(input)),
      inTalk: !!(b2 && document.getElementById('talkCard') && document.getElementById('talkCard').contains(b2)),
    };
  });
  chk('对话页里有一个「提示」按钮，而且就在输入框旁边',
    btn.exists && /提示/.test(btn.text) && btn.sameRowAsInput && btn.inTalk, JSON.stringify(btn));

  const open = await p.evaluate(() => {
    window.__calls = [];
    toggleTalkHint();
    const p2 = document.getElementById('talkHint');
    const move = talkMove(pickTalkMove(lastHerLine()).id);
    return { text: p2.textContent, html: p2.innerHTML, calls: window.__calls.length, moveId: move && move.id,
             btnText: document.getElementById('hintBtn').textContent.trim() };
  });
  chk('打开提示**一次模型调用都没有**（本地规则，断网/没密钥也能用）',
    open.calls === 0, `模型调用 ${open.calls} 次`);
  chk('提示里有方向、做法、句式骨架、容易犯的错',
    open.text.length > 60 && /句式/.test(open.text) && /容易犯/.test(open.text) && /可以照着说/.test(open.text),
    open.text.replace(/\s+/g, ' ').slice(0, 70));
  chk('明确写了这是按形状猜的，不是标准答案',
    /按她那句话的形状猜/.test(open.text) && /不是标准答案/.test(open.text));
  chk('提示里没有露出 markdown 的 **', open.html.indexOf('**') < 0);
  chk('按钮变成「收起」', open.btnText === '收起', open.btnText);

  const shapes = await p.evaluate(() => {
    const cases = [
      ['今天好累啊，项目一直改需求', '累/烦这类情绪'],
      ['你平时周末都干嘛？', '问句'],
      ['嗯', '很短'],
      ['哈哈我连糊锅都糊不明白', '自嘲'],
      ['我最近在想要不要换个工作，现在这个项目组人一直在走，我也学不到东西，钱也没涨，投了几份简历也没什么回音，前后折腾了快半年了，一直没定下来', '长段'],
    ];
    return cases.map(([line, why]) => ({ line: line.slice(0, 12), why,
      id: pickTalkMove(line).id, n: (talkMove(pickTalkMove(line).id) || {}).name }));
  });
  const uniq = [...new Set(shapes.map((x) => x.id))];
  chk('不同形状的话给不同方向（不是写死一个方向）', uniq.length >= 4, shapes.map((x) => `${x.why}→${x.id}`).join(' / '));
  chk('情绪句挑的是「先接情绪」', shapes[0].id === 'feel', shapes[0].id);
  chk('问句挑的是「先答再递回去」', shapes[1].id === 'answer_ask', shapes[1].id);
  chk('一两个字的短回应挑的是「把话头递过去」', shapes[2].id === 'pass_back', shapes[2].id);
  chk('自嘲挑的是「顺着玩」', shapes[3].id === 'play', shapes[3].id);
  chk('长段挑的是「先接住重点」', shapes[4].id === 'summarize', shapes[4].id);

  console.log('\n[二、要一句示范：只点它才调模型，而且给白话就收]');
  const demo = await p.evaluate(async () => {
    window.__calls = [];
    // 模型这次**回了一句白话**（没按 JSON），也要能当成示范用
    window.__nextReply = { content: '听起来今天把你折腾得够呛。' };
    await talkHintDemo();
    const box = document.getElementById('hintDemo');
    return { calls: window.__calls.length, text: box ? box.textContent : '',
             tries: window.__calls.map((c) => c),
             hasBtn: !!(box && box.querySelector('button')),
             promptHasRules: (window.__calls[0] && JSON.stringify(window.__calls[0].messages[0].content) || '').slice(0, 40) };
  });
  chk('点「给我一句」只调一次模型', demo.calls === 1, `模型调用 ${demo.calls} 次`);
  chk('**这一步不带 response_format**（要的是白话一句；带了它模型会去回 JSON）',
    demo.tries[0] && !demo.tries[0].response_format,
    JSON.stringify(demo.tries[0] ? Object.keys(demo.tries[0]) : null));
  chk('模型回的是白话（不是 JSON）也能当示范显示出来',
    /听起来今天把你折腾得够呛/.test(demo.text), demo.text.replace(/\s+/g, ' ').slice(0, 50));
  chk('示范旁边给了「填进输入框，我改一改」和「再给我一句」', demo.hasBtn);

  // 模型偶尔还是回个 JSON（实测见过 {"suggestion":"…"}）——也要把那句人话捞出来，
  // 而不是显示成空白。
  const jsonish = await p.evaluate(async () => {
    window.__nextReply = { content: '{"suggestion":"那你想去什么样的地方啊?"}' };
    await talkHintDemo();
    return { demo: HINT.demo, text: document.getElementById('hintDemo').textContent };
  });
  chk('万一它还是回了个 JSON，也能把那句话捞出来（不是空白）',
    /想去什么样的地方/.test(jsonish.demo), jsonish.demo);

  const useIt = await p.evaluate(() => {
    useDemo();
    // 比对**当前**那个示范，而不是写死某一个字符串：
    // 上面刚测过"回 JSON 也要捞出来"，HINT.demo 已经不是最早那句了
    // （第一版写死了最早那句，于是这条红在一个无关的地方）。
    return { v: document.getElementById('typeIn').value, demo: HINT.demo,
             toast: document.getElementById('toast').textContent };
  });
  chk('填进输入框之后提示要改一改（照着念练不到东西）',
    useIt.v === useIt.demo && useIt.v.length > 2 && /改/.test(useIt.toast),
    `${useIt.v} / ${useIt.toast}`);

  console.log('\n[三、提示会在她说下一句时自动收起（过期的建议更误导）]');
  const clear = await p.evaluate(() => {
    openTalkHint();     // 用 open 而不是 toggle：toggle 在"已经是打开"的时候会把它关掉
    const before = document.getElementById('talkHint').textContent.length;
    showHerTurn({ reply: '那你呢？', tone: '平淡', inner: 'x', signal: 'y', rating: '平', rating_why: 'z', temp: 52 });
    return { before, after: document.getElementById('talkHint').textContent.length,
             btn: document.getElementById('hintBtn').textContent.trim() };
  });
  chk('她说完下一句之后提示自动收起', clear.before > 0 && clear.after === 0 && clear.btn === '提示',
    `收起前 ${clear.before} 字 → 收起后 ${clear.after} 字`);

  console.log('\n[四、模型给白话时，对话区直接显示她的话（不再出现「返回的不是 JSON」）]');
  const plain = await p.evaluate(async () => {
    window.__calls = [];
    // 这一轮模型完全不按 JSON 回，只给一句人话
    window.__nextReply = { content: '我也就是随便逛逛，没什么计划。' };
    await userSaid('你今天有什么安排吗？');
    const view = document.getElementById('herSlot').textContent;
    return {
      view,
      // 「返回的不是 JSON」这行字一个字都不许出现在对话区
      hasJsonErr: /返回的不是 JSON|不是 ?json/i.test(view),
      logLen: (V.sess.log || []).length,
      lastRating: (V.sess.log[V.sess.log.length - 1] || {}).rating,
      lastInner: (V.sess.log[V.sess.log.length - 1] || {}).inner,
      calls: window.__calls.length,
    };
  });
  chk('她的话原样出现在对话里', /我也就是随便逛逛/.test(plain.view), plain.view.replace(/\s+/g, ' ').slice(-70));
  chk('**对话区不再出现「返回的不是 JSON」**', !plain.hasJsonErr, '');
  chk('并且说清了为什么没有内心/打分（不是空白）',
    /没有按格式输出/.test(plain.view) && /话本身是有效的/.test(plain.view));
  // 断言用「这一轮确实进了记录」，而不是写死条数——开局那一轮也会算进 turn，
  // 写死数字等于在数我自己的算术（第一版就是这么红在一个无关的地方）。
  // 缺省值那条查的是**它的意思**（有值、不是 undefined），不是某一句具体文案——
  // 查文案会让改一个字就红一次（第一版查的是「没有内心独白」，而代码写的是「没给内心独白」）。
  chk('这一轮仍然进记录，且补上了缺省值（下游不会读到 undefined）',
    plain.logLen >= 1 && plain.lastRating === '平'
    && String(plain.lastInner).length > 4 && !/undefined/.test(String(plain.lastInner))
    && /内心独白/.test(String(plain.lastInner)),
    `记录 ${plain.logLen} 条 / rating=${plain.lastRating} inner=${String(plain.lastInner).slice(0, 18)}`);
  chk('白话那一轮也只调了一次模型', plain.calls === 1, `模型调用 ${plain.calls} 次`);

  const turnBefore = await p.evaluate(() => V.sess.turn);
  const cont = await p.evaluate(async () => {
    // 白话那一轮之后还能继续正常对话（历史里存的是她那句话本身）
    window.__nextReply = { content: '{"reply":"没什么计划，就想随便走走。","tone":"温和","inner":"他问得挺自然","signal":"他在找话题","rating":"好","rating_why":"问得具体，接得住","temp":54,"temp_delta":4}' };
    await userSaid('那要不要去河边走走？');
    const view = document.getElementById('herSlot').textContent;
    return { ok: /没什么计划，就想随便走走/.test(view), turn: V.sess.turn, logLen: V.sess.log.length,
             histLast: V.sess.history[V.sess.history.length - 1].content.slice(0, 20) };
  });
  chk('白话那一轮之后，下一轮照常按 JSON 走（没有把状态搞坏）',
    cont.ok && cont.turn === turnBefore + 1 && cont.logLen >= 2,
    `turn ${turnBefore} → ${cont.turn}`);

  console.log('\n[五、没填密钥时，提示仍然能用（骨架那段就是为这个准备的）]');
  const nokey = await p.evaluate(async () => {
    saveSettings({ apiKey: '' });
    window.__calls = [];
    toggleTalkHint();
    const openText = document.getElementById('talkHint').textContent;
    await talkHintDemo();
    return { calls: window.__calls.length, toast: document.getElementById('toast').textContent,
             openLen: openText.length, hasSkeleton: /可以照着说/.test(openText) };
  });
  chk('没密钥时打开提示照常有内容', nokey.openLen > 60 && nokey.hasSkeleton);
  chk('没密钥时要示范会说明情况，而且不白发请求',
    nokey.calls === 0 && /密钥|骨架/.test(nokey.toast), `调用 ${nokey.calls} 次 / ${nokey.toast}`);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
