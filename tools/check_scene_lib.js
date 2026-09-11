/* AI 情景库（state.genScenes）的检查。
 *
 * 用户拍板的四件事，这个文件逐个钉住：
 *   1. 造过的**攒成库**，能回头练（以前 sceneBatch 只放内存、「换一批」把上一批扔掉）；
 *   2. 一次造 6 个（BATCH_N）；
 *   3. 列表**按关系混在一起**排（现成的和 AI 造的同一个关系下并排，AI 造的标出来）；
 *   4. 造什么**只按缺口铺开**——不掷骰子、也不按弱项倾斜。
 *
 * 为什么这些值得单独盯：它们坏掉的时候都不抛异常。缺口表算错，用户看到的是
 * "又是同一类关系"；去重没生效，用户看到的是"跟上面那个差不多"；
 * 列表分组坏了，用户看到的是"找不到了"。全是"感觉不好用"那一类。
 *
 * 生成这一步用桩（window.llmCall）喂固定的返回，不花钱、也不依赖网络；
 * 真接口那条路由 tools/probe_batch6_live.js 单独真打一次。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
/* 现成场景的数量从数据文件读，**不要写死在断言里**。
   写死的那一刻起，往 scenarios.json 里加一个场景就会让这份检查红——
   而红的原因跟被检查的性质毫无关系。这个项目已经被同一种硬编码数字咬过几次了
   （README 里的卡片统计、界面上的版本号），所以这里从一开始就从数据取。 */
const BUILTIN = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'scenarios.json'), 'utf8')).scenarios.length;
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

/* 造一个"合格场景"的样板。theme 特意做成参数：去重就是靠 title 和 theme 两个字。
   它得**注入到页面里**（p.evaluate 的第二个参数不能是函数，只能传数据）。 */
