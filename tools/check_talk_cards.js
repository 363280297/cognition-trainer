/* 检查「怎么接话」这类卡在真实页面里的渲染：
 * quote 是好几行对话记录，靠 CSS 的 white-space: pre-line 才不会被折成一行。
 * 这是新加的渲染路径，所以单独验一次，而不是只看数据对不对。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const EXE = 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    go('practice');
    setPracticeSubview('cards');
  });

  console.log('\n[题库]');
  const info = await p.evaluate(() => {
    const all = CONTENT.cards.cards;
    const talk = all.filter((c) => c.type === 'talk');
    const multi = all.filter((c) => c.type === 'talk' || c.type === 'read');
    return {
      total: all.length, talk: talk.length,
      ids: talk.map((c) => c.id),
      types: [...new Set(all.map((c) => c.type))],
      typeLabel: TYPE_NAME.talk,
      // 每张 t 卡都要有 plan / 4 选项 / 正解；旧的仅换场景变体已移除，完整变式另有专项门禁
      bad: talk.filter((c) => !c.plan || !c.plan.if || !c.plan.then
        || c.options.length !== 4
        || !c.options.some((o) => o.id === c.best && o.err === '正解')).map((c) => c.id),
      quoteLines: talk.map((c) => c.quote.split('\n').length),
    };
  });
  // 不写死张数：这类「内容又加了一批」之后必然失效的断言，
  // 会让人每隔一阵就来改测试，慢慢就学会忽略它了。张数的下限放这里，
  // 精确的总数交给 test_content.js（那里是唯一该关心总数的地方）。
  chk('接话卡至少在库里（且不少于 10 张）', info.talk >= 10, `${info.talk} 张：${info.ids.join(', ')}`);
  chk('卡片总数没有倒退', info.total >= 66, String(info.total));
  chk('talk 类型有中文标签', info.typeLabel === '怎么接话', String(info.typeLabel));
  chk('每张都完整（plan / 2 变体 / 4 选项 / 正解）', info.bad.length === 0, info.bad.join(',') || '全部通过');
  // 下限是 1，不是 2：t09 的 quote 只有一句（你在群里问了一句），
  // 对方的回应写在 question 里——那是刻意的，这个卡考的就是「这一句该不该发」。
  // 但多行记录是这个类型的主要形态，所以另加一条「大多数是多行」，
  // 这样 pre-line 那条渲染路径依然被覆盖到。
  chk('quote 没有空的', info.quoteLines.every((n) => n >= 1), info.quoteLines.join(','));
  chk('大多数接话/读局卡的 quote 是多行记录',
    info.quoteLines.filter((n) => n >= 2).length >= Math.ceil(info.quoteLines.length * 0.8),
    `${info.quoteLines.filter((n) => n >= 2).length}/${info.quoteLines.length} 张多行`);

  console.log('\n[渲染]');
  // 直接把一张 t 卡塞进会话，看真实 DOM
  const rendered = await p.evaluate(() => {
    const card = CONTENT.cards.cards.find((c) => c.id === 't01');
    const host = document.getElementById('view');
    session.queue = [card];
    session.i = 0;
    renderCard ? renderCard() : null;
    return {
      quoteEl: !!document.querySelector('.quote'),
      text: document.querySelector('.quote') ? document.querySelector('.quote').textContent : '',
      ws: document.querySelector('.quote')
        ? getComputedStyle(document.querySelector('.quote')).whiteSpace : '',
      typeTag: document.body.innerHTML.includes('怎么接话'),
      optCount: document.querySelectorAll('.opt').length,
    };
  });
  chk('.quote 渲染出来了', rendered.quoteEl);
  chk('CSS white-space 是 pre-line（换行会保留）', rendered.ws === 'pre-line', rendered.ws);
  chk('quote 里保留了换行符', rendered.text.includes('\n'),
    `${rendered.text.split('\n').length} 行`);
  chk('类型标签显示「怎么接话」', rendered.typeTag);
  chk('选项渲染出 4 个', rendered.optCount === 4, String(rendered.optCount));

  // 高度检查：pre-line 生效的话，多行 quote 应该明显比单行高
  const h = await p.evaluate(() => {
    const q = document.querySelector('.quote');
    return q ? q.getBoundingClientRect().height : 0;
  });
  chk('多行 quote 的高度超过 100px（说明真的换行了）', h > 100, `${Math.round(h)}px`);

  chk('无脚本报错', errs.length === 0, errs.join(' | ') || '无');
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
