/* 内容完整性测试：所有 data/*.json 的结构和引用一致性。
 *
 * 为什么需要它：内容是这个 App 的全部。卡片少一个 why 界面就空一块，
 * 微课的 answer 越界会让那道题永远判错，阶段任务挂到不存在的关卡上会永远领不到——
 * 这些都不会报错，只会静默地少一个功能。而内容是用脚本批量生成的，
 * 脚本一改就可能生成出结构不完整的东西。
 *
 * 这里只看**结构**，不评判内容好不好。跑得快，适合每次改完内容都跑。
 *
 * node tools/test_content.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const load = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${n}.json`), 'utf8'));

let pass = 0;
let fail = 0;
const problems = [];
function t(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  → ' + extra : ''}`); }
}

/* 误读类型的合法集合**从 app.js 里读**，不再手抄一份。
 *
 * 原来这里是一份硬编码的清单。这个项目的教训是「凡是需要记得改某处清单的
 * 设计，迟早会忘」——而这次忘记的后果特别隐蔽：新加的 err 类型如果不在
 * app.js 的 BIAS_TYPES 里，recordBias() 直接 return，卡片照常出题、照常判分，
 * 只是那个偏差**永远不会出现在画像里**，没有任何报错。
 *
 * 所以这里从源码解析，并且两份都查：卡片用的 err 必须在 BIAS_TYPES 里；
 * BIAS_TYPES 里有但没有任何卡片用到的，只提示、不失败。
 */
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const _b0 = APP_JS.indexOf('const BIAS_TYPES');
const biasBlock = APP_JS.slice(_b0, APP_JS.indexOf('function recordBias', _b0));
const BIAS_TYPES = [...biasBlock.matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1]);
if (!BIAS_TYPES.length) {
  console.error('从 app.js 里没解析出 BIAS_TYPES，app.js 结构变了？');
  process.exit(1);
}
const ERR_TYPES = new Set(['正解', ...BIAS_TYPES]);

/* ---------- 内容质量：两个「结构没问题但内容是次品」的形态 ----------
 *
 * 这一节是 tools/audit_quality.py 那两个发现的固化版本。它们都不是结构问题，
 * 所以原来一条断言都没挡住——而两条都会**静默削弱训练效果**：
 *
 * 1. 变体之间近乎同一句话。
 *    变体的全部意义是换检索线索（多场景是训练能泛化到真实对话的条件之一）。
 *    如果同一张卡的四条变体只是同一句话换了两个词，这个机制就等于没生效，
 *    而界面上一切正常。真实案例：「你上次说的那家咖啡店，还算数吗？」
 *    和「你上次说的那家甜品店，还算数吗？」——相似度 0.86。
 *
 * 2. 正确答案明显是最长的那个。
 *    长期下来会教出一种作弊策略：挑最长的。一个训练判断力的东西如果可以
 *    用长度猜对，那它训练的东西就没了。真实案例：正确答案 72 字，
 *    干扰项平均 26 字。
 */
const bigrams = (t) => {
  const s = String(t || '').replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
const dice = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
};

console.log('\n内容质量：');
{
  const cards = load('cards').cards;

  const near = [];
  for (const c of cards) {
    const vs = c.variants || [];
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const d = dice(vs[i].quote, vs[j].quote);
        if (d >= 0.80) near.push(`${c.id} ${d.toFixed(2)}`);
      }
    }
  }
  t('同一张卡的变体之间不近乎同一句（否则等于没换检索线索）',
    near.length === 0, near.length ? near.slice(0, 5).join('; ') : '全部低于 0.80');

  const nearOrig = [];
  for (const c of cards) {
    for (const v of (c.variants || [])) {
      const d = dice(c.quote, v.quote);
      if (d >= 0.80) nearOrig.push(`${c.id} ${d.toFixed(2)}`);
    }
  }
  t('变体跟原句也不近乎同一句', nearOrig.length === 0,
    nearOrig.length ? nearOrig.slice(0, 5).join('; ') : '全部低于 0.80');

  // 口径是「真正错的选项」，不含 ok 里的可接受答案——
  // 那些本来也是好答案，拿它们当参照会误报（这一点我一开始就搞错了一次）。
  const over = [];
  for (const c of cards) {
    const b = c.options.find((o) => o.id === c.best);
    const wrong = c.options.filter((o) => o.err !== '正解');
    if (!b || !wrong.length) continue;
    const m = Math.max(...wrong.map((o) => o.text.length));
    if (b.text.length > 1.5 * m) over.push(`${c.id} ${b.text.length}/${m}`);
  }
  t('正确答案不是明显最长的（否则可以用「挑最长」作弊）',
    over.length === 0, over.length ? over.slice(0, 5).join('; ') : '全部在 1.5 倍以内');
}

