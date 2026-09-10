/* 2.31 这一轮改的四处界面，拍图放 output/，用来人眼过一遍：
   1) AI 那一路的切换条——右边那个「📋 历史」跟三个子页按钮挤不挤、看不看得出是动作；
   2) 选场景页默认摊开 6 个 + 「看全部 14 个」那个按钮的排版；
   3) 设置页顶上 6 个分区的胶囊导航（横向滚动 + 右侧渐隐）像不像导航；
   4) 对话历史列表 + 详情。
   拍照前一律先把 .sheet/.gate 拆掉：日更那一关的浮层会盖住整屏，拍出来全是一样的图。 */
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

/* goods/bads 是**次数**（数字），跟 talkRecordFromSess 一致。
   第一版这里塞的是 ['先问再答'] 这种数组，于是「接住了」那一格印出一整句话、
   把三格的标签挤得高低不齐——看着像个排版 bug，其实是样本编错了。
   拍图用的样板要跟真实落盘的形状一致，否则审出来的是假问题。 */
const REC = (id, at, title, gen, done) => ({
  id, at, gen, done, turn: 2, temp: 52, asked: 2, followUps: 1,
  goods: 3, bads: 1,
  sc: { id: gen ? 'gen-1' : 's1', title, ta: '她', opening: '你好，等很久了吗？', goal: '让她放松地说话' },
  log: [
    { userText: '你担心的是哪一块？我想先听这个。', reply: '我怕做出来不是你要的。', tone: '温和',
      inner: '他终于问我了。', signal: '先问后答', rating: '好', rating_why: '先接住对方的顾虑再往下走', temp: 56 },
    { userText: '那我先把两个方案都发你，你挑一个。', reply: '嗯，我先看看。', tone: '平淡',
      inner: '又是给我活儿。', signal: '把决定推回去', rating: '失误', rating_why: '对方要的是被听见', temp: 48 },
  ],
  debrief: {
    verdict: '这一局你有两次真的接住了她，但最后又把决定推回给她了。整体比上一局稳。',
    pattern: '一到要给方案的时候，你就退回到"你选一个"。',
    keeps: ['先问再答', '语气没有对抗'],
    fixes: [{ act: '先接住再给方案', say: '我先说我的想法，你觉得不对随时打断我。',
              why: '把方案和决定分开：你给方案，决定还是她的。' }],
    one: '每次给方案之前，先说一句你听懂了她什么。',
  },
});

/* 只拆「日更那一关」的关卡浮层（.gate）。**不能连 .sheet 一起拆**——
   设置页、历史列表、历史详情都是渲染进 .sheet 这个浮层宿主的，
   把它们一起删掉的话，拍出来的就是"点了没反应"的假象（第一版就是这么拍的）。 */
async function clean(p) {
  await p.evaluate(() => document.querySelectorAll('.gate').forEach((s) => s.remove()));
}
/* 要拍的东西在屏幕下面时先滚过去，否则拍到的永远是首屏那两张卡。 */
async function scrollTo(p, sel) {
  await p.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
  }, sel);
  await p.waitForTimeout(250);
}
async function shot(p, name) {
  await clean(p);
  await p.waitForTimeout(250);
  const f = path.join(OUT, name + '.png');
  await p.screenshot({ path: f });
  console.log('  ' + name + '.png');
}

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  await p.goto(OFFLINE);
  /* 日更那一关先跳过去；再塞两条历史（一条聊完的、一条没聊完的），
     否则历史页是空列表，拍出来看不出排版。
     键是 eq-state-v2（app.js 的 LS_KEY），不是 eq-state——写错键的话
     页面照样打开、只是空的，会误判成"历史功能坏了"。 */
  await p.evaluate((recs) => {
    const st = JSON.parse(localStorage.getItem('eq-state-v2') || '{}');
    st.daily = st.daily || {};
    st.daily.date = new Date().toISOString().slice(0, 10);
    st.talks = recs;
    localStorage.setItem('eq-state-v2', JSON.stringify(st));
  }, [REC('t-done-1', Date.now() - 3600e3, '上级临下班派活', false, true),
      REC('t-live-2', Date.now() - 600e3, '她说你最近是不是不太想理我', true, false)]);
  await p.goto(OFFLINE);
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
  await p.waitForTimeout(500);

  console.log('拍图：');
  await p.evaluate(() => go('ai'));
  await p.waitForTimeout(400);
  await shot(p, 'nav-01-ai-默认');
  await p.evaluate(() => document.querySelector('.seed-list').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot(p, 'nav-01b-场景列表-默认6个');

  await p.evaluate(() => toggleAllScenes());
  await p.evaluate(() => document.querySelector('.seed-list').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot(p, 'nav-02-场景列表-看全部14个');

  await p.evaluate(() => openSettings('ai'));
  await p.waitForTimeout(400);
  await shot(p, 'nav-03-设置页导航');

  await p.evaluate(() => openTalkHistory());
  await p.waitForTimeout(400);
  await shot(p, 'nav-04-历史列表');

  await p.evaluate(() => renderTalkRecord('t-live-2'));
  await p.waitForTimeout(300);
  await shot(p, 'nav-05-历史详情-没聊完');

  await p.evaluate(() => go('practice'));
  await p.waitForTimeout(300);
  await shot(p, 'nav-06-练习切换条对照');

  console.log(errs.length ? '页面报错：' + errs.slice(0, 3).join(' | ') : '页面报错：无');
  await b.close();
})();
