/* 微课界面的检查：列表 → 筛选 → 打开 → 应用题 → 记录。
 *
 * 为什么补这一项：**微课这一块在这之前没有任何界面级的检查。**库里 37 课、
 * 每课带一道应用题，`test_content.js` 验的是数据本身（字段齐、选项四个、
 * answer 不越界），但「这些数据真的接到了界面上、点下去真的会有反馈、
 * 答完真的会被记住」这三件事，一直没有人守。
 *
 * 这一轮（2.44）往里加了「内容判读」四课，正是这一块最容易被写坏的地方：
 * 新课用的字段（read / warn / apply）和旧课完全一样，所以数据测得过，
 * 但一个系列名写错、或者选项渲染漏了一个，只有界面能看出来。
 *
 * 守的性质，按重要性排：
 *   1. **`**` 不许原样露出。** 正文里的加粗标记靠 rich() 变成 <b>；一旦某处
 *      忘了走 rich()，用户会看到字面的星号。项目里为这一类加过断言，这里也守一条。
 *   2. **答错也要有反馈。** 错了就把正确答案点亮、并且讲清为什么——不能只是"错了"。
 *   3. **记录要真的落盘并且回来还在。** 答对之后重新打开列表，那一课要显示
 *      「已读 · 应用题答对」；靠的是 state.lessons + save()，不是内存里的临时变量。
 *   4. **新系列真的接上了界面。** 系列筛选条是自动从数据里收集的，
 *      所以「筛选条里有内容判读」这一条同时证明了数据接上了、说明文案也接上了。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'curriculum.json'), 'utf8'));

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()));

  console.log('\n[一、系列筛选条]');
  const list = await p.evaluate(() => {
    setPracticeSubview('learn');
    return {
      chips: [...document.querySelectorAll('.chips .chip-btn')].map((c) => c.textContent.trim()),
      n: document.querySelectorAll('.lesson-item').length,
    };
  });
  const series = [...new Set(DATA.lessons.map((l) => l.series))];
  chk('筛选条里每个系列都在（含这一轮新加的「内容判读」）',
    series.every((s) => list.chips.includes(s)), list.chips.join(' / '));
  chk('默认「全部」下把 37 课都列出来', list.n === DATA.lessons.length,
    `${list.n} 条 vs 数据 ${DATA.lessons.length} 课`);

  console.log('\n[二、内容判读：切过去看]');
  const j = DATA.lessons.filter((l) => l.series === '内容判读');
  const jv = await p.evaluate((s) => {
    setSeries(s);
    return {
      note: (document.querySelector('.series-note') || {}).textContent || '',
      rows: [...document.querySelectorAll('.lesson-item')].map((e) => ({
        t: e.textContent.replace(/\s+/g, ' ').trim(),
        id: (e.getAttribute('onclick') || '').replace(/[^j0-9]/g, ''),
      })),
    };
  }, '内容判读');
  const jTitles = jv.rows.map((r) => r.t);
  chk('切到该系列之后只剩这 4 课', jv.rows.length === j.length, `${jv.rows.length} 条`);
  chk('四课的标题都在列表里', j.every((l) => jTitles.some((t) => t.includes(l.title))),
    j.map((l) => l.id).join(','));
  chk('列表里能看到「未读」（还没点过）', jTitles.every((t) => /未读/.test(t)));
  /* 系列说明是这一轮新加的：没有它，用户点进这个系列不知道它是干什么的 */
  chk('这个系列有说明，而且说的是它的用途（筛内容，不是又一批内容）',
    jv.note.length > 20 && /筛|判据|值得信/.test(jv.note), jv.note.slice(0, 40));

  console.log('\n[三、每一课都打得开、渲染都对]');
  // 四课逐课走一遍真实入口：列表点进去 → 看正文/边界/选项
  for (const l of j) {
    const r = await p.evaluate((id) => {
      document.querySelectorAll('.sheet').forEach((s) => s.remove());
      openLesson(id);
      const sheet = document.querySelector('.sheet');
      const opts = [...document.querySelectorAll('#la .opt')];
      return {
        read: (sheet.querySelector('.reading') || {}).textContent || '',
        readHtml: (sheet.querySelector('.reading') || {}).innerHTML || '',
        warn: (sheet.querySelector('.warnbox') || {}).textContent || '',
        warnHtml: (sheet.querySelector('.warnbox') || {}).innerHTML || '',
        tag: [...sheet.querySelectorAll('.tag')].map((t) => t.textContent.trim()),
        n: opts.length,
        labels: opts.map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
        q: (sheet.querySelector('h3 + p, p') || {}).textContent || '',
      };
    }, l.id);
    chk(`${l.id}：正文渲染出来了（${r.read.length} 字）`, r.read.length > 400, r.read.length + ' 字');
    chk(`${l.id}：加粗真的变成了 <b>，页面里不出现字面的 **`,
      !r.read.includes('**') && !r.warn.includes('**') && /<b>/.test(r.readHtml + r.warnHtml),
      r.read.includes('**') || r.warn.includes('**') ? '有裸露的 **' : 'ok');
    chk(`${l.id}：适用边界那一块在，而且有内容`, /适用边界/.test(r.warn) && r.warn.length > 200,
      r.warn.length + ' 字');
    chk(`${l.id}：标了系列和证据强度`, r.tag.includes('内容判读') && r.tag.length === 2, r.tag.join('/'));
    chk(`${l.id}：四道选项都在，题面也在`,
      r.n === 4 && r.labels.every((x) => x.length > 4) && r.labels[0].startsWith('A'),
      `${r.n} 个选项`);
  }

  console.log('\n[四、应用题：答错和答对都得讲清楚]');
  const j02 = j.find((l) => l.id === 'j02');
  const right = j02.apply.answer;
  const wrong = (right + 1) % 4;
  const w = await p.evaluate(({ id, w, right }) => {
    document.querySelectorAll('.sheet').forEach((s) => s.remove());
    openLesson(id);
    answerLesson(id, w);
    const cls = (i) => (document.querySelector(`#la .opt[data-i="${i}"]`) || {}).className || '';
    return {
      fb: (document.querySelector('#lfb') || {}).textContent || '',
      chosenCls: cls(w),
      correctCls: cls(right),
      disabled: [...document.querySelectorAll('#la .opt')].every((o) => o.disabled),
      rec: JSON.stringify(state.lessons[id]),
    };
  }, { id: 'j02', w: wrong, right });
  chk('答错时反馈说清了这是什么错法，不是只说「错了」',
    /错法/.test(w.fb) && w.fb.length > 200, w.fb.slice(0, 40));
  chk('答错时正确答案被点亮、我选的那个被标错',
    /right/.test(w.correctCls) && /wrong/.test(w.chosenCls),
    `对=…${w.correctCls.slice(-6)} 我=…${w.chosenCls.slice(-6)}`);
  chk('答完四个选项都锁住（不能反复点出正确答案）', w.disabled);
  chk('答错了也被记成「答错」，不是没记', /"applyCorrect":false/.test(w.rec), w.rec);

  const r2 = await p.evaluate(({ id, right }) => {
    document.querySelectorAll('.sheet').forEach((s) => s.remove());
    openLesson(id);
    answerLesson(id, right);
    return {
      fb: (document.querySelector('#lfb') || {}).textContent || '',
      rec: JSON.stringify(state.lessons[id]),
    };
  }, { id: 'j02', right });
  chk('答对时反馈是「正确」并且给出为什么', /正确/.test(r2.fb) && /为什么/.test(r2.fb));
  chk('答对记成 applyCorrect:true', /"applyCorrect":true/.test(r2.rec), r2.rec);

  console.log('\n[五、记录回来还在（真的重开一次页面）]');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  const back = await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    setPracticeSubview('learn');
    setSeries('内容判读');
    return {
      rows: [...document.querySelectorAll('.lesson-item')].map((e) => ({
        t: e.textContent.replace(/\s+/g, ' ').trim(),
        id: (e.getAttribute('onclick') || '').replace(/[^j0-9]/g, ''),
      })),
      saved: JSON.stringify(state.lessons),
    };
  });
  const row02 = back.rows.find((r) => r.id === 'j02') || { t: '' };
  chk('重开之后 j02 那一条写的是「已读 · 应用题答对」',
    /已读/.test(row02.t) && /应用题答对/.test(row02.t), row02.t.slice(0, 46));
  /* 打开过就算已读（上面四课都点过一次），但**答过题的只有 j02**。
   * 这一条守的是「记录不会串台」：applyCorrect 不该泄漏到没答过的那三课上。 */
  chk('四课都记成已读，但只有答过的那一课带应用题结果',
    back.rows.every((r) => /已读/.test(r.t)) &&
      back.rows.filter((r) => /应用题/.test(r.t)).length === 1,
    back.rows.map((r) => r.id + (/应用题/.test(r.t) ? '(答)' : '')).join(' '));
  chk('答题记录真的落盘了（state.lessons 里有 j02）',
    /"j02":\{"read":true,"applyCorrect":true\}/.test(back.saved), back.saved.slice(0, 90));

  chk('整个流程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.close();
  await b.close();
  console.log(fail ? `\n${fail} 项失败` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
