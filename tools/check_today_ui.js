/* 「今天」页面的检查。
 *
 * 起因是用户的一句反馈：「每日任务的这个界面，感觉不是很明显，
 * 就是我每天要完成的任务。」
 *
 * 查下来有两个独立的原因，一个是设计问题，一个是真 bug：
 *   1. 那一块原来是个**仪表盘**：三个数字方块写着 0 / 需 4，配一句
 *      「还差 5 步」。要读的人自己做减法才知道还差什么；而且「加练」
 *      跟两个必做项并排摆着、字号一样，看起来也像任务。
 *      现在改成清单：一句人话说明今天要做什么，每项单独一行带勾选状态，
 *      必做和可选分开，按钮点名下一件具体的事。
 *   2. **进度条一直是不可见的。** .tbar 和 .tbar i 只定义在 .vh-temp 下，
 *      今日卡片上那条 .tbar.today-bar 拿到了 8px 高度，却没有底色，
 *      里面的 i 也不是 block，填充宽度恒为 0。也就是说「完成到哪了」
 *      这条最该一眼看到的信息，从来没有显示过。
 *
 * 第 2 条是纯 bug，而且非常容易再犯（把样式收回 .vh-temp 里就复现了），
 * 所以这里有一条断言直接量它的底色和填充宽度，而不是只看 DOM 在不在。
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

const read = (p) => p.evaluate(() => {
  const bar = document.querySelector('.today-bar');
  const fill = bar && bar.querySelector('i');
  return {
    tag: (document.querySelector('.today-card .tag') || {}).textContent || '',
    head: (document.querySelector('.today-h') || {}).textContent || '',
    what: (document.querySelector('.today-what') || {}).textContent || '',
    todos: [...document.querySelectorAll('.todo')].map((t) => ({
      mark: (t.querySelector('.todo-mark') || {}).textContent || '',
      name: (t.querySelector('.todo-name') || {}).textContent || '',
      num: (t.querySelector('.todo-num') || {}).textContent.replace(/\s+/g, ' ').trim(),
      done: t.className.includes('todo-done'),
    })),
    extra: (document.querySelector('.todo-extra') || {}).textContent || '',
    btn: (document.querySelector('.today-card .row button') || {}).textContent || '',
    barBg: bar ? getComputedStyle(bar).backgroundColor : '',
    barH: bar ? Math.round(bar.getBoundingClientRect().height) : -1,
    fillW: fill ? Math.round(fill.getBoundingClientRect().width) : -1,
    barW: bar ? Math.round(bar.getBoundingClientRect().width) : -1,
  };
});

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '认知训练-离线版.html'), 'utf8');
  chk('离线版里内联了 todayWhat / todoRow', html.includes('function todayWhat') && html.includes('function todoRow'));

  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];

  const at = async (mutate) => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    await p.evaluate((src) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      eval('(' + src + ')()');
      go('today');
    }, mutate);
    await p.waitForTimeout(150);
    const r = await read(p);
    await p.close();
    return r;
  };

  console.log('\n[什么都没做]');
  const z = await at('() => {}');
  chk('标题说的是「要做什么」', z.head === '今天要做这几件', z.head);
  chk('一句话点明还差什么（含具体数量）',
    /还差/.test(z.what) && /\d/.test(z.what) && /卡片/.test(z.what) && /微课/.test(z.what), z.what);
  chk('必做项逐条列出来（卡片 + 微课）',
    z.todos.length === 2 && z.todos.some((t) => t.name === '卡片') && z.todos.some((t) => t.name === '微课'),
    z.todos.map((t) => t.name).join(' + '));
  chk('每一项都带 已做/总数', z.todos.every((t) => /\d+ \/ \d+/.test(t.num)), z.todos.map((t) => t.num).join(' | '));
  chk('没做的项不打勾', z.todos.every((t) => !t.done && t.mark === '○'), z.todos.map((t) => t.mark).join(''));
  chk('未达标时不把「加练」混进必做清单', z.extra === '' && !z.todos.some((t) => t.name.includes('加练')));
  chk('按钮点名下一件具体的事，而不是「还差 N 步」',
    /开始做卡片/.test(z.btn) && !/步/.test(z.btn), z.btn);

  console.log('\n[进度条必须真的可见（那个一直是隐形的 bug）]');
  chk('进度条有底色', z.barBg !== 'rgba(0, 0, 0, 0)' && z.barBg !== 'transparent', z.barBg);
  chk('进度条有高度', z.barH >= 6, `${z.barH}px`);
  chk('0% 时填充宽度为 0', z.fillW === 0, `${z.fillW}px`);

  console.log('\n[做了一半]');
  const h = await at('() => { state.daily.cards = 2; }');
  chk('填充宽度随进度增长', h.fillW > 0 && h.fillW < h.barW, `${h.fillW}/${h.barW}px`);
  chk('还差的数量跟着变', /2 张卡片/.test(h.what), h.what);
  chk('卡片那一行计数正确', h.todos.find((t) => t.name === '卡片').num.startsWith('2 / 4'),
    h.todos.find((t) => t.name === '卡片').num);
  chk('做了一半还是不打勾', !h.todos.find((t) => t.name === '卡片').done);
  chk('按钮跟着指向还没做完的那项', /开始做卡片/.test(h.btn), h.btn);

  console.log('\n[只差微课]');
  const l = await at('() => { state.daily.cards = 4; }');
  chk('卡片打勾、微课没打勾',
    l.todos.find((t) => t.name === '卡片').done && !l.todos.find((t) => t.name === '微课').done,
    l.todos.map((t) => t.mark).join(''));
  chk('按钮改指向微课', /微课/.test(l.btn), l.btn);

  console.log('\n[已达标]');
  const m = await at('() => { state.daily.cards = 4; state.daily.lessons = 1; state.daily.met = true; state.daily.extra = 2; }');
  chk('两项都打勾', m.todos.every((t) => t.done && t.mark === '✓'), m.todos.map((t) => t.mark).join(''));
  chk('标题变成「做完了」', m.head === '今天做完了', m.head);
  chk('加练单独一行且写明是可选', /加练/.test(m.extra) && /可选/.test(m.extra), m.extra);
  chk('加练没有被写成必做项', !m.todos.some((t) => t.name.includes('加练')));
  chk('进度条填满', m.fillW === m.barW, `${m.fillW}/${m.barW}px`);
  chk('按钮变成加练', /加练/.test(m.btn), m.btn);

  /* 「换人称」那条安全性文字必须在界面上。
   * 它原来在「今日复盘」那块卡片里，用户后来把复盘删了——文字跟着搬进了微课
   * p33 的「适用边界」（见 data/curriculum.json 的 p33.warn）。
   * 自我抽离（用自己名字写反思）有一条反着伤人的边界：在抑郁风险偏高的人身上
   * 可能让情绪变差。所以那一课必须同时有「反对的一面」「支持的一面」和
   * 「状态很差那几天先别写」。这是少数几种**功能本身可能有害**的情况，
   * 所以不靠自觉——文字被删掉就红。
   * 内容侧的同一条守卫在 test_content.js（p33.warn）。 */
  console.log('\n[换人称那条安全边界（现在在微课 p33）]');
  const rv = await (async () => {
    const pg = await b.newPage({ viewport: { width: 420, height: 900 } });
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(OFFLINE, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(600);
    const r = await pg.evaluate(() => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      openLesson('p33');
      const box = document.querySelector('.sheet.open .warnbox');
      return {
        text: box ? box.textContent : '',
        found: !!box,
        // 整页都没有「今日复盘」这四个字，才算删干净了
        stale: (document.body.textContent || '').indexOf('今日复盘') >= 0,
      };
    });
    await pg.close();
    return r;
  })();
  chk('微课 p33 里写着「状态很差那几天先别写」这条边界',
    rv.found && /先别写/.test(rv.text), rv.found ? rv.text.slice(0, 40) : '整块都没找到');
  chk('这条边界两边证据都在（不是单方面泼冷水）',
    /反对的一面/.test(rv.text) && /支持的一面/.test(rv.text));
  chk('这条边界点了名（Giovanetti 2019 / Kross 与 Ayduk 2009）',
    /Giovanetti/.test(rv.text) && /Kross/.test(rv.text));
  chk('明确写了「漏几天没有代价」', /漏几天没有代价/.test(rv.text));
  chk('边界里没有露出的 **', rv.text.indexOf('**') < 0);
  chk('界面上再也不出现「今日复盘」四个字', !rv.stale);

  /* ------------------------------------------------------------------
     达标必须「判对」——这一节走**真实的 answerCard / bumpDaily**，
     不是复刻一份判定逻辑。

     为什么要专门写这一节：原来的代码是 `rate(...); bumpDaily('card')`，
     无条件加一，于是**连点四张、全错的也达标、也解锁游戏**，护城河形同虚设。
     更值得记的是它为什么一直没被发现——`tools/test_daily.js` 里那些
     「做满卡片 → 达标」的断言是**复刻**了一份判定逻辑来测的，
     所以它测的是「我以为的规则」；真实代码里那个无条件加一的 `bumpDaily('card')`，
     复刻的那份永远看不见。**测副本不等于测代码。**
     所以这里让卡片真的被答一遍，再看 state.daily 动没动。
     ------------------------------------------------------------------ */
  console.log('\n[达标要判对：真的答一张，看计数动没动]');

  const dailyStep = async (mode) => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'load' });
    await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
    await p.evaluate((m) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      // 今日进度清零、闸门武装，然后用**真实的渲染和处理器**答一张卡
      state.daily = {
        date: todayStr(), cards: 0, lessons: 0, extra: 0, tried: 0,
        skipped: false, met: false, fogPass: false, metAt: null,
      };
      state.gate = Object.assign({}, state.gate, { enabled: true, packages: ['com.example.game'] });
      const cards = CONTENT.cards.cards;
      const card = (m === 'genreBad' || m === 'genreOk' || m === 'clueBad')
        ? cards.find((c) => c.genre)          // 有读局步骤的卡
        : cards.find((c) => !c.genre);        // 没有读局步骤的卡
      session.queue = [card];
      session.i = 0;
      session.lowLoad = false;
      go('practice');
      renderCard();
    }, mode);
    const info = await p.evaluate(() => {
      const card = session.queue[session.i];
      const btns = [...document.querySelectorAll('#genreStep .genre-btn')].map((b) => b.dataset.g);
      const right = [card.genre].concat(card.genreAlt || []);
      const clues = card.clues || [];
      return {
        id: card.id, right, btns,
        wrong: btns.filter((g) => !right.includes(g)),
        best: card.best,
        notBest: (card.options.find((o) => o.id !== card.best) || {}).id,
        clueOkIdx: clues.findIndex((x) => x.ok),
        clueBadIdx: clues.findIndex((x) => !x.ok),
        clueN: clues.length,
        // 依据那一步放出来之前，动作选项必须是不可见的
        optsHiddenBeforeClue:
          getComputedStyle(document.getElementById('opts')).display === 'none',
      };
    });
    // 第一步：读局（只有 genre 卡有）
    if (info.btns.length) {
      const okGenre = mode !== 'genreBad';
      await p.click(`#genreStep .genre-btn[data-g="${okGenre ? info.right[0] : info.wrong[0]}"]`);
    }
    // 第二步：指依据（2.37 新增的强制步骤）。选了才放出动作选项。
    let optsHiddenAfterGenre = null;
    if (info.clueN) {
      optsHiddenAfterGenre = await p.evaluate(
        () => getComputedStyle(document.getElementById('opts')).display === 'none');
      const idx = mode === 'clueBad' ? info.clueBadIdx : info.clueOkIdx;
      await p.click(`#clueStep .genre-btn[data-c="${idx}"]`);
    }
    // 第三步：选动作。验「读局/依据出错」时动作选**对**的，
    // 这样「没达标」只可能来自前面那两步，不会和动作选错混在一起。
    const action = mode === 'actionWrong' ? info.notBest : info.best;
    await p.click(`#opts .opt[data-id="${action}"]`);
    await p.waitForTimeout(250);
    const after = await p.evaluate(() => ({
      cards: state.daily.cards, tried: state.daily.tried, met: state.daily.met,
      armed: !!(state.gate && state.gate.armed),
      feedback: (document.querySelector('#fb h3') || {}).textContent || '',
    }));
    await p.close();
    return { info, after, optsHiddenAfterGenre };
  };

  const gBad = await dailyStep('genreBad');
  chk('读局判错 → 不计入达标（这就是原来那个洞）',
    gBad.after.cards === 0 && gBad.after.tried === 1,
    `${gBad.info.id}：cards=${gBad.after.cards} tried=${gBad.after.tried}（期望 0 / 1）`);
  chk('读局判错时闸门仍然武装（游戏还是进不去）', gBad.after.armed === true);
  chk('读局判错时不会误判成达标', gBad.after.met === false);

  const gOk = await dailyStep('genreOk');
  chk('读局判对 → 计入达标',
    gOk.after.cards === 1 && gOk.after.tried === 1,
    `${gOk.info.id}：cards=${gOk.after.cards} tried=${gOk.after.tried}（期望 1 / 1）`);

  /* 「必须选一句依据才算数」（2.37，用户点名要的）
     治的是他自述的「分不清情况、直接得出结论」：判局之前得先把依据指出来。 */
  chk('判局放出来时，动作选项还锁着（必须先指依据）',
    gOk.info.clueN === 0 || gOk.optsHiddenAfterGenre === true,
    `clueN=${gOk.info.clueN} 判局后选项仍隐藏=${gOk.optsHiddenAfterGenre}`);
  const gClueBad = await dailyStep('clueBad');
  chk('局判对但依据找错 → 不算判准，不计入达标',
    gClueBad.after.cards === 0 && gClueBad.after.tried === 1,
    `${gClueBad.info.id}：cards=${gClueBad.after.cards} tried=${gClueBad.after.tried}（期望 0 / 1）`);
  chk('依据没找对时闸门仍然武装', gClueBad.after.armed === true);

  // 反馈里要把「依据对不对」说出来，否则这一步练不到东西
  const fb = await (async () => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    await p.goto(OFFLINE, { waitUntil: 'load' });
    await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
    await p.evaluate(() => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      const card = CONTENT.cards.cards.find((c) => (c.clues || []).length);
      session.queue = [card]; session.i = 0; session.lowLoad = false;
      go('practice'); renderCard();
      return card.id;
    });
    const idx = await p.evaluate(() => (session.queue[session.i].clues || []).findIndex((x) => !x.ok));
    await p.click(`#genreStep .genre-btn[data-g="${(await p.evaluate(() => session.queue[session.i].genre))}"]`);
    await p.click(`#clueStep .genre-btn[data-c="${idx}"]`);
    const best = await p.evaluate(() => session.queue[session.i].best);
    await p.click(`#opts .opt[data-id="${best}"]`);
    await p.waitForTimeout(250);
    const text = await p.evaluate(() => document.querySelector('#fb').textContent.replace(/\s+/g, ' '));
    await p.close();
    return text;
  })();
  chk('反馈里说了「你指的依据」',
    /你指的依据/.test(fb), fb.slice(0, 90));
  chk('依据错了会指出真正站得住的那条', /不是这句话真正的判据|真正能站住/.test(fb));
  chk('并且解释为什么依据错了不算过（多半是蒙对的）', /蒙对/.test(fb));

  const aBad = await dailyStep('actionWrong');
  chk('没有读局步骤的卡：动作选错 → 不计入达标',
    aBad.after.cards === 0 && aBad.after.tried === 1,
    `${aBad.info.id}：cards=${aBad.after.cards} tried=${aBad.after.tried}（期望 0 / 1）`);

  const aOk = await dailyStep('actionOk');
  chk('没有读局步骤的卡：动作选对 → 计入达标',
    aOk.after.cards === 1 && aOk.after.tried === 1,
    `${aOk.info.id}：cards=${aOk.after.cards} tried=${aOk.after.tried}（期望 1 / 1）`);

  // 规则必须写在界面上，不能悄悄改（这个项目的硬规矩）
  const said = await (async () => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    await p.goto(OFFLINE, { waitUntil: 'load' });
    await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
    const r = await p.evaluate(() => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      state.daily = {
        date: todayStr(), cards: 0, lessons: 0, extra: 0, tried: 3,
        skipped: false, met: false, fogPass: false, metAt: null,
      };
      go('today');
      return document.querySelector('.today-card').textContent.replace(/\s+/g, ' ');
    });
    await p.close();
    return r;
  })();
  chk('界面上写明了「卡片要判对才算数」', /判对才算/.test(said));
  chk('界面上写出了「答了 3 张」（否则不动的数字看起来像坏了）',
    /答了 3 张/.test(said), said.slice(0, 120));

  chk('无脚本报错', errs.length === 0, errs.join(' | ') || '无');
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
