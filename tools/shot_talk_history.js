/* 给「对话历史」和自带离线识别的界面拍图，放进 output/。
   看图要看的三件事：小图标会不会撞上浮标、列表读不读得清、详情页的分析排版对不对。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const OUT = path.join(__dirname, '..', 'output');
fs.mkdirSync(OUT, { recursive: true });

const REC = (id, at, title, gen, turn, temp, goods, bads, deb) => ({
  id, at, gen, turn, temp, asked: 2, followUps: 1, goods, bads,
  sc: { id: gen ? 'gen-1' : 's1', title, ta: gen ? '他' : '她',
        opening: '你好，等很久了吗？', goal: '让她放松地说话' },
  log: [
    { userText: '你担心的是哪一块？我想先听这个。', reply: '我怕做出来不是你要的。', tone: '温和',
      inner: '他终于问我了。', signal: '先问后答', rating: '好', rating_why: '先接住对方的顾虑再往下走',
      temp: 56 },
    { userText: '那我先把两个方案都发你，你挑一个。', reply: '嗯，我先看看。', tone: '平淡',
      inner: '又是给我活儿。', signal: '把决定推回去', rating: '失误', rating_why: '对方要的是被听见',
      temp: 48 },
  ],
  debrief: deb,
});

const DEB = {
  verdict: '这一局你有两次真的接住了她，但最后又把决定推回给她了。整体比上一局稳。',
  pattern: '一到要给方案的时候，你就退回到"你选一个"。',
  keeps: ['先问再答', '语气没有对抗'],
  fixes: [{ act: '先接住再给方案', say: '我先说我的想法，你觉得不对随时打断我。',
            why: '把方案和决定分开：你给方案，决定还是她的。' }],
  one: '每次给方案之前，先说一句你听懂了她什么。',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await p.addInitScript(() => {
    localStorage.setItem('eq-state-v2', JSON.stringify({ talks: [] }));
    window.__log = [];
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, asr: false, asrAct: false, http: true,
        mic: true, music: false, local: true, localReady: false }),
      asrLocalState: () => JSON.stringify({ abi: true, asset: true, ready: false, unpacking: false,
        lib: '', size: 0, error: '' }),
      asrLocalPrepare: () => { window.__log.push(['prepare']); },
      asrProbe: () => JSON.stringify(window.__probe || { service: false, activity: false, engines: [], sdk: 33 }),
      speak: () => {}, stopSpeak: () => {}, listenLocal: () => {}, stopListeningLocal: () => {},
      openVoiceSettings: () => {},
    };
  });
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  /* 等 boot() 真的落完再动 #view。
     为什么必须等：boot() 是异步的，它渲染「今天」页可能在几百毫秒之后——
     我第一版等了 400ms 就开始截图，于是拍到的全是被 boot 覆盖回去的今天页，
     而且**脚本一声不吭地成功退出**（截图里内容不对，只有看图才发现）。
     所以这里等一个明确的标志位，而不是等一个拍脑袋的毫秒数。 */
  await p.waitForFunction(() => {
    const v = document.querySelector('#view');
    return v && v.innerHTML.length > 500 && typeof currentTab !== 'undefined' && currentTab === 'today';
  }, { timeout: 15000 });
  await p.waitForTimeout(300);
  await p.evaluate(() => saveSettings({ apiKey: 'sk-test', autoSpeak: false, audioAsk: false }));

  /* 截图之前必须把浮层清掉。
   * 这里踩过一次很值得记的坑：四张图拍出来全是「每日计划」的闸门浮层
   * （「今天的量很小 / 现在做（5 步）」），而我以为拍的是对话页——
   * **断言查的是 #view 的 DOM（对的），截图拍的是屏幕（被浮层盖住的）**，
   * 两者都"没报错"，所以脚本一路绿灯、图全错。
   * 项目里其它截图脚本都有这一行，我这次漏了；
   * 浮层是 .gate（闸门）和 .sheet（设置/面板），两个都要清。 */
  const clearOverlays = () => p.evaluate(() =>
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove()));
  await clearOverlays();

  // 1 选场景页：小图标 + 本地识别准备中的说明
  await p.evaluate(() => { V.sess = null; setAiSubview('voice'); });
  // 每一步都要求"屏幕上真的是那一页"再拍。不这么写的话，拍错了也照样成功退出——
  // 第一版就是这样：四张图全是「今天」页，脚本一声不吭地跑完了。
  await p.waitForFunction(() => /自己出一个题/.test(document.querySelector('#view').textContent));
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'talk_setup_local.png'), fullPage: false });
  await p.evaluate(() => { document.getElementById('localPrepNote').scrollIntoView({ block: 'center' }); });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'talk_local_note.png'), fullPage: false });

  // 2 历史列表
  // 注意：REC() 是 Node 这边的函数，page.evaluate 里取不到（第一版就报
  // "REC is not defined"）。先在 Node 里把数据造好，再整个传进去。
  const talks = [
    REC('a1', Date.now() - 3600e3, '刚认识两周，第一次单独出来', false, 6, 62, 4, 1, DEB),
    REC('b2', Date.now() - 26 * 3600e3, '同事在群里否了你的方案', true, 9, 44, 3, 4, null),
  ];
  await p.evaluate((list) => {
    state.talks = list;
    save();
    openTalkHistory();
  }, talks);
  await p.waitForFunction(() => !!document.querySelector('.his-list'));
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'talk_history.png') });

  // 3 删除确认（两步）
  await p.evaluate(() => askDeleteTalk('a1'));
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'talk_history_del.png') });

  // 4 详情页
  await p.evaluate(() => renderTalkRecord('a1'));
  await p.waitForFunction(() => !!document.querySelector('.deb-verdict'));
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'talk_record.png') });
  await p.evaluate(() => window.scrollTo({ top: 900 }));
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'talk_record_rounds.png') });

  // 5 结束页底部（新加的小图标那一行）
  await p.evaluate(async (args) => {
    window.llmCall = async (m) => (/复盘|分析/.test(m[0].content) ? args.deb : {
      reply: '好，你说。', tone: '温和', inner: '他好像真的想听。', signal: '给了开口',
      rating: '好', rating_why: '把话头递回来', temp: 55,
    });
    V.native = null; V.ended = false;
    await startSession({
      id: 's1', title: '刚认识两周，第一次单独出来', stage: '认识试探', difficulty: 2, ta: '她',
      her: '26 岁，做设计的', her_state: '她怕尴尬', opening: '你好，等很久了吗？',
      goal: '让她放松地说话', trap: '一直找话题表现自己',
    });
    await userSaid('你担心的是哪一块？');
    endSession();
  }, { deb: DEB });
  await p.waitForTimeout(900);
  const endOk = await p.evaluate(() => /逐轮记录/.test(document.querySelector('#view').textContent));
  if (!endOk) throw new Error('结束页没渲染出来（截图会拍到错的东西）');
  await p.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'talk_end_bottom.png') });

  // 6 诊断页：四层如实报
  await p.evaluate(() => {
    V.native = window.EQNative; V.caps = JSON.parse(window.EQNative.capabilities());
    window.__probe = { service: false, activity: false, engines: [], sdk: 33 };
    probeNative();
    openSettings('sound');
    asrDiagnose();
    const el = document.getElementById('asrDiag');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'talk_asr_diag.png') });

  // 有没有溢出：横向滚动条出现就说明有东西撑破了布局
  const overflow = await p.evaluate(() => ({
    sx: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  console.log('横向溢出检查：', JSON.stringify(overflow),
    overflow.sx > overflow.cw + 1 ? '有溢出！' : '没有溢出');
  await b.close();
  console.log('图在 output/ ：talk_setup_local / talk_local_note / talk_history / '
    + 'talk_history_del / talk_record / talk_record_rounds / talk_end_bottom / talk_asr_diag');
})();
