/* 两条断言：每个 tab×二级子页的正文必须两两不同；闸门要能从已安装应用里挑。
 *
 * 第一组来自一个真 bug：用户报「练习和AI点进去发现两个界面变成一样了」。
 * 根因是 `cardsView` 这个变量被赋值 5 次、**一次都没被读过**，
 * 于是「成长 → 偏差画像」和「成长 → 我的预案」都渲染成了刷卡片那一页——
 * 三个入口长得一模一样。它不报错、不抛异常，只让页面悄悄退化。
 *
 * 所以这里不逐个去检查渲染函数，而是直接断言：**十个页面的正文两两不同**。
 * 任何一次「某个子页退化成另一个子页」都会立刻失败，比人肉看可靠。
 *
 * 比对时必须把二级切换条排除掉：切换条是每个 tab 注入的，而且
 * 「阶段|偏差画像|我的预案」这三个标签在 bias 和 plans 下**文字完全相同**
 * （只有高亮不同）。带着切换条比，恰好会漏掉这次这个 bug。
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

const COMBOS = [
  ['today', null], ['practice', '卡片'], ['practice', '语境校准'], ['practice', '微课'],
  ['practice', '闲聊'],
  ['ai', '场景对话'], ['ai', '表达体检'], ['ai', '真实复盘'],
  ['growth', '阶段'], ['growth', '偏差画像'], ['growth', '我的预案'],
];

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

  // ------------------------------------------------------- 每页正文两两不同
  console.log('\n[十个页面：正文必须两两不同]');
  const rows = [];
  for (const [tab, subLabel] of COMBOS) {
    const r = await p.evaluate((args) => {
      go(args.tab);
      if (args.sub) {
        const nav = document.querySelector('.subnav');
        const btn = nav && [...nav.querySelectorAll('button')]
          .find((x) => x.textContent.trim() === args.sub);
        if (btn) btn.click();
      }
      const v = document.getElementById('view');
      // 克隆之后把二级切换条摘掉再取文本：切换条是「每个 tab 注入一次」的公共部分，
      // 而 bias/plans 的切换条文字完全相同，带着它比会漏掉退化成同一个页面的 bug
      const c = v.cloneNode(true);
      c.querySelectorAll('.subnav').forEach((x) => x.remove());
      const body = c.textContent.replace(/\s+/g, '');
      return {
        lab: `${args.tab}/${args.sub || '-'}`,
        sig: body.slice(0, 200),
        len: body.length,
        // 每页的第一句有辨识度的话
        head: body.slice(0, 40),
      };
    }, { tab, sub: subLabel });
    await p.waitForTimeout(120);
    rows.push(r);
  }
  rows.forEach((r) => console.log(`  ${r.lab.padEnd(16)} 长度=${String(r.len).padStart(5)}  开头：${r.head}`));

  let dup = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].sig && rows[i].sig === rows[j].sig) {
        chk(`「${rows[i].lab}」和「${rows[j].lab}」不是同一页`, false, '正文完全相同');
        dup++;
      }
    }
  }
  chk('十个页面没有任何两页正文相同', dup === 0, `${dup} 对重复`);

  // 三个页面各自的特征内容（防「看起来不一样但其实都退化成了别的页」）
  const pick = (lab) => rows.find((r) => r.lab === lab) || {};
  chk('偏差画像页真的在讲偏差', /偏差画像/.test(pick('growth/偏差画像').head || '')
    && /命中率|误读/.test(pick('growth/偏差画像').head || ''), pick('growth/偏差画像').head);
  chk('我的预案页真的在讲预案',
    /预案/.test(pick('growth/我的预案').head || ''), pick('growth/我的预案').head);
  /* 刷卡片页必须问 DOM，不能数文字。
   *
   * 原来数正文里 A/B/C/D 开头的选项（要求 ≥3 个）。但**卡片是随机抽的**，
   * 而带判局的卡片会故意先把四个选项藏起来——先判断「这是什么局」再选动作，
   * 这正是这个 App 的核心设计。所以抽到判局卡时那条断言必然失败，
   * 于是 check_tabs_unique 时好时坏。
   * 改成直接问 DOM，并把设计不变式也一起断言上：判局在时选项必须藏着。 */
  const drillDom = await p.evaluate(() => {
    // 必须**先导航到刷卡片页**再读 DOM：上面那圈循环最后停在「成长/我的预案」，
    // 那时 cardsView 是 plans，页面上当然没有选项区。
    goPracticeCards();
    const opts = document.getElementById('opts');
    return {
      hasGenre: !!document.getElementById('genreStep'),
      hasOpts: !!opts,
      optsVisible: !!(opts && opts.getBoundingClientRect().height > 0),
      cardsView,
    };
  });
  chk('刷卡片页是题目页（判局步骤或选项区在）',
    (drillDom.hasGenre || drillDom.hasOpts) && drillDom.cardsView === 'drill',
    JSON.stringify(drillDom));
  chk('判局在的时候选项是藏起来的（这是设计，不是 bug）',
    !drillDom.hasGenre || !drillDom.optsVisible,
    `判局=${drillDom.hasGenre} 选项可见=${drillDom.optsVisible}`);

  // 按顺序连点也要对：先看画像再看预案，不能停在第一个
  console.log('\n[连着切换：不能卡在上一页]');
  const seq = await p.evaluate(async () => {
    const text = () => {
      const c = document.getElementById('view').cloneNode(true);
      c.querySelectorAll('.subnav').forEach((x) => x.remove());
      return c.textContent.replace(/\s+/g, '');
    };
    go('growth'); setGrowthSubview('bias');
    const bias1 = text().slice(0, 30);
    setGrowthSubview('plans');
    const plans1 = text().slice(0, 30);
    setGrowthSubview('bias');
    const bias2 = text().slice(0, 30);
    setGrowthSubview('stages');
    const stages1 = text().slice(0, 30);
    return { bias1, plans1, bias2, stages1, cardsViewAfter: cardsView };
  });
  chk('画像 → 预案 会真的换页', seq.bias1 !== seq.plans1, `${seq.bias1} / ${seq.plans1}`);
  chk('预案 → 画像 换得回来（不是单向的）', seq.bias2 === seq.bias1, seq.bias2);
  chk('能回到阶段页', seq.stages1 !== seq.bias1 && seq.stages1 !== seq.plans1, seq.stages1);

  // 一组做完之后那张小结卡上的「看我的预案」应该落到成长那一路
  // （原来测的是 setCardsView，那是给旧调用留的兼容壳；它已经没有任何调用点了，
  //   自检里"死函数"检查把它抓出来，我删掉了。按钮现在直接调 setGrowthSubview，
  //   所以这里改成测按钮真正走的那条路。）
  const jump = await p.evaluate(() => {
    goPracticeCards();
    const before = cardsView;
    setGrowthSubview('plans');
    return { before, after: cardsView, growthSubview, tab: currentTab,
             head: (document.querySelector('#view').textContent || '').slice(0, 24) };
  });
  chk('小结卡的「看我的预案」转到成长那一路',
    jump.before === 'drill' && jump.growthSubview === 'plans' && jump.tab === 'growth',
    JSON.stringify(jump));

  // ------------------------------------------------------- 闸门：从应用列表里挑
  console.log('\n[闸门：从已安装应用里挑，不用背包名]');
  const stub = await p.evaluate(() => {
    // 装一个只提供 listApps 的原生桩
    window.EQNative = {
      listApps: () => JSON.stringify([
        { label: '王者荣耀', pkg: 'com.tencent.tmgp.sgame' },
        { label: '抖音', pkg: 'com.ss.android.ugc.aweme' },
        { label: '哔哩哔哩', pkg: 'tv.danmaku.bili' },
        { label: '微信读书', pkg: 'com.tencent.weread' },
      ]),
    };
    state.gate = { enabled: false, packages: [] };
    const hasManual = /手动填包名/.test(document.body.textContent) || true;
    return { hasManual };
  });
  // 面板会叠：先全清掉再打开，否则 getElementById 可能取到旧那一层里的同名元素
  await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openDailySettings();
  });
  await p.waitForTimeout(200);
  const gateUi = await p.evaluate(() => {
    const sheets = [...document.querySelectorAll('.sheet')];
    const txt = sheets.map((x) => x.textContent).join('\n');
    const add = document.getElementById('addPkg');
    return {
      sheetCount: sheets.length,
      addPkgCount: document.querySelectorAll('#addPkg').length,
      hasPickBtn: !!document.querySelector('button[onclick="openAppPicker()"]'),
      // 判「收起来了」只有 checkVisibility() 准。
      // 收起的 <details> 用的是 content-visibility: hidden——它影响绘制、
      // 不影响布局盒子，所以 offsetParent 和 getClientRects() 都照样报值
      // （实测：收起的输入框 rect 是 345x49、clientRects 是 1）。
      visible: add && add.checkVisibility
        ? add.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        : null,
      manualFolded: /手动填包名/.test(txt),
      detailsOpen: !!document.querySelector('details.diag-more[open]'),
    };
  });

  // 自验证：展开之后必须判为可见。
  // 如果收起和展开都判 false，那是方法坏了、而不是功能对了——这条挡住假绿灯。
  const openedVisible = await p.evaluate(() => {
    const d = document.querySelector('details.diag-more');
    d.open = true;
    const add = document.getElementById('addPkg');
    return add.checkVisibility ? add.checkVisibility({ checkVisibilityCSS: true }) : null;
  });
  chk('展开折叠后判为可见（说明判可见性的方法本身是对的）',
    openedVisible === true, String(openedVisible));
  chk('设置页只有一个面板、一个包名输入框', gateUi.sheetCount === 1 && gateUi.addPkgCount === 1,
    `面板 ${gateUi.sheetCount} 个 / 输入框 ${gateUi.addPkgCount} 个`);
  chk('设置页有「从已安装应用里挑」这个主入口', gateUi.hasPickBtn);
  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && gateUi.visible === false && !gateUi.detailsOpen,
    `有折叠=${gateUi.manualFolded} 收起时可见=${gateUi.visible} 已展开=${gateUi.detailsOpen}`);

  const picker = await p.evaluate(() => {
    openAppPicker();
    const sh = document.getElementById('pkgSheet');
    return {
      opened: !!sh,
      items: [...document.querySelectorAll('#pkgList .pkg-item')].map((x) => x.querySelector('.pkg-label').textContent),
      hasSearch: !!document.getElementById('pkgSearch'),
      showsPkg: [...document.querySelectorAll('#pkgList .pkg-pkg')].map((x) => x.textContent.trim()),
    };
  });
  chk('挑应用的面板打得开', picker.opened);
  chk('列出了已安装应用（用名字，不是包名）', picker.items.length === 4, picker.items.join('、'));
  chk('每个应用也标了包名（便于核对）', picker.showsPkg.includes('com.tencent.tmgp.sgame'));
  chk('有搜索框', picker.hasSearch);

  // 搜应用名（中文）
  const search = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = '王者';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜应用名能过滤（中文）', search.length === 1 && search[0] === '王者荣耀', search.join('、'));
  // 搜包名（英文）——包名是 ASCII，中文搜不到它，所以这两条要分开验
  const search2 = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = 'tencent';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜包名也能过滤（英文）', search2.length === 2, search2.join('、'));
  const nohit = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = 'zzzz';
    filterPkgs();
    return document.getElementById('pkgList').textContent;
  });
  chk('搜不到时说清楚，不留空白', /没有匹配/.test(nohit), nohit.slice(0, 40));

  const tap = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = '';
    filterPkgs();
    // 点两个
    document.querySelector('.pkg-item[data-pkg="com.tencent.tmgp.sgame"]').click();
    document.querySelector('.pkg-item[data-pkg="com.ss.android.ugc.aweme"]').click();
    const btn = document.querySelector('.pkg-item[data-pkg="com.tencent.tmgp.sgame"]');
    return {
      pkgs: state.gate.packages.slice(),
      enabled: state.gate.enabled,
      marked: btn.classList.contains('on') && btn.querySelector('.pkg-mark').textContent,
      // 点选必须立刻落盘，不能等「完成」才提交
      persisted: JSON.parse(localStorage.getItem('eq-state-v2') || '{}').gate,
      othersUnmarked: !document.querySelector('.pkg-item[data-pkg="tv.danmaku.bili"]').classList.contains('on'),
      count: (document.getElementById('pkgCount') || {}).textContent,
    };
  });
  chk('点一下就是选中', tap.pkgs.length === 2, tap.pkgs.join('、'));
  chk('选中后立刻保存（挑到一半退出也不丢）',
    tap.persisted && tap.persisted.packages.length === 2, JSON.stringify(tap.persisted));
  chk('顺手把闸门打开了', tap.enabled === true);
  chk('选中的那行打了勾', /已选/.test(tap.marked), String(tap.marked));
  chk('没点的没被误选', tap.othersUnmarked);
  chk('面板上说清了已选几个', /2 个/.test(tap.count || ''), String(tap.count));

  const untap = await p.evaluate(() => {
    document.querySelector('.pkg-item[data-pkg="com.ss.android.ugc.aweme"]').click();
    return {
      pkgs: state.gate.packages.slice(),
      marked: document.querySelector('.pkg-item[data-pkg="com.ss.android.ugc.aweme"]')
        .querySelector('.pkg-mark').textContent,
    };
  });
  chk('再点一下取消选中', untap.pkgs.length === 1 && untap.marked === '', JSON.stringify(untap));

  const back = await p.evaluate(() => {
    closePicker();
    const sh = document.getElementById('pkgSheet');
    return { sheetGone: !sh, inList: /com\.tencent\.tmgp\.sgame/.test(document.body.textContent) };
  });
  chk('关掉面板回到设置页', back.sheetGone && back.inList);

  // 读不到应用时要说明白，并指出手动那条路还在
  const empty = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    window.EQNative = { listApps: () => '[]' };
    PKG_LIST = null;
    openAppPicker();
    const t = document.querySelector('#pkgSheet .inner').textContent;
    return { text: t, hasHint: /没(有)?读到|一个都/.test(t), mentionsManual: /手动填包名/.test(t) };
  });
  chk('读不到任何应用时说明白（不是静默空列表）', empty.hasHint);
  chk('读不到时指出手动填包名仍然可用', empty.mentionsManual);

  const bad = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    window.EQNative = { listApps: () => { throw new Error('读取被系统拒绝'); } };
    PKG_LIST = null;
    openAppPicker();
    return document.querySelector('#pkgSheet .inner').textContent;
  });
  chk('原生读列表抛错也不崩，而是说明原因', /读取失败|读取被系统拒绝/.test(bad), bad.slice(0, 60));

  // 这条盯的是「** 露给用户看」。这个 App 有两条文本通道：
  //   rich() 走 innerHTML（** 会变粗体）／textContent 原样显示（** 就是两个星号）。
  // 挑错通道不报错、只是难看，所以直接扫渲染结果，不关心用的哪条通道。
  console.log('\n[不许把 markdown 标记显示给用户]');
  const ast = await p.evaluate(() => {
    const bad = [];
    /* 只看**非 script/style 元素的直接文本节点**——那才是屏幕上出现的字。
       不能扫 document.body.textContent：离线单文件版把所有 JS 和内容 JSON 都内联在
       <script> 里，源码注释和 cards.json 的 note 都带 **，会被当成界面文本误报
       （我第一版就是这么写错的）。 */
    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const walk = (root, label) => {
      if (!root) return;
      root.querySelectorAll('*').forEach((el) => {
        if (SKIP[el.tagName]) return;
        [...el.childNodes].forEach((n) => {
          if (n.nodeType !== 3) return;
          const m = String(n.nodeValue).match(/\*\*[^*\n]{1,40}\*\*/);
          if (m) bad.push(label + ' <' + el.tagName.toLowerCase() + '>：' + m[0].slice(0, 30));
        });
      });
    };
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // **所有会弹出的面板都要扫**。上次只扫了「每日计划」，于是主设置页里
    // 那句「要填**完整端点**」就漏过去了——断言是对的，但没盖到出问题的地方。
    openDailySettings();
    walk(document.body, '每日计划');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    walk(document.body, '主设置页');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openFog('test');
    walk(document.body, '卡住了');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openGate(false);
    walk(document.body, '闸门');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 挑应用面板
    window.EQNative = { listApps: () => JSON.stringify([{ label: '王者荣耀', pkg: 'com.tencent.tmgp.sgame' }]) };
    PKG_LIST = null;
    openAppPicker();
    walk(document.body, '挑应用面板');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 四个 tab 的正文
    ['today', 'practice', 'ai', 'growth'].forEach((tab) => walk((go(tab), document.body), 'tab:' + tab));

    // rich() 的三个主要消费方：卡片诊断、微课正文、复盘。
    // 这几处的正文里写了 100 多处 **强调**，是本 App 里唯一大量使用 markdown 的地方。
    // 扫它们既能抓「某处漏了 rich()」，也能抓「rich() 本身坏了」。
    goPracticeCards();
    // 特意挑一张「错项的诊断里带 ** 」的卡：原来这里用的是 esc()，会把星号印出来，
    // 而同一张卡里正确那条用的是 rich()——同一屏一个对一个错。
    // 靠随机抽卡碰上是不可靠的（原来那条断言就是这么时好时坏的），所以这里指定。
    const withStars = (CONTENT.cards.cards || []).find((c) =>
      (c.options || []).some((o) => o.id !== c.best && /\*\*/.test(o.why || '')));
    const card = withStars || session.queue[session.i] || CONTENT.cards.cards[0];
    session.queue = [card]; session.i = 0; session.genrePick = null;
    renderCard();
    if (card.genre) {
      const gb = document.querySelector('#genreStep .genre-btn');
      if (gb) gb.click();
    }
    const right = (card.options || []).find((o) => o.id === card.best) || { id: 'A' };
    answerCard(right.id);
    walk(document.body, '卡片诊断');

    // 换成故意答错：错项的诊断才是原来露出星号的那条
    const wrongOpt = (card.options || []).find((o) => o.id !== card.best && /\*\*/.test(o.why || ''));
    if (wrongOpt) {
      session.queue = [card]; session.i = 0; session.genrePick = null;
      renderCard();
      if (card.genre) {
        const gb = document.querySelector('#genreStep .genre-btn');
        if (gb) gb.click();
      }
      answerCard(wrongOpt.id);
      const diag = document.querySelector('.diag-why');
      const hasBold = !!document.querySelector('.diag-why b, .diag-fix b');
      const literal = !!(diag && /\*\*/.test(diag.textContent));
      bad.push('错项诊断：粗体=' + hasBold + ' 星号露出=' + literal
        + (literal ? ' ← 这就是原来的 bug' : ''));
      if (literal || !hasBold) {
        // 已经是失败信息，用特别的前缀让它一眼可见
      }
    }
    walk(document.body, '卡片诊断(错项)');

    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openLesson((CONTENT.curriculum.lessons[0] || {}).id);
    walk(document.body, '微课正文');

    return [...new Set(bad)];
  });
  const starDiag = ast.find((x) => x.startsWith('错项诊断'));
  chk('错项诊断里的 ** 变成了粗体、没有星号露出',
    !!starDiag && /粗体=true/.test(starDiag) && /星号露出=false/.test(starDiag),
    starDiag || '(没找到带 ** 的错项)');
  const leaks = ast.filter((x) => !x.startsWith('错项诊断'));
  chk('界面上没有露出来的 ** 标记', leaks.length === 0, leaks.slice(0, 3).join(' | '));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  /* tab 条在窄屏上只留主标签，副标题收起来。
     依据是机身实况量出来的：411 CSS px 宽 / 4 个 tab = 每个 103px，减去按钮内边距剩 95px，
     而副标题在手机上要 110px 以上（Noto Sans CJK 比桌面的雅黑宽），
     任何能读的字号都放不下——四个里三个折成两行，tab 条涨到 105px（含底部安全区）。
     这一条守的是"别又把它加回来"：真要加回来，得先解决宽度，不是把断点删掉。
     「宽屏还有、且是一行」这一条也钉住——收的是窄屏，不是把它删了。 */
  {
    const tabsAt = async (w) => {
      const pg = await b.newPage({ viewport: { width: w, height: 900 } });
      await pg.goto(OFFLINE);
      await pg.waitForFunction('document.querySelector(".tabs button small")');
      await pg.waitForTimeout(300);
      const r = await pg.evaluate(() => {
        const line = (e) => Math.max(1, Math.round(
          e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 14)));
        const all = [...document.querySelectorAll('.tabs button small')];
        const shown = all.filter((e) => getComputedStyle(e).display !== 'none');
        return {
          disp: getComputedStyle(all[0]).display,
          条高: Math.round(document.querySelector('.tabs').getBoundingClientRect().height),
          可见条数: shown.length, 总条数: all.length,
          行数: shown.map(line),
        };
      });
      await pg.close();
      return r;
    };
    const phone = await tabsAt(412);
    chk('手机上（412px）副标题全部收起、tab 条回到单行高度',
      phone.disp === 'none' && phone.可见条数 === 0 && phone.条高 <= 60, JSON.stringify(phone));
    const wide = await tabsAt(900);
    chk('宽屏（900px）副标题还在（收的只是窄屏，不是把它删掉）',
      wide.disp !== 'none' && wide.可见条数 === wide.总条数, JSON.stringify(wide));
    chk('宽屏下每一条副标题都排在一行（没有折行的）',
      wide.行数.length > 0 && wide.行数.every((n) => n === 1), JSON.stringify(wide.行数));
  }

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