console.log('卡片：');
{
  const cards = load('cards').cards;
  const ids = cards.map((c) => c.id);
  t('id 唯一', ids.length === new Set(ids).size, `${ids.length} 张`);

  const bad = [];
  for (const c of cards) {
    if (!c.options || c.options.length !== 4) bad.push(`${c.id} 选项不是 4 个`);
    else if (new Set(c.options.map((o) => o.id)).size !== 4) bad.push(`${c.id} 选项 id 重复`);
    else if (!c.options.some((o) => o.id === c.best)) bad.push(`${c.id} best 不在选项里`);
    for (const k of ['context', 'quote', 'question', 'explain', 'principle']) {
      if (!c[k] || !String(c[k]).trim()) bad.push(`${c.id} 缺 ${k}`);
    }
    // 每个选项都要有诊断，否则界面上那一块是空的
    for (const o of (c.options || [])) {
      if (!o.why || !String(o.why).trim()) bad.push(`${c.id}.${o.id} 缺 why`);
      if (!ERR_TYPES.has(o.err)) bad.push(`${c.id}.${o.id} err 非法: ${o.err}`);
    }
    // 正确答案必须标「正解」，否则偏差画像会被算歪
    const bestOpt = (c.options || []).find((o) => o.id === c.best);
    if (bestOpt && bestOpt.err !== '正解') bad.push(`${c.id} 正确答案没标正解`);
    // if-then 预案：阶段 4 的门槛靠它，缺了就永远过不去
    if (!c.plan || !c.plan.if || !c.plan.then) bad.push(`${c.id} 缺 plan`);
  }
  t('每张卡结构完整（选项/诊断/正解标记/plan）', bad.length === 0,
    bad.length ? bad.slice(0, 6).join('; ') : `${cards.length} 张全部通过`);

  // 反向检查：BIAS_TYPES 里定义了、但没有任何题目会用到的类型。
  // 不失败（定义留着可能是给以后用），但要说出来——因为「画像里永远看不到它」
  // 正是那种不报错的静默失效，值得有人看一眼。
  const used = new Set(cards.flatMap((c) => c.options.map((o) => o.err)));
  const dead = BIAS_TYPES.filter((k) => !used.has(k));
  if (dead.length) console.log(`  提示  BIAS_TYPES 里没有任何题目用到的类型：${dead.join(', ')}`);

  /* 「读局」卡必须带 state。
   *
   * state 是这一类卡的全部价值所在——它写的是「这是什么局、还剩多少气」
   * 那一步的结论，而那一步正是最常被跳过的一步。少了它，这些卡就退化成
   * 一张普通的接话卡，界面照样渲染、照样判分，只是不再教那一层——
   * 又一个不报错的静默退化，所以钉住。
   *
   * 同时要保证它**不在答题前显示**：提前给就等于把答案送出去。
   * 下面那条检查 renderCard 里 state 没出现在选项区之前。
   */
  const read = cards.filter((c) => c.type === 'read');
  const readBad = read.filter((c) => !c.state || c.state.length < 20).map((c) => c.id);
  t('读局卡都带了 state（那次「先读局」的结论）',
    read.length > 0 && readBad.length === 0,
    readBad.length ? readBad.join(',') : `${read.length} 张读局卡`);

  /* 带判局步骤的读局卡，它的标准答案必须**在界面上真的能点到**。
   *
   * GENRES 是网页里那份可点选项的清单，genre 是卡片里的标准答案。
   * 两边一旦对不上（改了措辞、加了新局类忘了同步），这张卡就永远判不对——
   * 而且不会报错：按钮照常渲染，用户点哪个都算错，偏差画像还会一直记
   * 「误判场合」。是那种「看起来在工作、其实永远判你错」的坏法，所以钉住。
   *
   * 反向也查：genreAlt 里的备选答案同样要能点到，否则「也算对」永远不生效。
   */
  // 解析必须取到整个声明，不能只取第一行——GENRES 是换行写的，
  // 按行切会把后面几个漏掉，于是报告「不在可点清单里」，而其实在。
  // （这个断言刚写出来时就是这么误报的，所以这里写下来。）
  const gStart = APP_JS.indexOf('const GENRES');
  const gEnd = APP_JS.indexOf('];', gStart);
  if (gStart < 0 || gEnd < 0) {
    console.error('从 app.js 里没解析出 GENRES，结构变了？');
    process.exit(1);
  }
  const GENRES = [...APP_JS.slice(gStart, gEnd)
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!GENRES.length) {
    console.error('GENRES 解析为空，结构变了？');
    process.exit(1);
  }
  const genreCards = cards.filter((c) => c.genre);
  const badGenre = [];
  for (const c of genreCards) {
    if (!GENRES.includes(c.genre)) badGenre.push(`${c.id} 的 genre「${c.genre}」不在可点清单里`);
    for (const alt of (c.genreAlt || [])) {
      if (!GENRES.includes(alt)) badGenre.push(`${c.id} 的 genreAlt「${alt}」不在可点清单里`);
    }
    if ((c.genreAlt || []).includes(c.genre)) badGenre.push(`${c.id} 的 genreAlt 重复了主答案`);
  }
  t('判局的标准答案在界面上点得到（否则这张卡永远判错）',
    badGenre.length === 0,
    badGenre.length ? badGenre.slice(0, 4).join('; ')
      : `${genreCards.length} 张带判局，${GENRES.length} 个可点选项对得上`);

  const talk = cards.filter((c) => c.type === 'talk');
  t('接话卡和读局卡都不少于 10 张（输出侧和读局侧曾经是最薄的两层）',
    talk.length >= 10 && read.length >= 6, `接话 ${talk.length} · 读局 ${read.length}`);

  const withVar = cards.filter((c) => Array.isArray(c.variants) && c.variants.length);
  t('变体（有的话）结构完整', withVar.every((c) =>
    c.variants.every((v) => v.context && v.context.trim() && v.quote && v.quote.trim())),
    `${withVar.length} / ${cards.length} 张带变体，共 ${withVar.reduce((a, c) => a + c.variants.length, 0)} 条`);

  // 变体只换表面，不能改考点——所以变体卡片绝不能带自己的 options
  t('变体不带自己的选项（改了选项就等于换了考点）',
    withVar.every((c) => c.variants.every((v) => v.options === undefined)));
}