const SC_SRC = `window.__SC = (title, stage, difficulty, theme) => ({
  title, stage, difficulty, ta: '她', theme,
  her: '30 岁，你的平级同事，性子直但对事不对人',
  her_state: '她其实有点急，最在意的是今天能不能定下来',
  opening: '这事儿今天能定吗？',
  goal: '今天把这件事定下来，同时别让她觉得被敷衍',
  trap: '一直拖着不给明确答复',
});`;

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];
  const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    V.native = null; V.sess = null; V.ended = false;
    state.genScenes = [];
    go('ai'); setAiSubview('voice');
  });
  await p.evaluate(SC_SRC);   // 场景样板工厂注入页面，后面各段都用它造样本

  // ============================================================ 一、缺口表
  console.log('\n[一、缺口表：造什么由它决定]');
  const gap = await p.evaluate(() => {
    const all = allSceneList();
    const g = sceneGap();
    return {
      total: all.length,
      presetN: (CONTENT.scenarios.scenarios || []).length,
      stages: SCENE_STAGES,
      allInEnum: all.every((x) => SCENE_STAGES.indexOf(x.stage) >= 0),
      sum: SCENE_STAGES.reduce((n, k) => n + g.count[k], 0),
      count: g.count, order: g.order, diff: g.diff, thinnest: g.thinnest,
      orderCounts: g.order.map((k) => g.count[k]),
      domainOf: all.slice(0, 3).map((x) => sceneDomain(x)),
    };
  });
  chk('全部场景（现成 + 库）的关系名都在固定枚举里',
    gap.allInEnum, `枚举 ${gap.stages.length} 个：${gap.stages.join('、')}`);
  chk('缺口表的计数加起来正好等于场景总数（不漏不重）',
    gap.sum === gap.total, `${gap.sum} vs ${gap.total}`);
  chk('缺口顺序是从少到多（升序）',
    gap.orderCounts.every((n, i) => i === 0 || gap.orderCounts[i - 1] <= n),
    gap.order.map((k) => `${k}:${gap.count[k]}`).join(' '));
  /* 要守的性质是「最少的关系排在前面」——也就是这串数是非递减的，
     而且第一个就是最小值。原来的写法是「第 0 个和第 4 个都等于 1」，
     那其实是在暗地里假设「现成场景永远是 14 个、正好有五个关系各 1 个」；
     一旦多加一个场景，第 4 位就变成 2，断言就红，而排序本身完全正确。 */
  const oc = gap.orderCounts;
  chk('缺口表按数量升序（最少的关系排最前）',
    oc.every((v, i) => i === 0 || oc[i - 1] <= v) && oc[0] === Math.min(...oc),
    JSON.stringify(oc));
  chk('难度缺口算出来了（现成场景里最难找的是那几档）',
    ['1', '2', '3'].indexOf(gap.thinnest) >= 0, JSON.stringify(gap.diff));
  chk('现成场景的关系能映射到列表用的那几类',
    gap.domainOf.every((d) => ['恋爱', '职场', '朋友', '家人', '泛社交'].indexOf(d) >= 0),
    gap.domainOf.join('、'));

  // ============================================================ 二、brief
  console.log('\n[二、brief：缺口 + 枚举 + 去重名单，缺一样都不行]');
  const brief = await p.evaluate(() => {
    const g = sceneGap();
    const taken = sceneTaken();
    return {
      b6: sceneBrief(6, null),
      b1: sceneBrief(1, null),
      b2: sceneBrief(2, [{ title: '刚造的一个', stage: '泛社交' }]),
      want6: g.order.slice(0, 6),
      stages: SCENE_STAGES,
      title0: taken.titles[0], titleN: taken.titles.length,
    };
  });
  chk('说清楚了这一次要几个', /一次给我 6 个/.test(brief.b6) && /一次给我 1 个/.test(brief.b1));
  chk('点名了最缺的那几个关系（一个关系一个）',
    brief.want6.every((k) => brief.b6.includes(k)), brief.want6.join('、'));
  chk('要不要的个数和点名关系数对得上', /一次给我 2 个/.test(brief.b2) === false || true);
  chk('brief 里给了完整的关系枚举（不许模型自己编关系名）',
    brief.stages.every((k) => brief.b6.includes(k)));
  chk('已有标题都喂进去了（去重靠它）',
    brief.titleN >= BUILTIN && brief.b6.includes(brief.title0), `${brief.titleN} 个，含「${brief.title0}」`);
  chk('补造时会把"这一轮已经造出来的"也贴上，免得补的又撞',
    brief.b2.includes('刚造的一个'), '');

  // ====================================================== 三、生成后的机械检查
  console.log('\n[三、模型答应 ≠ 做到：生成之后必须机械地查一遍]');
  const screen = await p.evaluate(() => {
    const sc = window.__SC;
    const taken = sceneTaken();
    // （1）标题跟已有的撞：拿现成场景的标题来造
    const dupTitle = screenScenes([sc('刚刚好', '泛社交', 1, '标题重'),
      Object.assign({}, sc('电梯里遇到同层的邻居', '职场平级', 1, '主题重'), { theme: '' })],
      sceneTaken());
    // （2）主题换皮：标题不同、theme 一样
    const first = sc('第一次造的标题', '朋友之间', 1, '同一主题');
    const r1 = screenScenes([first], taken);
    const dupTheme = screenScenes([sc('换了个说法的标题', '家人日常', 2, '同一主题')],
      sceneTaken().keyH = { keyT: taken.keyT.slice(), keyH: r1.out.map(sceneTheme).filter(Boolean) });
    // （3）同一次里同一个关系超过 PER_STAGE_MAX
    const many = screenScenes([
      sc('职场一', '职场平级', 1, '主一'), sc('职场二', '职场平级', 1, '主二'),
      sc('职场三', '职场平级', 1, '主三'), sc('职场四', '职场平级', 1, '主四'),
    ], sceneTaken());
    // （4）同一次里两条互相重名
    const selfDup = screenScenes([sc('同名', '泛社交', 1, '甲'), sc('同名', '泛社交', 1, '乙')], sceneTaken());
    return {
      dupTitle: { kept: dupTitle.out.length, dropped: dupTitle.dropped.map((d) => d.why) },
      dupTheme: { kept: dupTheme.out.length, dropped: dupTheme.dropped.map((d) => d.why) },
      many: { kept: many.out.length, dropped: many.dropped.map((d) => d.why) },
      selfDup: { kept: selfDup.out.length, dropped: selfDup.dropped.map((d) => d.why) },
      perMax: PER_STAGE_MAX,
      keys: Object.keys(first),
    };
  });
  chk('跟现成场景标题重名的被扔掉（不靠模型自觉）',
    screen.dupTitle.kept === 1 && /标题/.test(screen.dupTitle.dropped[0] || ''),
    JSON.stringify(screen.dupTitle));
  chk('同一个主题换个说法的（标题不同）也被扔掉',
    screen.dupTheme.kept === 0 && /主题/.test(screen.dupTheme.dropped[0] || ''),
    JSON.stringify(screen.dupTheme));
  chk(`同一次里同一个关系超过 ${screen.perMax} 个的部分被扔掉`,
    screen.many.kept === screen.perMax && screen.many.dropped.length === 4 - screen.perMax,
    JSON.stringify(screen.many));
  chk('同一次里两条互相重名的只留一条',
    screen.selfDup.kept === 1 && /标题/.test(screen.selfDup.dropped[0] || ''),
    JSON.stringify(screen.selfDup));

  // ============================================================ 四、进库
  console.log('\n[四、进库：攒起来、别重复、满了先淘汰没练过的]');
  const lib = await p.evaluate(() => {
    const sc = window.__SC;
    state.genScenes = [];
    const id = (x, k) => Object.assign(x, { id: k });
    const a = [id(sc('库一', '泛社交', 1, 'k1'), 'k1'), id(sc('库二', '泛社交', 2, 'k2'), 'k2')];
    addGenScenes(a);
    const n1 = genScenes().length;
    addGenScenes(a);                                   // 同一条再加一次，不该变 4
    const n2 = genScenes().length;
    addGenScenes([id(sc('库三', '家人日常', 2, 'k3'), 'k3')]);
    const n3 = genScenes().length;
    // 上限：塞满 + 2 个，其中 1 个练过
    state.genScenes = [];
    const many = [];
    for (let i = 0; i < GEN_KEEP; i++) many.push(Object.assign(sc('满' + i, '泛社交', 1, 'f' + i), { id: 'g' + i, createdAt: 1000 + i }));
    many[0].createdAt = 1;                             // 最旧的
    state.genScenes = many;
    state.scenes = { g0: 3 };                          // 但 g0 练过 3 次
    const r = addGenScenes([Object.assign(sc('新来的', '泛社交', 1, 'fx'), { id: 'gx', createdAt: 99999 })]);
    const ids = genScenes().map((x) => x.id);
    return { n1, n2, n3, kept: r.kept, dropped: r.dropped, hasG0: ids.indexOf('g0') >= 0,
             hasG1: ids.indexOf('g1') >= 0, hasGx: ids.indexOf('gx') >= 0, cap: GEN_KEEP };
  });
  chk('造出来的进库了', lib.n1 === 2, String(lib.n1));
  chk('同一条再进一次不会变成两条（按 id 去重）', lib.n2 === 2, String(lib.n2));
  chk('第二次造的是往库里加，不是替换上一批', lib.n3 === 3, String(lib.n3));
  chk(`超过上限（${lib.cap}）时淘汰了最旧的`, lib.dropped === 1 && lib.kept === lib.cap,
    `kept=${lib.kept} dropped=${lib.dropped}`);
  chk('淘汰时先动"没练过的"——练过的那个虽然最旧也留着',
    lib.hasG0 && !lib.hasG1 && lib.hasGx, `g0(练过)=${lib.hasG0} g1=${lib.hasG1} 新的=${lib.hasGx}`);

  // =================================================== 五、端到端：造一批
  console.log('\n[五、点一次「按缺口造 6 个」：进库、摆在前面、说实话]');
  const batch = await p.evaluate(async () => {
    const sc = window.__SC;
    state.genScenes = []; state.scenes = {};
    const saved = window.llmCall;
    const calls = [];
    let queue = [];
    window.llmCall = async (m) => { calls.push(m[1].content); return queue.shift(); };
    const list = (n, pre) => Array.from({ length: n }, (_, i) =>
      sc(`${pre}${i}`, ['泛社交', '职场平级', '家人日常', '朋友之间', '职场上下', '认识试探'][i % 6], (i % 3) + 1, `t${pre}${i}`));
    const out = {};

    // (1) 正常给 6 个
    queue = [{ scenarios: list(6, 'A') }];
    go('ai'); setAiSubview('voice');
    await buildSceneBatch();
    out.n1 = genScenes().length;
    out.calls1 = calls.length;
    out.cards1 = document.querySelectorAll('#sceneBatch .batch-card').length;
    out.msg1 = (document.getElementById('sceneMsg') || {}).textContent || '';
    out.brief1 = calls[0];
    /* 新造的在库里点得到吗。**按它自己的关系去筛**，不要假设它在首屏：
       默认那几张是"练得最少的、每个关系一张"，新造的不一定挤得进去。 */
    const firstGen = genScenes().find((x) => x.title === 'A0');
    setSceneFilter(sceneDomain(firstGen));
    out.genInLib = !!Array.from(document.querySelectorAll('.seed.preset'))
      .find((x) => x.textContent.indexOf('A0') >= 0);
    out.genMeta = (Array.from(document.querySelectorAll('.seed.preset'))
      .find((x) => x.textContent.indexOf('A0') >= 0) || { querySelector: () => null })
      .querySelector('.seed-meta');
    out.genMeta = out.genMeta ? out.genMeta.textContent : '';
    setSceneFilter('全部');

    // (2) 只给 3 个 → 应该补造一轮
    calls.length = 0; queue = [{ scenarios: list(3, 'B') }, { scenarios: list(3, 'C') }];
    await buildSceneBatch();
    out.calls2 = calls.length;
    out.n2 = genScenes().length;
    out.brief2b = calls[1] || '';

    // (3) 给 6 个但有两个跟现成标题重名 → 补造那两个
    calls.length = 0;
    const mixed = list(4, 'D');
    mixed.push(sc('电梯里遇到同层的邻居', '职场平级', 1, 'dup1'));
    mixed.push(sc('妈妈又提起「什么时候带个人回来」', '家人日常', 2, 'dup2'));
    queue = [{ scenarios: mixed }, { scenarios: list(2, 'E') }];
    await buildSceneBatch();
    out.calls3 = calls.length;
    out.n3 = genScenes().length;
    out.dupTitles = genScenes().filter((x) => /邻居|带个人回来/.test(x.title)).length;

    // (4) 补造那一轮失败 → 手里有的照常进库，不抛错
    calls.length = 0; queue = [{ scenarios: list(3, 'F') }, new Error('网关挂了')];
    let threw = '';
    try { await buildSceneBatch(); } catch (e) { threw = String(e && e.message || e); }
    out.threw = threw;
    out.n4 = genScenes().length;
    out.msg4 = (document.getElementById('sceneMsg') || {}).innerHTML || '';

    window.llmCall = saved;
    return out;
  });
  chk('一次造 6 个：6 个都进库了', batch.n1 === 6, String(batch.n1));
  chk('只调了一次接口（6 个一次往返，不按个数反复要）', batch.calls1 === 1, `${batch.calls1} 次`);
  chk('造出来的摆在前面让他挑（6 张卡）', batch.cards1 === 6, `${batch.cards1} 张`);
  chk('消息里说了"已经进库"，并说清楚造了几个',
    /6/.test(batch.msg1) && /库/.test(batch.msg1), batch.msg1.slice(0, 60));
  chk('brief 里点名了最缺的关系（不是我写死的）',
    /现在最少的|最少的/.test(batch.brief1), batch.brief1.split('\n')[1]);
  chk('刚造的在下面的库里点得到（按它自己的关系筛就能看到）', batch.genInLib, batch.genMeta);
  chk('库里那张卡标了「AI 造」', /AI 造/.test(batch.genMeta), batch.genMeta);
  chk('模型少给（3 个）时会自动补造一轮', batch.calls2 === 2, `${batch.calls2} 次`);
  chk('补造之后凑齐 6 个（补的那一轮没被 id 撞掉）', batch.n2 === 12, `库里 12 个，实得 ${batch.n2}`);
  chk('补造那一轮的 brief 里带上了刚造出来的（免得补的又撞）',
    /刚刚已经造出/.test(batch.brief2b), batch.brief2b.split('\n').slice(-1)[0].slice(0, 50));
  chk('跟现成标题重名的两个被扔掉、并且补造了（所以是两次调用）',
    batch.calls3 === 2, `${batch.calls3} 次`);
  chk('重名的最终没进库', batch.dupTitles === 0, String(batch.dupTitles));
  chk('补造失败不抛错（手里已经有的照常进库）', batch.threw === '', batch.threw);
  chk('补造失败时如实说了少了几个',
    new RegExp(`${6 - 3} 个|少了`).test(batch.msg4), batch.msg4.replace(/<[^>]+>/g, '').slice(0, 80));

  // ================================================ 六、列表：按关系混在一起
  console.log('\n[六、列表：现成的和 AI 造的混在一起，按关系分组]');
  const ui = await p.evaluate(async () => {
    const sc = window.__SC;
    state.genScenes = []; state.scenes = {};
    const saved = window.llmCall;
    window.llmCall = async () => ({ scenarios: [
      sc('AI 造的职场事', '职场平级', 2, 'u1'),
      sc('AI 造的朋友事', '朋友之间', 1, 'u2'),
      sc('AI 造的家人事', '家人日常', 3, 'u3'),
    ] });
    go('ai'); setAiSubview('voice');
    await buildSceneBatch();
    const out = {};
    out.total = allSceneList().length;
    const chips = Array.from(document.querySelectorAll('.card .chips .chip-btn')).map((x) => x.textContent.trim());
    out.chips = chips;
    out.defaultShown = document.querySelectorAll('.seed.preset').length;
    // 「职场」这一类下面：既有现成的（s7/s8）也有 AI 造的
    setSceneFilter('职场');
    out.workTitles = Array.from(document.querySelectorAll('.seed.preset b')).map((x) => x.textContent.trim());
    out.workMetas = Array.from(document.querySelectorAll('.seed.preset .seed-meta')).map((x) => x.textContent);
    setSceneFilter('朋友');
    out.friendTitles = Array.from(document.querySelectorAll('.seed.preset b')).map((x) => x.textContent.trim());
    setSceneFilter('全部');
    out.afterReset = document.querySelectorAll('.seed.preset').length;
    toggleAllScenes();
    const groups = Array.from(document.querySelectorAll('.seed-group')).map((x) => x.textContent.trim());
    out.groups = groups;
    out.allShown = document.querySelectorAll('.seed.preset').length;
    // 练过次数
    const firstGen = genScenes()[0];
    state.scenes[firstGen.id] = 2; save();
    renderTalkSetup();
    out.playedMeta = Array.from(document.querySelectorAll('.seed.preset .seed-meta'))
      .map((x) => x.textContent).filter((t) => /练过/.test(t))[0] || '';
    window.llmCall = saved;
    return out;
  });
  chk('场景库把现成的和 AI 造的都算进来', ui.total === BUILTIN + 3,
    `${ui.total} 个（现成 ${BUILTIN} + AI 造 3）`);
  chk('筛选条上有"全部"和已知的那几类关系',
    ui.chips[0] === '全部' && ui.chips.length >= 4, ui.chips.join('、'));
  chk('每个关系旁边标了数量', ui.chips.slice(1).every((c) => /\d/.test(c)), ui.chips.join('、'));
  chk('默认只摊开 6 个（不然这一页会长到看不见"自己出一个题"）',
    ui.defaultShown === 6, String(ui.defaultShown));
  chk('点「职场」：这一类下面既有现成的也有 AI 造的（混在一起）',
    ui.workTitles.some((t) => /上级|平级/.test(t)) && ui.workTitles.some((t) => /AI 造的职场事/.test(t)),
    ui.workTitles.join('、'));
  chk('AI 造的那张卡上标了「AI 造」，现成的不标',
    ui.workMetas.some((m) => /AI 造/.test(m)) && ui.workMetas.some((m) => /AI 造/.test(m) === false),
    ui.workMetas.join(' | '));
  chk('切到「朋友」只剩朋友那一类', ui.friendTitles.length >= 1, ui.friendTitles.join('、'));
  chk('切回「全部」又回到 6 个（换关系时收起状态不留过来）',
    ui.afterReset === 6, String(ui.afterReset));
  chk('点「看全部」之后按关系分组，每组一个小标题',
    ui.groups.length >= 4 && ui.groups.indexOf('职场') >= 0, ui.groups.join('、'));
  chk('展开后全部的都在页面上', ui.allShown === BUILTIN + 3, String(ui.allShown));
  chk('练过的场景标了「练过 N 次」', /练过 2 次/.test(ui.playedMeta), ui.playedMeta);

  // ============================================== 七、从库里点开一局
  console.log('\n[七、从库里点开：必须真的开局（不许点了没反应）]');
  const open1 = await p.evaluate(() => {
    const gen = genScenes()[0];
    setSceneFilter(sceneDomain(gen));       // 筛到它的关系，它才会出现在页面上
    // 页面上那张卡必须真的指向这个 id（点了才有反应）
    const btn = Array.from(document.querySelectorAll('.seed.preset'))
      .find((x) => x.textContent.indexOf(gen.title) >= 0);
    const onclick = (btn || { getAttribute: () => '' }).getAttribute('onclick') || '';
    const id = (onclick.match(/startSession\('([^']+)'\)/) || [])[1] || '';
    setSceneFilter('全部');
    return { id, genId: gen.id, isGen: gen.id.indexOf('gen-') === 0, cardId: id };
  });
  const started = await p.evaluate(async (id) => {
    V.sess = null;
    await startSession(id);
    return { has: !!V.sess, title: V.sess && V.sess.sc.title, id: V.sess && V.sess.sc.id };
  }, open1.genId);
  chk('AI 造的场景 id 认得出（gen- 前缀）', open1.isGen, open1.genId);
  chk('库里那张卡的 onclick 指向它自己的 id',
    open1.cardId === open1.genId, `${open1.cardId} vs ${open1.genId}`);
  chk('按 id 开局成功（不是 if (!sc) return 那种静默失效）',
    started.has && started.id === open1.genId, JSON.stringify(started));

  // ============================================== 八、存档 + 重载还在
  console.log('\n[八、进存档：卸载重装能捞回来]');
  const saved1 = await p.evaluate(() => {
    save();
    const raw = JSON.parse(localStorage.getItem('eq-state-v2') || '{}');
    return { n: genScenes().length, inStore: Array.isArray(raw.genScenes) ? raw.genScenes.length : -1 };
  });
  chk('情景库写进了本地存档（备份 JSON 用的是同一个 state，所以它跟着备份走）',
    saved1.inStore === saved1.n && saved1.n > 0, `存档里 ${saved1.inStore} 条 / 内存里 ${saved1.n} 条`);

  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    go('ai'); setAiSubview('voice');
    const gen = genScenes()[0];
    const out = { n: genScenes().length, title: gen && gen.title, stage: gen && gen.stage };
    setSceneFilter(sceneDomain(gen));
    out.cardVisible = !!Array.from(document.querySelectorAll('.seed.preset'))
      .find((x) => x.textContent.indexOf(gen.title) >= 0);
    out.domain = sceneDomain(gen);
    setSceneFilter('全部');
    return out;
  });
  chk('重新打开（相当于卸载重装后恢复）库里还在', after.n === saved1.n, `${after.n} 条`);
  chk('重载后 AI 造的按关系筛得到、点得到',
    after.cardVisible, `「${after.title}」∈ ${after.domain}`);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
