/* 2.34 第一步（设计地基）验收拍图：今天 / 卡片 / AI 对话 / 设置 / 历史。

   为什么不是"只拍图"：这一轮把正文从 13.4px 提到 15px，一共 148 处字号里 91 处变大了。
   字号变大的后果**不是**看起来丑，而是某一行文字把自己挤出容器：
   横向溢出被裁掉、或者纵向把按钮顶出屏幕。这种事人眼盯五张图很容易漏，
   所以每拍一页先跑一遍"溢出扫描"——凡是 scrollWidth > clientWidth 的元素都点名，
   人眼再核对"这是不是真的坏了"。

   溢出扫描故意排除几类真·正常情况，否则会淹没在噪声里（第一版就报了几十条）：
     - 横向滚动的容器（.sheet-nav、.chips、pre）本来就该溢出；
     - text-overflow: ellipsis 的元素溢出是设计（一行截断 + 省略号）；
     - 隐藏元素（offsetParent === null）不参加。 */
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

const REC = (id, at, title, gen, done) => ({
  id, at, gen, done, turn: 2, temp: 52, asked: 2, followUps: 1, goods: 3, bads: 1,
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

/* 溢出扫描：只报"真的可能被裁掉"的。 */
const OVERFLOW_PROBE = () => {
  const skipSel = '.sheet-nav, .chips, .subnav, pre, .scene-list, .seed-list, .his-list';
  const out = [];
  document.querySelectorAll('#view *, .top *, .tabs *').forEach((el) => {
    if (el.offsetParent === null) return;                    // 隐藏的不算
    if (el.closest(skipSel)) return;                          // 本来就该横向滚
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') return;               // 截断是设计
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;
    const dw = el.scrollWidth - el.clientWidth;
    if (dw > 2 && el.clientWidth > 0) {
      out.push({ t: (el.className || el.tagName) + '', d: dw,
                 s: (el.textContent || '').trim().slice(0, 34) });
    }
  });
  // 视口外溢：整页有没有横向滚动
  const pageDx = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  return { items: out.slice(0, 12), pageDx };
};

async function clean(p) {
  await p.evaluate(() => document.querySelectorAll('.gate').forEach((s) => s.remove()));
}
async function shot(p, name) {
  await clean(p);
  await p.waitForTimeout(250);
  const ov = await p.evaluate(OVERFLOW_PROBE);
  await p.screenshot({ path: path.join(OUT, name + '.png') });
  const tag = ov.items.length || ov.pageDx > 2
    ? `  ⚠ 溢出 ${ov.pageDx > 2 ? `页宽+${ov.pageDx} ` : ''}${ov.items.map((i) => `${i.t}+${i.d}`).join(' ')}`
    : '  ok';
  console.log(`  ${name}.png${tag}`);
  return ov;
}

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  await p.goto(OFFLINE);
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

  const bad = [];
  const note = (page, ov) => {
    if (ov.items.length || ov.pageDx > 2) bad.push({ page, ...ov });
  };
  console.log('拍图（412×915，跟常见手机一致）：');

  /* tab 只有四个：today / practice / ai / growth。
     「卡片」是「练习」这一路的默认子页，**不是**一个 tab——第一版写成 go('cards')，
     直接抛 VIEWS[tab] is not a function。子页要用 setXxxSubview 切。 */
  const pages = [
    ['step1-01-今天',    () => go('today')],
    ['step1-02-卡片',    () => { go('practice'); setPracticeSubview('cards'); }],
    ['step1-03-AI对话',  () => { go('ai'); setAiSubview('voice'); }],
    ['step1-04-成长',    () => go('growth')],
  ];
  for (const [name, fn] of pages) {
    await p.evaluate(fn);
    await p.waitForTimeout(450);
    note(name, await shot(p, name));
  }
  // 答题之后那一屏：选项 + 解释 + 逐条解析，是字号最密的地方
  await p.evaluate(() => {
    const o = document.querySelector('#opts .opt');
    if (o) o.click();
  });
  await p.waitForTimeout(700);
  note('卡片-答题后', await shot(p, 'step1-09-卡片-答题后'));

  // 设置：浮层，从今天页的齿轮进去
  await p.evaluate(() => { go('today'); openSettings('today'); });
  await p.waitForTimeout(450);
  note('设置', await shot(p, 'step1-05-设置'));

  // 历史列表
  await p.evaluate(() => { document.querySelectorAll('.sheet').forEach((s) => s.remove()); });
  await p.evaluate(() => { go('ai'); openTalkHistory(); });
  await p.waitForTimeout(450);
  note('历史', await shot(p, 'step1-06-历史列表'));

  await p.evaluate(() => renderTalkRecord('t-live-2'));
  await p.waitForTimeout(350);
  note('历史详情', await shot(p, 'step1-07-历史详情'));

  // 底部 tab 栏在这一轮碰过（z-index token）——单独拍一张确认没被浮标盖住
  await p.evaluate(() => { document.querySelectorAll('.sheet').forEach((s) => s.remove()); go('today'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(350);
  await shot(p, 'step1-08-今天页底部-浮标与tab');

  console.log('\n溢出汇总：');
  if (!bad.length) console.log('  没有发现被裁掉的文字');
  bad.forEach((x) => console.log(`  ${x.page}: 页宽+${x.pageDx}` +
    (x.items.length ? ' ' + x.items.map((i) => `${i.t}(+${i.d})「${i.s}」`).join(' | ') : '')));
  console.log(errs.length ? '页面报错：' + errs.slice(0, 3).join(' | ') : '页面报错：无');
  await b.close();
})();