console.log('\n微课：');
{
  const lessons = load('curriculum').lessons;
  const bad = [];
  for (const l of lessons) {
    for (const k of ['series', 'level', 'title', 'read', 'warn']) {
      if (!l[k] || !String(l[k]).trim()) bad.push(`${l.id} 缺 ${k}`);
    }
    const a = l.apply;
    if (!a || !Array.isArray(a.options) || a.options.length !== 4) bad.push(`${l.id} apply 结构不对`);
    else if (!Number.isInteger(a.answer) || a.answer < 0 || a.answer > 3) bad.push(`${l.id} answer 越界`);
    else if (!a.why || !a.why.trim()) bad.push(`${l.id} 缺 why`);
  }
  t('每课结构完整（read/warn/4 选项/answer 在范围内/why）', bad.length === 0,
    bad.length ? bad.slice(0, 5).join('; ') : `${lessons.length} 课全部通过`);
  t('每课都有 warn（证据边界必须写，不能只讲结论）',
    lessons.every((l) => l.warn && l.warn.length > 20), `${lessons.length} 课`);

  /* p33 上的这条边界必须一直在。
   * 它不是普通的"证据边界"：自我抽离在抑郁风险偏高的人身上可能让情绪变差，
   * 也就是说这条内容**用错了会反着伤人**。而它又是最容易在改稿时被删掉的那种
   * ——读者会觉得"这段在泼冷水"。所以钉死它：两边都要有、实用规矩要留着，
   * 而且必须点名两项研究，避免以后有人把它改回一句没有出处的"有研究表明"。
   * 同理，界面上那一块由 check_today_ui.js 守着。 */
  const p33 = lessons.find((l) => l.id === 'p33');
  t('p33（说话之前）在', !!p33);
  if (p33) {
    const w = p33.warn || '';
    t('p33 保留了「第三人称可能反着伤人」这条边界，且两边证据都在',
      /反对/.test(w) && /支持/.test(w) && /先别写|别写/.test(w),
      w.length + ' 字');
    t('p33 这条边界点了名（Giovanetti / Kross & Ayduk），不是一句「有研究表明」',
      /Giovanetti/.test(w) && /Kross/.test(w));
  }
}

