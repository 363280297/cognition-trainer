/* 拍「场景库」这一版的样子，放 output/。要看的是四件事：
   1) 筛选条（全部/恋爱/职场/…带数量）会不会挤；
   2) 默认那几张（练得最少的、每个关系一张）读不读得出来是"练得少"；
   3) 展开之后按关系分组的小标题，像不像标题（不能像按钮）；
   4) AI 造的卡上那个「AI 造」记号会不会太重。
   拍之前先把 .gate 拆掉（日更那一关会盖住整屏），但**不能拆 .sheet**。 */
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

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // 造一批假的进库（形状跟真实落盘的一致），再让两个"练过几次"
  await p.evaluate(() => {
    document.querySelectorAll('.gate').forEach((s) => s.remove());
    const SC = (t, st, d, th, op) => ({ id: 'gen-' + Math.random().toString(36).slice(2, 9),
      title: t, stage: st, difficulty: d, ta: '她', theme: th, her: '30 岁，做市场的，说话快', 
      her_state: '她其实在意的是有没有被当回事', opening: op || '这事儿你怎么看？',
      goal: '把话说清楚', trap: '一直绕', createdAt: Date.now() });
    state.genScenes = [
      SC('被夸方案做得好', '职场平级', 1, '被夸怎么接', '可以啊你，今天讲得真稳。'),
      SC('妈妈翻到你药盒', '家人日常', 2, '瞒病被拆穿', '这药……你什么时候开始吃的？'),
      SC('朋友试新发型', '朋友之间', 2, '真话怎么给', '怎么样？是不是有点短了？'),
      SC('刚认识就约下次', '认识试探', 3, '要联系方式', '今天聊得挺开心的，我先走啦。'),
      SC('隔壁工位来打听', '泛社交', 1, '接住打听', '你们组最近挺忙的吧？'),
      SC('上级追问进度', '职场上下', 3, '进度落后怎么说', '这个节点，是不是跟上周报的不太一样？'),
      SC('暧昧对象突然冷淡', '降温期', 3, '问清楚不纠缠', '你最近是不是挺忙的？'),
    ];
    const ids = state.genScenes.map((x) => x.id);
    state.scenes = state.scenes || {};
    state.scenes[ids[0]] = 3; state.scenes[ids[1]] = 1;
    save();
    go('ai'); setAiSubview('voice');
  });
  await p.waitForTimeout(400);

  const shot = async (name, scrollSel) => {
    if (scrollSel) {
      await p.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: 'start' }); }, scrollSel);
      await p.waitForTimeout(250);
    }
    await p.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ' + name + '.png');
  };

  console.log('拍图：');
  await shot('lib-01-场景库-默认', '.seed-list');
  // 筛选条本身：把「场景库」这张卡滚到顶，否则它总是在屏幕上面
  await p.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#view .card')).find((x) => /场景库/.test(x.textContent));
    if (c) c.scrollIntoView({ block: 'start' });
  });
  await p.waitForTimeout(250);
  await shot('lib-05-筛选条与说明');
  await p.evaluate(() => setSceneFilter('职场'));
  await shot('lib-02-筛职场');
  await p.evaluate(() => { setSceneFilter('全部'); scenesExpanded = true; renderTalkSetup(); });
  await shot('lib-03-看全部-按关系分组', '.seed-list');
  await p.evaluate(() => { scenesExpanded = false; renderTalkSetup(); });
  await shot('lib-04-最上面那张卡', '.card');

  // 「上次没聊完」那张卡（离开 App 再回来时最该先看见的）
  await p.evaluate(() => {
    state.talks = [{
      id: 't-demo', at: Date.now() - 3600e3, updatedAt: Date.now() - 600e3,
      done: false, gen: false, turn: 3, temp: 58, asked: 1, followUps: 0, goods: 2, bads: 1,
      sc: { id: 's1', title: '刚认识两周，第一次单独出来', ta: '她',
            opening: '你说的地方还挺好找的，我绕了一圈才到。' },
      log: [
        { userText: '你路上绕了？不好意思，我应该去接你。', reply: '没事，我也没迟到。', temp: 56 },
        { userText: '你平时是不是不太喜欢等人？', reply: '……看等谁吧。', temp: 58 },
        { userText: '那下次我提前十分钟到。', reply: '行啊。', temp: 58 },
      ],
      debrief: null,
    }];
    save();
    go('ai'); setAiSubview('voice');
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => window.scrollTo({ top: 0 }));
  await shot('lib-06-上次没聊完');
  console.log(errs.length ? '页面报错：' + errs.slice(0, 3).join(' | ') : '页面报错：无');
  await b.close();
})();
