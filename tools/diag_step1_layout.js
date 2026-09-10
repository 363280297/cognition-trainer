/* 第一步（字号 13.4 → 15px）到底把哪些地方挤动了？——逐块对比，不靠眼睛。

   做法：对五个关键页各扫一遍 DOM，把"直接含文字的块"记成
   { 类名 + 文字前 12 字 → 行数 / 宽 / 是否被裁 }，然后拿旧 CSS 那份
   （.tmpcmp/prev-step1.html）跑同一段扫描，按 key 求差。

   为什么值得写这个：截图上看「设置」竖排成两行、tab 栏副标题折行，
   我先怀疑是这一步挤出来的；量完才知道 tab 副标题**原来就是两行**
   （旧 [1,2,1,1] → 新 [1,2,1,1]），只有 tab 条高了 7px。
   这就是"断言和事实冲突时先假设断言错了"的用法：怀疑回归之前先量一遍，
   不然会去修一个本来就没坏的东西，还会把真问题漏过去。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const CUR = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const OLD = pathToFileURL(path.join(__dirname, '..', '.tmpcmp', 'prev-step1.html')).href;

/* 扫描：只收"自己直接装着文字"的元素，父容器不重复记（否则一条改动报一串）。 */
const SWEEP = () => {
  const out = {};
  const seen = new Set();
  document.querySelectorAll('#view *, .top *, .tabs *, .sheet *, .gate *').forEach((el) => {
    if (el.offsetParent === null && !el.closest('.tabs')) return;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(' ').trim();
    if (!own) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    let key = (typeof el.className === 'string' ? el.className : el.tagName)
      .replace(/\s*(on|active)\s*/g, ' ').trim() + '|' + own.slice(0, 14);
    while (seen.has(key)) key += "'";
    seen.add(key);
    out[key] = {
      // 行数取整：字号变了 line-height 跟着变，height/lh 会出现 1.3→1.6 这种
      // 小数抖动——那不是重排，是除法的误差。只有整数行数变了才是真的多占一行。
      lines: Math.max(1, Math.round(r.height / lh)),
      h: Math.round(r.height),
      w: Math.round(r.width),
      dx: Math.round(el.scrollWidth - el.clientWidth),
      clipY: Math.round(el.scrollHeight - el.clientHeight),
      fs: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      t: own.slice(0, 22),
    };
  });
  return out;
};

const REC = (id, at, title, gen, done) => ({
  id, at, gen, done, turn: 2, temp: 52, asked: 2, followUps: 1, goods: 3, bads: 1,
  sc: { id: gen ? 'gen-1' : 's1', title, ta: '她', opening: '你好，等很久了吗？', goal: '让她放松地说话' },
  log: [{ userText: '你担心的是哪一块？我想先听这个。', reply: '我怕做出来不是你要的。', tone: '温和',
          inner: '他终于问我了。', signal: '先问后答', rating: '好', rating_why: '先接住对方的顾虑再往下走', temp: 56 }],
  debrief: { verdict: '这一局你有两次真的接住了她。', pattern: '一到要给方案你就退回去。',
             keeps: ['先问再答'], fixes: [{ act: '先接住再给方案', say: '我先说我的想法。', why: '把方案和决定分开。' }],
             one: '每次给方案之前，先说一句你听懂了她什么。' },
});

async function run(b, url) {
  const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  await p.goto(url);
  await p.evaluate((recs) => {
    const st = JSON.parse(localStorage.getItem('eq-state-v2') || '{}');
    st.daily = st.daily || {};
    st.daily.date = new Date().toISOString().slice(0, 10);
    st.talks = recs;
    localStorage.setItem('eq-state-v2', JSON.stringify(st));
  }, [REC('t-done-1', Date.now() - 3600e3, '上级临下班派活', false, true),
      REC('t-live-2', Date.now() - 600e3, '她说你最近是不是不太想理我', true, false)]);
  await p.goto(url);
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
  await p.waitForTimeout(400);
  const all = {};
  const grab = async (tag) => {
    await p.waitForTimeout(400);
    const r = await p.evaluate(SWEEP);
    for (const k of Object.keys(r)) all[tag + ' :: ' + k] = r[k];
  };
  await p.evaluate(() => document.querySelectorAll('.gate').forEach((s) => s.remove()));
  await p.evaluate(() => go('today'));                       await grab('今天');
  await p.evaluate(() => { go('practice'); setPracticeSubview('cards'); }); await grab('卡片');
  await p.evaluate(() => { go('ai'); setAiSubview('voice'); });             await grab('AI对话');
  await p.evaluate(() => go('growth'));                      await grab('成长');
  await p.evaluate(() => openSettings('sound'));              await grab('设置');
  await p.evaluate(() => { document.querySelectorAll('.sheet').forEach((s) => s.remove()); });
  await p.evaluate(() => { go('ai'); openTalkHistory(); });   await grab('历史');
  await p.close();
  return { all, errs };
}

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--mute-audio'] });
  const a = (await run(b, OLD)).all;
  const c = (await run(b, CUR)).all;
  await b.close();
  const keys = [...new Set([...Object.keys(a), ...Object.keys(c)])];
  const diffs = [];
  for (const k of keys) {
    const o = a[k], n = c[k];
    if (!o || !n) { diffs.push({ k, why: o ? '新版没有这块' : '旧版没有这块', o, n }); continue; }
    const why = [];
    if (o.lines !== n.lines) why.push(`行数 ${o.lines}→${n.lines}`);
    if (o.dx <= 2 && n.dx > 2) why.push(`新出现横向溢出 +${n.dx}px`);
    if (o.clipY <= 2 && n.clipY > 2) why.push(`新出现纵向裁切 +${n.clipY}px`);
    if (why.length) diffs.push({ k, why: why.join('，'), o, n });
  }
  console.log(`扫描 ${keys.length} 块文字；真正被挤动的（多占一行 / 溢出 / 裁切）${diffs.length} 块。\n`);
  diffs.forEach((d) => {
    console.log(`· ${d.k}`);
    console.log(`    ${d.why}`);
    console.log(`    旧 宽${d.o ? d.o.w : '-'} 高${d.o ? d.o.h : '-'} 行${d.o ? d.o.lines : '-'} 「${d.o ? d.o.t : ''}」`);
    console.log(`    新 宽${d.n ? d.n.w : '-'} 高${d.n ? d.n.h : '-'} 行${d.n ? d.n.lines : '-'} 「${d.n ? d.n.t : ''}」`);
  });
})();