console.log('\n阶段与现实任务：');
{
  const st = load('stages');
  const stageIds = new Set(st.stages.map((s) => s.id));
  t('关卡 id 唯一且从 0 连续', st.stages.every((s, i) => s.id === i), st.stages.map((s) => s.id).join(','));
  // 现实任务已在 2.13 按用户要求删除，那两条断言随之删掉。
  // 新加一条：关卡用的 gate.type 必须是界面真的会判的类型——
  // 写错一个字母，那一关就永远过不去（或者永远自动过），而且不会报错。
  const GATE_TYPES = new Set(['answered', 'accuracy', 'biasDrop', 'errLow', 'genreAcc', 'streak']);
  const badGate = st.stages.filter((s) => !s.gate || !GATE_TYPES.has(s.gate.type))
    .map((s) => `${s.id}:${(s.gate || {}).type}`);
  t('每个关卡的判定类型都真的会被计算（写错就永远过不去）',
    badGate.length === 0, badGate.length ? badGate.join(', ') : `${st.stages.length} 关都对得上`);
  t('每个关卡都有能读懂的门槛文案',
    st.stages.every((s) => s.gateText && s.gateText.trim().length > 6),
    st.stages.map((s) => s.gate.type).join(' → '));
  t('天花板声明完整（measured / not_measured / on_identity 都在）',
    !!(st.boundary && st.boundary.measured.length && st.boundary.not_measured.length && st.boundary.on_identity));
  t('每日计划配置完整', !!(st.daily && st.daily.targets && st.daily.skipRule && st.daily.reminder));
}

console.log('\n语境校准与脑雾：');
{
  const cal = load('calibration');
  const phrases = cal.phrases || [];
  const bad = [];
  for (const p of phrases) {
    if (!Array.isArray(p.cases) || p.cases.length < 2) bad.push(`${p.id} case 少于 2 个`);
    for (const c of (p.cases || [])) {
      if (!['yes', 'revise', 'no'].includes(c.verdict)) bad.push(`${p.id} verdict 非法: ${c.verdict}`);
      if (!c.why || !c.why.trim()) bad.push(`${p.id} 缺 why`);
    }
  }
  t('校准题结构完整（verdict 合法 / 有 why）', bad.length === 0,
    bad.length ? bad.slice(0, 5).join('; ') : `${phrases.length} 组`);

  const rec = load('recovery');
  t('脑雾手段带 evidence 和 caution（不能只给方法不说边界）',
    (rec.modes || []).every((m) => m.evidence && m.caution), `${(rec.modes || []).length} 种`);
  // 结构是 { title, points: [...] }，不是数组——第一版按数组断言，误报了
  t('脑雾里保留了诚实说明（这个 App 改善不了脑雾）',
    !!(rec.honesty && rec.honesty.title && Array.isArray(rec.honesty.points)
       && rec.honesty.points.length >= 3),
    rec.honesty ? `${rec.honesty.points.length} 条` : '缺失');
}

console.log('\n语境校准（同句不同场）：');
{
  const cal = load('calibration');
  const ph = cal.phrases || [];
  const bad = [];
  for (const p of ph) {
    for (const k of ['id', 'domain', 'phrase', 'issue', 'principle']) {
      if (!p[k] || !String(p[k]).trim()) bad.push(`${p.id} 缺 ${k}`);
    }
    if ((p.cases || []).length < 2) bad.push(`${p.id} 只有 ${(p.cases || []).length} 个场合`);
    // 这条是这个模块唯一要教的东西：同一句话在不同场合判定必须不一样。
    // 只有一个判定的题，「校准」这个能力根本没被练到。
    if (new Set((p.cases || []).map((c) => c.verdict)).size < 2) {
      bad.push(`${p.id} 所有场合判定相同，没有区分度`);
    }
    for (const c of p.cases || []) {
      if (!(c.verdict in (cal.verdicts || {}))) bad.push(`${c.id} 判定非法：${c.verdict}`);
      if (!c.why || c.why.length < 25) bad.push(`${c.id} why 太短`);
      if (c.verdict === 'revise' && !c.revised) bad.push(`${c.id} 是 revise 却没给改法`);
    }
  }
  t('短语字段完整、每个场合判定合法', bad.length === 0,
    bad.length ? bad.slice(0, 5).join('; ')
      : `${ph.length} 条 / ${ph.reduce((n, p) => n + p.cases.length, 0)} 个场合`);
  const vc = {};
  for (const p of ph) for (const c of p.cases) vc[c.verdict] = (vc[c.verdict] || 0) + 1;
  t('三种判定都有足够样本（否则某个按钮很少点得到）',
    Object.keys(cal.verdicts || {}).every((k) => vc[k] >= 5), JSON.stringify(vc));
}

console.log('\n信号场（小游戏）：');
{
  const sg = load('signal');
  const it = sg.items || [];
  const bad = [];
  const kinds = {};
  for (const x of it) {
    kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    for (const k of ['id', 'kind', 'domain', 'context', 'cue', 'why']) {
      if (!x[k] || !String(x[k]).trim()) bad.push(`${x.id} 缺 ${k}`);
    }
    if (typeof x.exclusive !== 'boolean') bad.push(`${x.id} exclusive 不是布尔`);
    // 这两者必须一致，否则答案键就是错的：说「是真信号」的必须真的只对他。
    // 断了不会有任何报错，只会让他在游戏里学到反的东西。
    if ((x.kind === 'signal') !== !!x.exclusive) {
      bad.push(`${x.id} kind=${x.kind} 与 exclusive=${x.exclusive} 矛盾`);
    }
    if (x.why.length < 30) bad.push(`${x.id} why 太短，等于没给判据`);
    if (x.kind === 'thin' && !x.settle) bad.push(`${x.id} 信息不足却没写下一步看什么`);
  }
  t('题面字段完整，且 kind 与 exclusive 一致', bad.length === 0,
    bad.length ? bad.slice(0, 5).join('; ') : `${it.length} 条`);
  t('三类判据都有（真信号 / 她的基线 / 信息不足）',
    (kinds.signal || 0) >= 3 && (kinds.base || 0) >= 3 && (kinds.thin || 0) >= 3,
    JSON.stringify(kinds));
  // 每局固定抽 per_class_per_play 条真信号 + 同样多条噪声，
  // 池子不够抽就会出现「一局里某类不满」，d′ 就算不准。
  const per = sg.per_class_per_play || 10;
  const nYes = it.filter((x) => x.exclusive).length;
  t(`池子够抽满一局（每类至少 ${per} 条）`,
    nYes >= per && (it.length - nYes) >= per, `真信号 ${nYes} / 其余 ${it.length - nYes}`);
  t('每局轮数 = 两倍的每类条数', sg.rounds_per_play === per * 2,
    `${sg.rounds_per_play} vs ${per * 2}`);
  t('id 唯一', new Set(it.map((x) => x.id)).size === it.length);
}

console.log('\n语音场景：');
{
  const sc = load('scenarios').scenarios || [];
  const bad = [];
  for (const s of sc) {
    for (const k of ['title', 'her', 'her_state', 'opening', 'goal', 'trap']) {
      if (!s[k] || !String(s[k]).trim()) bad.push(`${s.id} 缺 ${k}`);
    }
    if (!Number.isInteger(s.difficulty)) bad.push(`${s.id} difficulty 不是整数`);
  }
  t('每个场景字段完整', bad.length === 0,
    bad.length ? bad.slice(0, 5).join('; ') : `${sc.length} 个场景`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
