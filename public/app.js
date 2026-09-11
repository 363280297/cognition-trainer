'use strict';

/* ============================================================ 状态 */

const LS_KEY = 'eq-state-v2';

/* 「这次启动之前本地有没有进度」必须在任何一次 save() 之前记下来。
 *
 * 踩过的坑：boot() 里 syncGate() 会调 save(false)，那一下就把 LS_KEY 写上了。
 * 如果到「要不要提示恢复备份」的时候才去读 localStorage，读到的永远是「有」，
 * 于是恢复提示永远不会出现——而且是静默不出现，没有任何报错。
 * 所以这里在模块初始化时就抓一个快照。
 */
const HAD_LOCAL_AT_START = (() => {
  try { return !!localStorage.getItem(LS_KEY); } catch (e) { return false; }
})();
const LS_REPLAY = 'eq-replay-v2';
const INTERVALS = [0, 1, 3, 7, 21, 45];           // 间隔重复的档位（天）
const DAILY_TARGET = 4;

const DEFAULT_STATE = {
  srs: {},            // cardId -> { box, due, seen, wrong }
  cal: {},            // caseId -> { seen, correct }
  lessons: {},        // lessonId -> { read, applyCorrect }
  skills: { notice: 5, interpret: 5, respond: 5 },
  streak: { count: 0, last: null },
  today: { date: null, count: 0 },
  stats: { answered: 0, correct: 0, wrongIds: [] },
  // 每个现成情景练过几次。只用来做「今天就练这个」的轮换——
  // 少了它，那个推荐会一直推同一个，用户点两次就再也不想看推荐了。
  scenes: {},
  fog: [],            // 脑雾记录：[{ ts, trigger, mode, feeling }]
  // 偏差画像：只统计选错时那个选项的误读类型。
  // 准确率和偏差是两个独立维度（West & Kenny 2011 的 truth and bias model）——
  // 一个人可以准确率不低却一直往同一个方向歪，那比总分有用得多。
  bias: {},           // 误读类型 -> 次数
  plans: [],          // 用户自己写的 if-then 预案：[{ id, cardId, if, then, ts, rehearsed }]
  // 逐次作答的滚动记录，用来做「最初 vs 最近」的纵向比对。
  // 只留最近的 300 次——阶段评估要的是趋势，不是完整档案。
  answers: [],        // [{ t, id, err, ok }]
  /* 这里原来有一行 `usedAssignments: []`（「领过的任务 id，避免连着推同一个」）。
     它是「现实任务」那套东西的遗留——那个功能按用户要求删掉之后，
     这个键就只剩写入、没有任何地方读它了。自检脚本（tools/audit_project.js）
     就是专门抓这一类的，抓到就删。旧存档里还会留着这个键，无害。 */
  // 信号场的成绩。plays 留着看趋势（分辨力有没有在涨），best 按分辨力算——
  // 偏向没有「越高越好」，只有偏多偏少，所以不进 best。
  signal: { plays: [], best: null },
  // 闲聊「球在谁手里」的成绩。plays 留着看接住率的趋势；byMove 是出手习惯的
  // 累计分布——它比接住率有用：接住率只说明掉了几个球，byMove 说明**怎么掉的**。
  chat: { plays: [], byMove: {} },
  // 看过「天花板声明」没有。**这个键原来也是只写不读的**：
  // 界面上写着「建议现在就看一遍，不要等通关」，而 App 其实不知道你看没看。
  // 自检抓出来之后接上了——现在它会决定那句话是「建议看一遍」还是「看过了，随时再看」。
  boundarySeen: false,
  identities: [],     // 身份陈述：[{ id, text, ts, stage }]
  // 每日计划。规则是 Never Miss Twice：跳过允许一次，第二次必须有代价。
  // 依据：错过一次对习惯养成没有实质影响，但累积的错过会显著降低最终达到的
  // 自动化水平（Lally 等 2010）；真正杀死习惯的是「反正已经破了」的连锁反应
  // （what-the-hell effect，Marlatt & Gordon 的复发预防研究）。
  daily: { date: null, cards: 0, lessons: 0, extra: 0, tried: 0, skipped: false, met: false, fogPass: false, metAt: null },
  dailyLog: [],       // [{ date, cards, lessons, extra, met, skipped, fogPass }]
  // 护城河设置：达标之前不许打开的目标应用（由 JS 计算是否武装，原生只负责执行）
  // rootKnown / rootOk 是三态而不是布尔：null 表示「还没探测过」。
  // 压成 false 会把「未知」显示成「root 不可用」，那是误报。
  gate: { armed: false, packages: [], enabled: false,
          deepBlock: false, rootKnown: false, rootOk: false,
          // 防掉线：want 是「用户想不想开着」，running 是「心跳文件真的在跳吗」。
          // 两个都要留着——这个项目栽过好几次「把意图当事实」（达标那次的
          // 无条件加一、备份那次的只记写过），所以这里从数据结构上就分开。
          watch: { want: false, running: false, ago: -1 } },
  // at = 最近一次写备份的时间，ok/where = 那次写的结果。
  // 它只是「上次写的结果」，不是「备份现在好不好」——后者每次都要问原生读一遍。
  backup: { at: 0, ok: false, where: '' },
  reminder: { hour: 20, minute: 0, enabled: true },
  /* 对话历史：每练完一局存一条（逐轮记录 + 那一局的分析和建议）。
     放在 state 里是有意的——localStorage 和备份 JSON 都是同一个 state，
     所以它跟着备份走，卸载重装能捞回来。只留最近 40 局（见 voice.js 的 TALK_KEEP）。 */
  talks: [],
  /* AI 造的场景库：造过的都留着，能回头练同一个场景。
     为什么攒起来（用户拍板的）：学习研究里「同一个题目隔几天换个情境再练」比
     「每次全新」记得牢；而且以前造完只放内存，退出就没了，等于每次现出卷子、
     考完把卷子烧了。跟 talks 一样放在 state 里，所以跟着备份 JSON 走，不进 APK。
     上限和淘汰策略见 voice.js 的 GEN_KEEP / addGenScenes。 */
  genScenes: [],
};

let state = load();
let CONTENT = { cards: { cards: [] }, calibration: { phrases: [] }, curriculum: { lessons: [] }, recovery: { modes: [] }, scenarios: { scenarios: [] }, stages: { stages: [] } };
let aiReady = false;
let session = { queue: [], i: 0, lowLoad: false, genrePick: null, cluePick: null };
let replay = { chat: '', background: '', questions: [], answers: [], reveal: null };
let currentTab = 'cards';
let cardTimer = null;
let wrongStreak = 0;
let cardDomain = '全部';
let lessonSeries = '全部';
const DOMAINS = ['全部', '恋爱', '职场', '朋友', '家人', '泛社交'];

/* ---------------------------------------------------------- 偏差画像
   准确率告诉你「对了多少」，偏差告诉你「往哪边歪」。这两个是独立的东西：
   一个人可以命中率还行，但每次错都错在同一个方向——那才是真正要改的地方，
   而且它比一个总分更能指导行动。类型名和数据里的 err 字段一一对应。 */
const BIAS_TYPES = {
  '事务化': {
    label: '事务化',
    short: '把感受听成待办',
    desc: '她在说她的感受，你听成了一个需要解决的问题。这是最容易被忽略的一类，因为你的回应看起来还挺积极——你确实在帮她想办法。',
    fix: '回应感受和解决问题是两件事，先做第一件。她说完先停两秒，问一句「你是想让我听，还是想一起想办法」，比直接给建议有用。',
  },
  '过度解读': {
    label: '过度解读',
    short: '把友善读成好感',
    desc: '对方只是正常待人，你读出了特殊意味。研究里这个方向的偏差在小到中等量级（平均 r≈.32），但代价不对称：误判一次可能让你做出越界举动，把本来能正常发展的关系搞僵。',
    fix: '把「她对我有意思」降级成假设，然后用一个低成本的动作去验证，而不是直接按结论行动。',
  },
  '消极解读': {
    label: '消极解读',
    short: '往最坏处想',
    desc: '中性或含糊的话，你读成了敌意、挑剔、拒绝、操控。这类误读会让你提前防卫，而防卫本身会真的把对方推开——你担心的事就发生了。',
    fix: '先分清「她说的是事实」还是「你补上去的动机」。动机那一层通常没证据，先放下。',
  },
  '投射': {
    label: '投射',
    short: '把期待当成她的意思',
    desc: '你想听什么，就听到了什么。这比过度解读更隐蔽，因为它常常包装成「我感觉她其实是……」。',
    fix: '检查一下：这个结论里有多少是她说的，有多少是你希望她说的。分不出来的部分，问出来。',
  },
  '字面化': {
    label: '字面化',
    short: '只处理字面',
    desc: '她说的是 A，意思是 B，你只回应了 A。间接表达在日常里是常态，不是例外。',
    fix: '听到请求之前，先想一下「她为什么要在这个时刻跟我说这句话」。动机比字面更能说明要做什么。',
  },
  '乐观化': {
    label: '乐观化',
    short: '把不满当没事',
    desc: '「没关系」「我自己可以」「你去忙吧」——你把带情绪的话当成了真的没事。这类误读短期内最省事，代价是攒到最后一次性爆发。',
    fix: '语气、停顿、和平时不一样，就是需要确认的信号。直接问一句，比猜安全。',
  },
  '过度让步': {
    label: '过度让步',
    short: '该说的时候咽了',
    desc: '让步本身是有记录的关系维护手段——对方做出可能具有破坏性的行为时，忍住破坏性回应、改用建设性回应，和更高的满意度、承诺度是正相关的（Rusbult 等 1991，六个研究）。但它的收益建立在**它是例外**这个前提上。当同一个让步重复到第 N 次，性质就变了：它从维护关系变成把一次妥协固化成长期条件，而且往往是从「接近型」（我想让关系更好）滑向「回避型」（我不想冲突），后者和满意度的长期下降相关（Impett 等 2010）。',
    fix: '让之前先问一句：这是第一次，还是第 N 次？第一次让，第 N 次要让「次数」被看见——不是翻脸，是让这件事可见。',
  },
  '含蓄化': {
    label: '含蓄化',
    short: '憋着，等她看出来',
    desc: '你把需求留在心里，期待对方自己发现——而且你多半真心觉得它已经挺明显了。这里有个被反复验证的偏差：人系统性高估自己内心状态被别人看穿的程度（透明度错觉，Gilovich、Savitsky & Medvec 1998）。最直观的一个数字：让人敲一首歌的节奏，敲的人预测约 50% 的听众能猜出歌名，**实际只有 3%**。你脑子里那件事是完整的，她那边只有一个节奏。',
    fix: '把「她应该能看出来」换成一句明确的话。不需要说得漂亮，需要说得具体：是什么事、你想要什么、什么时候。另外注意一种伪装——用玩笑把它盖过去，那等于没说（见课程「幽默的两个方向」）。',
  },
  '过度计较': {
    label: '过度计较',
    short: '把小事升成原则问题',
    desc: '偶发的、无心的、没有实际损失的事，你把它当成原则问题来处理。这类误读的代价是你在别人那里变成「跟他相处要小心」——而那个成本是慢慢累积的，等你发现的时候，别人已经开始对你有所保留了。',
    fix: '升级之前先过三条：这是第一次还是模式？我有没有实际损失？对方的诉求是关系性的还是控制性的？三条都指向「偶发 + 无损失」时，痛快让过去，别扭捏——让的时候带情绪，比不让更伤。',
  },

  /* ---- 下面两个是「输出侧」的：不是读错了别人，是自己说出去就把话题说死了 ----
   * 题库原来 62 张全是「她这句话什么意思」（输入侧）。这两个补的是另一半。
   * 放在同一张表里，是为了让偏差画像能同时显示「你读偏的方向」和
   * 「你说死话的方式」——它们是同一个人的两种表现。 */
  '评论代替接话': {
    label: '评论代替接话',
    short: '评局面，不接话头',
    desc: '别人在讲一件具体的事，你回的是对这件事、或对在场的人的**评价**。评价听起来是在参与，其实是从参与者退到了评论席：它不要求你懂那件事，但也因此没给任何人接的话头。群聊里最容易出现，因为一群人说话时，评论比接话省力。',
    fix: '先接那件事本身（问一个具体的、关于这件事的问题），再说别的。判断标准很简单：你这句话发出去，别人**能接什么**？接不上就是评论。',
  },
  '替人定位置': {
    label: '替人定位置',
    short: '当众给人排名',
    desc: '你替在场的人分配了名次或身份（谁高谁低、谁是新人、谁该叫什么）。这种话有个特征：它不给人「顺着说」的选项，只能「接受」或者「反驳」——接受等于承认自己低，反驳等于不给你面子。所以最省事的选择是沉默，或者回一个尴尬的表情。',
    fix: '给**角色**，不给**名次**。「明天一起练，我带你」是角色，谁都能接；「你练得比他好就能叫他师弟」是名次，接了就等于承认现在不如人。',
  },

  /* ---- 下面两个属于「读局」：不判断是哪种对话、不看话题还剩多少气，就开始回应 ---- */
  '误判场合': {
    label: '误判场合',
    short: '答了一个没被问的问题',
    desc: '你没先判断这是哪种对话就直接回应了。报喜被当成求建议、客套被当成邀约、闲聊被当成正事、自谦被当成请你点评——每一次，你给的答案单看都没错，只是回答了一个对方没问的问题。这是「牛头不对马嘴」最标准的来源：问题不在话说得好不好，在场合认错了。',
    fix: '开口之前先给它归个类：他在**给**还是在**要**？他有没有给出下一步？这句话换个人说还成立吗？归完类再决定说什么——报喜要接住，倒苦水要接情绪，求建议才给建议，这三种的正确答案互相之间是错的。',
  },
  '该停不停': {
    label: '该停不停',
    short: '话题用完了还在加码',
    desc: '对方已经在收尾、或者回应已经缩到最短，你还在往上加。它的代价不显眼：你越使劲，对方越需要用礼貌来挡，两个人都累，而关系是被这种「不得不应付」一点点磨掉的。话题本来就有寿命，多数只有三四个来回，用完不是谁的错。',
    fix: '看到「回复变短、只回表情、不再给新信息、间隔拉长、不再反问你」里出现两条，就换挡或者收手。收手不会掉东西，硬撑才会——真有心的人会回来找你。',
  },
};

function recordBias(err) {
  if (!err || err === '正解' || !BIAS_TYPES[err]) return;
  state.bias[err] = (state.bias[err] || 0) + 1;
}

function biasTotal() {
  return Object.values(state.bias).reduce((a, b) => a + b, 0);
}

function biasRanked() {
  return Object.entries(state.bias)
    .filter(([k, v]) => BIAS_TYPES[k] && v > 0)
    .sort((a, b) => b[1] - a[1]);
}

/* ======================================================== 阶段评估
 *
 * 设计上有一条硬约束：每一关的通过条件必须落在**可验证的行为**上，
 * 不能靠刷题量堆过去。理由写在这里，因为改关卡的时候容易忘：
 * 一个声称能测量「情商水平」的进度条会制造虚假自信，而虚假自信正是
 * 这个 App 要治的毛病本身（把友善读成好感就是过度自信的一种）。
 *
 * 所以：
 *   - 关卡只声明「你能做什么」，不声称「你是什么人」
 *   - 判定用的是准确率、误读类型的变化方向、判局准确率
 *   - 纵向比对（最初 vs 最近）是这里唯一真正的进步指标——
 *     命中率受题目难度影响，偏向不受；偏向才是你自己的。
 *   - 最后一关没有通过条件，也不会有：上面每一条描述的都是倾向，不是永久状态
 *
 * 判定逻辑写成纯函数（evalGate / biasSplit 都只读一个 snap 对象），
 * 因为判错了会给用户错误的进度，所以要能单独测。见 tools/test_stages.js。
 */

function errCounts(list) {
  const c = {};
  (list || []).forEach((x) => {
    if (x && x.err && x.err !== '正解') c[x.err] = (c[x.err] || 0) + 1;
  });
  return c;
}

function countErrIn(list, type) {
  return (list || []).filter((x) => x && x.err === type).length;
}

/** 把作答记录切成「最初三分之一」和「最近三分之一」，看主要偏向的占比变化。 */
function biasSplit(answers, biasTotal) {
  const mistakes = (answers || []).filter((x) => x && x.err && x.err !== '正解');
  if (mistakes.length < 6) return null;
  const k = Math.max(3, Math.floor(mistakes.length / 3));
  const early = mistakes.slice(0, k);
  const late = mistakes.slice(-k);
  const earlyCounts = errCounts(early);
  const lateCounts = errCounts(late);
  // 主要偏向取全部记录的累积第一名，而不是各段自己的第一名。
  // 取各段第一名会不稳：类型的排序一变，比较的就不是同一个东西了。
  const top = Object.entries(biasTotal || {})
    .filter(([t, v]) => BIAS_TYPES[t] && v > 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [topType] = top;
  const earlyShare = (earlyCounts[topType] || 0) / k;
  const lateShare = (lateCounts[topType] || 0) / k;
  const drop = earlyShare > 0 ? (earlyShare - lateShare) / earlyShare : 0;
  return { n: mistakes.length, k, topType, earlyShare, lateShare, drop, earlyCounts, lateCounts };
}

/** 把一个阶段的 gate 判成一组「子条件」，而不是一个假百分比——
 *  复合条件压成一个数字会掩盖到底是哪一条没过。 */
function evalGate(gate, snap) {
  const parts = [];
  const acc = snap.answered ? snap.correct / snap.answered : 0;

  if (gate.type === 'answered') {
    parts.push({ label: `完成 ${gate.n} 题`, ok: snap.answered >= gate.n, have: snap.answered, need: gate.n });

  } else if (gate.type === 'accuracy') {
    parts.push({ label: `做满 ${gate.n} 题`, ok: snap.answered >= gate.n, have: snap.answered, need: gate.n });
    parts.push({ label: `准确率 ≥ ${Math.round(gate.min * 100)}%`, ok: acc >= gate.min,
      text: `${Math.round(acc * 100)}%` });
    for (const [type, max] of Object.entries(gate.maxErr || {})) {
      const c = countErrIn(snap.answers, type);
      parts.push({ label: `「${type}」误读 ≤ ${max} 次`, ok: c <= max, text: `${c} 次` });
    }

  } else if (gate.type === 'biasDrop') {
    parts.push({ label: `误读样本累积到 ${gate.n} 次`, ok: snap.biasTotal >= gate.n,
      have: snap.biasTotal, need: gate.n });
    const sp = snap.biasSplit;
    if (!sp) {
      parts.push({ label: '还看不出偏向的变化', ok: false, text: '样本不够' });
    } else {
      parts.push({
        label: `「${sp.topType}」的占比下降 ≥ ${Math.round(gate.ratio * 100)}%`,
        ok: sp.drop >= gate.ratio,
        text: `${Math.round(sp.earlyShare * 100)}% → ${Math.round(sp.lateShare * 100)}%`,
      });
    }

  } else if (gate.type === 'errLow') {
    const recent = (snap.answers || []).slice(-gate.n);
    const c = countErrIn(recent, gate.err);
    parts.push({ label: `最近 ${gate.n} 题里「${gate.err}」≤ ${gate.max} 次`,
      ok: recent.length >= gate.n && c <= gate.max, text: `${c} 次（已作答 ${recent.length} 题）` });

  } else if (gate.type === 'genreAcc') {
    /* 判局准确率。原来这一关用的是「现实任务的执行率」，
     * 现实任务按用户要求删掉之后，这里换成一个**在 App 内也测得到、而且是真的技能**的判据：
     * 读局卡那一步（这是什么局）答得对不对。
     * 它比「做多少题」有意义：做得多不等于判得准，而这是后面所有动作的前提。 */
    const g = (snap.answers || []).filter((a) => String(a.id).endsWith('#genre'));
    const right = g.filter((a) => a.ok).length;
    const pct = g.length ? Math.round((right / g.length) * 100) : 0;
    parts.push({ label: `判局答满 ${gate.n} 次`, ok: g.length >= gate.n,
      have: g.length, need: gate.n });
    parts.push({ label: `判局准确率 ≥ ${gate.pct}%`,
      ok: g.length >= gate.n && pct >= gate.pct,
      text: g.length ? `${pct}%（对 ${right} / 共 ${g.length}）` : '还没有判局记录' });

  } else if (gate.type === 'streak') {
    const days = snap.streakDays || 0;
    parts.push({ label: `连续 ${gate.n} 天有记录`, ok: days >= gate.n, have: days, need: gate.n });
  }

  return { ok: parts.length > 0 && parts.every((p) => p.ok), parts };
}

/** 当前快照。stageProgress 和视图都从这里取数，避免两处各算一遍。 */
function stageSnapshot() {
  return {
    answered: state.stats.answered,
    correct: state.stats.correct,
    answers: state.answers,
    biasTotal: biasTotal(),
    biasSplit: biasSplit(state.answers, state.bias),
    plans: state.plans,
    streakDays: state.streak.count || 0,
  };
}

function stageDefs() {
  return (CONTENT.stages && CONTENT.stages.stages) || [];
}

/** 当前到达的阶段：第一个没过 gate 的阶段的**前一个**已通过的阶段。
 *  也就是说 level 表示「已通过的最后一关」，0 表示还在摸底。 */
function currentStage() {
  const defs = stageDefs();
  if (!defs.length) return { def: null, idx: 0, gate: null };
  const snap = stageSnapshot();
  let passed = -1;
  for (const s of defs) {
    if (s.gate.type === 'streak') continue;   // 保持那一关不参与「是否通过」的推进
    const g = evalGate(s.gate, snap);
    if (g.ok) passed = s.id;
    else break;
  }
  const idx = Math.min(passed + 1, defs.length - 1);
  const def = defs[idx];
  return { def, idx, gate: def ? evalGate(def.gate, snap) : null, snap, passed };
}

/* ---------------------------------------------------- 执行意图的表述检查
   「如果…我就…」为什么有用，取决于「我就」写的是**去做什么**。
   研究发现否定框架的计划有逆火风险——写着「不要辩解」的人，一紧张反而更容易辩解，
   因为否定一个念头先要把它想起来。所以这里拦下来并要求改成正面动作。 */
const PROHIBIT = ['不要', '别', '不能', '避免', '禁止', '不许', '不该', '少', '忍住'];

// 「台词」不一定带引号。「我就说…」「回一句…」同样是在写你要念的话，
// 而不是你要做的事——这种句子场合一变就废，也记不住。
const SCRIPTY = /就说|说一[句声]|说句|回一[句声]|回句|答一[句声]|讲一[句声]|道一[句声]|说[：:]|跟(他|她|对方|人家)说|对(他|她|对方)说/;

function planProblem(then) {
  const t = (then || '').trim();
  if (!t) return '还没写「我就……」那部分';
  if (PROHIBIT.some((w) => t.startsWith(w)))
    return '这是「别做什么」。禁止式的计划会适得其反——紧张时你反而更容易做出那件事。改成你**会做**什么。';
  if (/[「」“”"'’]/.test(t) || SCRIPTY.test(t))
    return '这是台词。背句子没用——场合一变就废了。删掉引号，写成你**会做**的动作。';
  if (t.length > 60) return '太长了，真到那个时候你想不起来。压到 60 字以内。';
  if (/(保持耐心|注意沟通|好好回应|多关心|用心|真诚)/.test(t))
    return '这句没有动作。说明白你具体做什么、先做什么。';
  return null;
}

/* ============================================================ 工具 */

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (raw) return Object.assign(structuredClone(DEFAULT_STATE), raw);
  } catch (e) { /* 忽略损坏的本地数据 */ }
  return structuredClone(DEFAULT_STATE);
}

let saveTimer = null;
function save(sync = true) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  if (!sync) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }, 800);
  scheduleBackup();
}

/* ---------------------------------------------------------------- 备份
 *
 * 卸载是闸门唯一的出口。原来那个出口的代价是「全部归零」，
 * 用户把这条放宽了：文本数据可以留在磁盘上。所以这里把 state 写成
 * 「下载/认知训练/认知训练-进度备份.json」——卸载不动外部存储，
 * 重装之后还能捞回来。
 *
 * 为什么是节流的自动写，而不是一个「导出」按钮：
 * 手动导出这件事，人一定会忘，而忘了的代价是丢掉几个月的记录。
 * 但自动写就必须可见——所以设置页上一直显示它是什么时候写的、
 * 写在哪、有多少字节，读不回来也如实显示。
 *
 * 只写纯文本 .json。用户对这件事的另一半要求是「所有进程、代码、脚本
 * 都删掉，只留文本数据」——所以这里除了字符串什么都不会落盘。
 */
let backupTimer = null;
let backupLast = 0;
const BACKUP_MIN_GAP = 90 * 1000;   // 两次写之间至少隔 90 秒

function backupAvailable() {
  return !!(window.EQNative && EQNative.backupNow);
}

function scheduleBackup() {
  if (!backupAvailable()) return;
  if (backupTimer) return;                       // 已经排着了
  const wait = Math.max(0, BACKUP_MIN_GAP - (Date.now() - backupLast));
  backupTimer = setTimeout(() => {
    backupTimer = null;
    doBackup(true);
  }, wait);
}

/** silent=true 表示这是自动写的，成功不要弹 toast（不然每 90 秒打扰一次） */
function doBackup(silent) {
  if (!backupAvailable()) return false;
  backupLast = Date.now();
  let where = '';
  try {
    where = EQNative.backupNow(JSON.stringify(state)) || '';
  } catch (e) {
    where = '';
  }
  state.backup = state.backup || {};
  state.backup.at = Date.now();
  state.backup.ok = !!where;
  state.backup.where = where;
  localStorage.setItem(LS_KEY, JSON.stringify(state));   // 直接落本地，别再触发一次 save
  if (silent) return !!where;
  toast(where
    ? `备份好了：${where}`
    : '备份没写成——设置页里有原因');
  return !!where;
}

/** 从备份恢复。绝不静默合并：覆盖是破坏性的，必须用户自己点。 */
function restoreBackup() {
  if (!backupAvailable()) return;
  let raw = '';
  try { raw = EQNative.backupRead() || ''; } catch (e) { raw = ''; }
  if (!raw) {
    toast('没读到备份文件');
    return;
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) {
    toast('备份文件读不出来（不是合法 JSON），没有动你现在的数据');
    return;
  }
  if (!j || typeof j !== 'object') {
    toast('备份文件内容是空的，没有动你现在的数据');
    return;
  }
  const cards = Object.keys(j.srs || {}).length;
  const ans = (j.answers || []).length;
  if (!confirm(`用备份覆盖当前进度？\n\n备份里：${cards} 张卡片记录 · ${ans} 条作答\n当前：${Object.keys(state.srs || {}).length} 张 · ${(state.answers || []).length} 条\n\n当前进度会被完全替换掉，不能撤销。`)) return;
  // 把 DEFAULT_STATE 补齐，避免旧备份缺字段导致后面到处 undefined
  state = Object.assign(structuredClone(DEFAULT_STATE), j);
  save();
  closeSheet();
  renderHeader();
  go(currentTab || 'today');
  syncGate();
  toast('已从备份恢复');
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 内容里的 **重点** 要真的变成粗体。
 *
 * 这个 App 的内容（卡片诊断、偏差类型说明、微课正文）里写了 100 多处 **强调**，
 * 但一直没有渲染器——所有地方都在显示字面的星号。这是纯观感问题，
 * 不是功能问题，所以藏了很久；但它出现在几乎每一张卡的解释里，很显眼。
 *
 * 顺序是**先转义、再替换**，所以不可能引入 XSS：`**` 里包的内容
 * 在替换之前已经被 esc() 中和过了。
 * 只用在正文类字段上，不用在 input 的 value/placeholder 里——
 * 属性值里出现 <b> 反而会显示成字面标签。 */
const rich = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function toast(msg, ms = 1900) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}

function bump(skill, n) {
  if (!n) return;
  state.skills[skill] = Math.max(0, Math.min(100, state.skills[skill] + n));
  renderHeader();   // 立即反映，否则进度条会滞后一次答题
}

/** 任意一次答题都算今天的活动：维护连续打卡 */
function markActivity() {
  const t = todayStr();
  if (state.today.date !== t) {
    state.today = { date: t, count: 0 };
  }
  state.today.count++;
  const y = new Date(Date.now() - 864e5);
  const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (state.streak.last !== t) {
    state.streak.count = state.streak.last === yStr ? state.streak.count + 1 : 1;
    state.streak.last = t;
  }
  renderHeader();
}

function renderHeader() {
  const dp = dailyProgress();
  $('#streakChip').textContent = `🔥 ${state.streak.count}`;
  // 今日那格显示的是「达标进度」而不是练习次数——达标线是每日计划的核心，
  // 练习次数只是个中间量，练了 20 张但没做完微课一样不算达标。
  $('#todayChip').textContent = dp.met ? '✓ 今日达标' : `今日 ${dp.done}/${dp.need}`;
  $('#todayChip').classList.toggle('met', dp.met);
  const names = { notice: '察觉', interpret: '解读', respond: '回应' };
  $('#meters').innerHTML = Object.entries(state.skills).map(([k, v]) => `
    <div class="meter">
      <span><i>${names[k]}</i><i>${v}</i></span>
      <div class="bar"><i style="width:${v}%"></i></div>
    </div>`).join('');
}

/* ============================================================ 间隔重复 */

function srsOf(id) {
  if (!state.srs[id]) state.srs[id] = { box: 0, due: 0, seen: 0, wrong: 0 };
  return state.srs[id];
}

function rate(id, correct) {
  const s = srsOf(id);
  s.seen++;
  if (correct) {
    s.box = Math.min(INTERVALS.length - 1, s.box + 1);
    state.stats.wrongIds = state.stats.wrongIds.filter((x) => x !== id);
  } else {
    s.box = 1;
    s.wrong++;
    if (!state.stats.wrongIds.includes(id)) state.stats.wrongIds.push(id);
  }
  s.due = Date.now() + INTERVALS[s.box] * 864e5;
  state.stats.answered++;
  if (correct) state.stats.correct++;
  markActivity();
  save();
}

/* 表面变体：同一张卡每次可能出现不一样的场景和措辞，但考点、选项、解释完全一样。
   为什么值得这么做：变化的是检索线索，不变的是原理。每次看到略微不同的场景，
   你要做的是同一类判断——这比反复看同一句话更难靠记忆过关，也更接近现实，
   因为现实里没有两次一模一样的情景。
   注意 id 不变，所以间隔重复的进度、偏差画像的统计都还是同一张卡。 */
function applyVariant(card) {
  const vs = card.variants;
  if (!vs || !vs.length) return card;
  const v = vs[Math.floor(Math.random() * vs.length)];
  return Object.assign({}, card, { context: v.context || card.context, quote: v.quote || card.quote });
}

/* ------------------------------------------------------ 偏重出题（自适应）
 *
 * 用户要的：「根据每日的答题情况来优化后面的题库」「每日再去调整下一次的
 * 出题方向，有偏重」。
 *
 * 做法是加权随机，而不是硬筛。为什么不直接只出他常错的那类：
 *   1. 只练弱项会让他把弱项和「被罚」绑在一起，而间隔重复本来就要混合复习；
 *   2. 偏差画像的样本本来就少，全押在一类上，其他类会永远没数据，
 *      画像就再也调不动了——反馈回路需要一个探针。
 * 所以是**偏向**而不是**限定**：弱项权重高，但不是只出它。
 *
 * 样本太小时不动手：偏差画像本身在 6 次以下就显示「样本太小」，
 * 出题也不该拿两三次作答就去改方向——那是在放大噪声。
 */
function biasFocus() {
  const total = biasTotal();
  if (total < 6) return [];
  const pairs = Object.entries(state.bias).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!pairs.length) return [];
  const top = pairs[0][1];
  // 取「最高的一档」而不是「所有出现过的」——否则练着练着等于全都加权，等于没加权
  return pairs.filter(([, n]) => n >= Math.max(2, top * 0.5)).map(([k]) => k);
}

/** 这张卡值多少权重：错过的最重，命中当前弱项类别的次之 */
function cardWeight(card, focus) {
  let w = 1;
  if (state.stats.wrongIds.includes(card.id)) w += 1.5;
  const errs = card.options.map((o) => o.err);
  if (focus.some((f) => errs.includes(f))) w += 1;
  // 判局步骤也是弱项的话，带判局的读局卡加权——那正是练那一步的地方
  if (focus.includes('误判场合') && card.genre) w += 1;
  return w;
}

/** 加权随机取 n 个。权重只影响概率，不改变「能不能被选到」。 */
function weightedPick(arr, n, focus) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) {
    const ws = pool.map((c) => cardWeight(c, focus));
    const total = ws.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= ws[i];
      if (r <= 0) { idx = i; break; }
    }
    out.push(pool[idx]);
    pool.splice(idx, 1);   // 同一组里不重复出同一张卡
  }
  return out;
}

function buildQueue(mode) {
  const now = Date.now();
  const all = CONTENT.cards.cards.filter((c) => cardDomain === '全部' || c.domain === cardDomain);
  if (mode === 'wrong') {
    return state.stats.wrongIds
      .map((id) => all.find((c) => c.id === id)).filter(Boolean)
      .map(applyVariant);
  }
  const due = all.filter((c) => state.srs[c.id] && state.srs[c.id].due <= now);
  const fresh = all.filter((c) => !state.srs[c.id]);
  const focus = biasFocus();
  // 变体在这里落地：整个一组刷完之前不会中途换场景，
  // 否则答完题看解释时场景变了，会很混乱。
  return [...weightedPick(due, 6, focus),
    ...weightedPick(fresh, Math.max(0, 6 - due.length), focus),
    ...due.slice(6)]
    .map(applyVariant);
}

/** 卡片页顶部那行：把「为什么最近偏重这类」说出来，别让它变成黑箱 */
function focusBar() {
  const focus = biasFocus();
  if (!focus.length) return '';
  const named = focus.filter((f) => BIAS_TYPES[f]).map((f) => BIAS_TYPES[f].label);
  if (!named.length) return '';
  const n = biasTotal();
  return `<div class="focus-bar">
    <b>偏重出题</b>：最近 ${n} 次里你在「${esc(named.join('、'))}」上最多，
    所以这几类相关的卡出现得更勤。不是只出这些——只练弱项会把它和惩罚绑在一起，
    而且其他类型会永远没数据，画像就调不动了。
  </div>`;
}

/** 领域筛选条：只在有筛选价值时出现 */
function domainBar() {
  const counts = {};
  CONTENT.cards.cards.forEach((c) => { counts[c.domain] = (counts[c.domain] || 0) + 1; });
  const avail = DOMAINS.filter((d) => d === '全部' || counts[d]);
  if (avail.length <= 2) return '';
  return `<div class="chips">${avail.map((d) => `
    <button class="chip-btn ${d === cardDomain ? 'on' : ''}" onclick="setDomain('${d}')">
      ${d}${d === '全部' ? '' : ` <em>${counts[d]}</em>`}
    </button>`).join('')}</div>`;
}

function setDomain(d) {
  cardDomain = d;
  session = { queue: buildQueue(), i: 0, lowLoad: false, genrePick: null, cluePick: null };
  renderCard();
}

/* ============================================================ 视图：卡片 */

const TYPE_NAME = {
  literal: '纯字面', face: '面子保护', bid: '连接发起',
  reassure: '确认需求', boundary: '边界试探', info: '信息缺口',
  talk: '怎么接话',   // 输出侧：别人说完之后，你这句该怎么发
  read: '读局',       // 读局：先判断这是哪种对话、还剩多少气，再决定下一步
};

let cardsView = 'drill';     // drill | plans | bias（后两个只由「成长」那一路设置）
let growthSubview = 'stages';  // stages | bias | plans

/* ------------------------------------------------------------ 读局：先分类
 *
 * 用户说的是：「要训练我说话之前思考，我现在经常说话不动脑子，这个是硬伤。」
 *
 * 一个必须说清楚的证据约束：**光是「停一下」是没用的。**
 * Wilkinson（1975, J Abnorm Child Psychol）把冲动的孩子分三组——纯延迟训练、
 * 语言自我指导训练、对照组。结果两组的反应延迟都变长了，但**只有**
 * 语言自我指导那一组错误减少了。也就是说：停顿本身不改善判断，
 * 停顿里**装着的那一步**才改善判断。
 *
 * 所以这里不做「等三秒」那种摩擦，而是把那一步变成必须走的一步：
 * 读局卡在给出四个动作选项**之前**，先要求你判断「这是什么局」。
 * 选项本身不透露这一步，跳过它后面四个选项就会变得含糊——这正是
 * 现实里发生的事（他说「回答的牛头不对马嘴」，就是跳过了分类）。
 *
 * 判错了会记进偏差画像的「误判场合」，跟选错动作分开记：
 * 这是两个不同的能力，混在一起就看不出来他到底缺哪个。
 */
/* 这八个是界面上真的能点到的选项，必须跟卡片里的 genre 字段逐字一致。
 * 对不上的后果不是说错话，是**那张卡永远判不对**：按钮照常渲染，用户点哪个
 * 都算错，偏差画像还会一直记「误判场合」。所以 tools/test_content.js 里有一条
 * 断言专门比对这两份清单——这次就是它抓到的（卡片写的是「分享 / 报喜」，
 * 而这里写的是「报喜」，11 张卡当场变成永远判错）。 */
const GENRES = ['分享 / 报喜', '倒苦水', '求建议', '邀约 / 加入', '要确认',
  '客套收尾', '自谦', '纯闲聊'];

/* 卡片区不再自带一层「刷卡片 / 我的预案 / 偏差画像」。
 *
 * 原来那一层让它成了三层菜单，而**「我的预案」和「偏差画像」根本不是练习**——
 * 它们是看进度的。所以搬到「成长」下面，卡片这一路就只剩一层。
 * 用户的原话是「很多窗口可以归为一类」「不要把它摊开」。
 *
 * 这两个视图仍然可以在这里被调用（renderPlans/renderBias），
 * 只是入口归到成长那边；而 goCards() 之类的调用一律落到 drill。 */
/** 「成长」那一路的三个视图共用 cardsNav 的替代品：由 SUBNAV 负责切换 */
function cardsNav() {
  return '';
}

/* ---------------------------------------------------- 我的预案（复看）
   复看不是装饰。Sheeran、Listrom & Gollwitzer（2024）在 642 个检验里发现，
   计划至少预演过一次的人，效果明显大于没预演的。所以这里做的唯一一件事，
   就是让你把写过的东西再看一遍，并记下看过几次。 */
function renderPlans() {
  const plans = [...state.plans].sort((a, b) => b.ts - a.ts);
  $('#view').innerHTML = `
    ${cardsNav()}
    ${plans.length ? '' : `<div class="card">
      <h2>还没有预案</h2>
      <p class="hint" style="margin-top:8px">
        刷卡片时，每道题答完下面都有一个「写一句你自己的预案」。
        写过的东西自己看一眼，比再刷十道题有用——前提是你得写下来。
      </p>
      <div class="row"><button class="primary" onclick="setPracticeSubview('cards')">去刷卡片</button></div>
    </div>`}
    ${plans.map((p) => {
      const card = CONTENT.cards.cards.find((c) => c.id === p.cardId);
      return `<div class="card plan-card">
        <div class="meta">
          <span class="tag dom">${esc(card ? card.domain : '')}</span>
          <span class="tag">${fmtDay(p.ts)}</span>
          ${p.rehearsed ? `<span class="tag">复看 ${p.rehearsed} 次</span>` : '<span class="tag tag-warn">还没复看</span>'}
        </div>
        <div class="plan-line"><b>如果</b>${esc(p.if)}</div>
        <div class="plan-line"><b>我就</b>${esc(p.then)}</div>
        ${card ? `<button class="plain tiny" onclick="showPlanSource('${p.cardId}')">看这道题</button>` : ''}
        <button class="ghost tiny" onclick="rehearse('${p.id}')">看过了</button>
        <button class="plain tiny" onclick="dropPlan('${p.id}')">删掉</button>
      </div>`;
    }).join('')}
    ${plans.length ? `<div class="card hint">
      这些是你自己写的，不是我给你的。写下来只是第一步——真正起作用的是你在事情发生前
      想起过它。所以隔几天回来点一次「看过了」。
    </div>` : ''}`;
}

function rehearse(id) {
  const p = state.plans.find((x) => x.id === id);
  if (!p) return;
  p.rehearsed = (p.rehearsed || 0) + 1;
  p.lastRehearsed = Date.now();
  save();
  bump('respond', 1);
  renderPlans();
}

function dropPlan(id) {
  state.plans = state.plans.filter((x) => x.id !== id);
  save();
  renderPlans();
}

function showPlanSource(cardId) {
  const i = CONTENT.cards.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  session = { queue: [CONTENT.cards.cards[i]], i: 0, lowLoad: true, genrePick: null, cluePick: null };
  cardsView = 'drill';
  renderCard();
}

/* ------------------------------------------------------------ 偏差画像
   刻意把「对多少」和「往哪边歪」分开显示。它们不是一回事：
   命中率受题目难度影响，而偏差方向是你自己的，改起来也具体得多。 */
function renderBias() {
  const ranked = biasRanked();
  const total = state.stats.answered;
  const acc = total ? Math.round(state.stats.correct / total * 100) : 0;
  const biasN = biasTotal();
  const top = ranked[0];

  $('#view').innerHTML = `
    ${cardsNav()}
    <div class="card">
      <h2>偏差画像</h2>
      <p class="hint" style="margin-top:8px">
        准确率和偏差是两件事。一个人可以命中率还行，却每次都错在同一个方向上——
        那才是真正要改的地方，因为它说明的是一种<b>习惯</b>，不是一次失误。
      </p>
      <p class="hint" style="margin-top:8px">
        <b>但它只是参考，不是给你下定义。</b>下面这几类，是把你<b>已经答过的那几道题</b>
        里出现过几次同一类误读数了一遍——为什么错、错了几次，都来自那几道具体的题。
        它跟"你是什么样的人"是弱相关：样本少的时候基本说明不了什么，你继续答题它就跟着变，
        练得多了某一类自然会掉下去。它也不会决定给你出什么题，最多让那一类
        <b>多出现一点</b>——出题的主体仍然是卡片本身和你的进度。
      </p>
      <div class="score-row">
        <div><b>${acc}%</b><span>命中率</span></div>
        <div><b>${total}</b><span>累计判断</span></div>
        <div><b>${biasN}</b><span>误读次数</span></div>
      </div>
      ${biasN < 6 ? `<div class="hint" style="margin-top:10px">
        误读样本还太少，现在的方向说明不了什么。至少做 ${6 - biasN} 题再看。
      </div>` : ''}
    </div>

    ${ranked.length ? ranked.map(([k, n], idx) => {
      const b = BIAS_TYPES[k];
      const pct = Math.round(n / biasN * 100);
      return `<div class="card bias-card ${idx === 0 ? 'bias-top' : ''}">
        <div class="bias-head">
          <div>
            <b>${esc(b.label)}</b>
            <span class="bias-sub">${rich(b.short)}</span>
          </div>
          <div class="bias-n">${n} 次 · ${pct}%</div>
        </div>
        <div class="tbar" style="margin:10px 0 12px"><i style="width:${pct}%"></i></div>
        ${idx === 0 && biasN >= 6 ? '<div class="tag tag-warn" style="margin-bottom:8px">这阵子出现得最多的一类</div>' : ''}
        <div class="diag-why">${rich(b.desc)}</div>
        <div class="diag-fix"><b>怎么改：</b>${rich(b.fix)}</div>
      </div>`;
    }).join('') : (biasN === 0 && total > 0 ? `<div class="card hint">
      没有误读记录。要么你判断很准，要么错的那几题都落在「也算说得通」里了。
    </div>` : '')}

    ${!ranked.length && !total ? `<div class="card">
      <p class="hint">还没做过题。刷几道卡片，这里会长出你自己的偏向图。</p>
      <div class="row"><button class="primary" onclick="setPracticeSubview('cards')">去刷卡片</button></div>
    </div>` : ''}`;
}

function viewCards() {
  /* cardsView 才是这三个子页的开关。
   *
   * 之前这个变量只被赋值、从来没被读——于是「偏差画像」和「我的预案」
   * 都渲染成了刷卡片那一页，三个入口长得一模一样（用户报的「两个界面变成一样了」）。
   * 这类 bug 不报错、不抛异常，只让页面悄悄退化，所以下面还有一条断言盯着
   * 「每个子页的正文必须两两不同」。
   */
  if (cardsView === 'plans') { renderPlans(); return; }
  if (cardsView === 'bias') { renderBias(); return; }
  if (!session.queue.length) session = { queue: buildQueue(), i: 0, lowLoad: false, genrePick: null, cluePick: null };
  renderCard();
}

function renderCard() {
  const q = session.queue;
  const card = q[session.i];
  if (!card) {
    const wrong = state.stats.wrongIds.length;
    const planN = state.plans.length;
    $('#view').innerHTML = `
      ${cardsNav()}
      ${domainBar()}
      <div class="card">
        <h2>这一组做完了</h2>
        <p class="hint" style="margin-top:8px">
          答题正确率 ${state.stats.answered ? Math.round(state.stats.correct / state.stats.answered * 100) : 0}%
          · 累计 ${state.stats.answered} 题
        </p>
        ${planN ? `<p class="hint">你已经写了 ${planN} 条预案。回头看一眼吧——复看过的计划才有用。</p>` : ''}
        <div class="row">
          <button class="primary" onclick="newSession()">再来一组</button>
        </div>
        ${planN ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('plans')">看我的预案（${planN}）</button></div>` : ''}
        ${biasTotal() ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('bias')">看偏差画像</button></div>` : ''}
        ${wrong ? `<div class="row"><button class="ghost" onclick="wrongSession()">翻车回放（${wrong} 题做错过）</button></div>` : ''}
      </div>
      ${wrong ? `<div class="card hint">翻车回放会把做错过的题重排一遍，考的是你这次能不能真的判断对，而不是记住答案。</div>` : ''}`;
    return;
  }

  const meta = state.srs[card.id];
  if (session.lowLoad) return renderCardReadOnly(card, meta);

  $('#view').innerHTML = `
    ${cardsNav()}
    ${domainBar()}
    ${focusBar()}
    <div class="card">
      <div class="meta">
        <span class="tag type">${TYPE_NAME[card.type] || card.type}</span>
        <span class="tag dom">${esc(card.domain || '')}</span>
        <span class="tag">${esc(card.stage)}</span>
        ${meta ? `<span class="tag">第 ${meta.seen + 1} 次</span>` : '<span class="tag">新题</span>'}
        <span class="tag" id="readTag" style="cursor:pointer" onclick="toReadOnly()">只读模式</span>
      </div>
      <p class="scene">${rich(card.context)}</p>
      <blockquote class="quote">「${rich(card.quote)}」</blockquote>
      <p class="prompt">${rich(card.question)}</p>
      ${card.genre ? `
      <div class="genre-step" id="genreStep">
        <div class="label">先别急着选动作 —— 这是什么局？</div>
        <div class="genre-grid">
          ${GENRES.map((g) => `<button class="genre-btn" data-g="${esc(g)}"
            onclick="pickGenre(this)">${esc(g)}</button>`).join('')}
        </div>
        <p class="hint">这一步是刻意挡在前面的。跳过它，下面四个选项都会变得含糊——
        现实里也正是跳过它的时候最容易答非所问。</p>
      </div>` : ''}
      ${(card.clues && card.clues.length) ? `
      <div class="genre-step" id="clueStep" style="display:none">
        <div class="label">你凭哪一句这么判？</div>
        <div class="genre-grid">
          ${card.clues.map((x, i) => `<button class="genre-btn" data-c="${i}"
            onclick="pickClue(this)">${rich(x.text)}</button>`).join('')}
        </div>
        <p class="hint">必须指一条依据才往下走。用户自己的话是「必须选一句依据才算数」——
        这一步治的是<b>跳过证据直接贴标签</b>：局判对了但依据找错，多半是蒙对的，
        下一次换个场景就不成立了。所以这一步和判局一样要算对。</p>
      </div>` : ''}
      <div class="opts" id="opts"${(card.genre || (card.clues || []).length) ? ' style="display:none"' : ''}>
        ${card.options.map((o) => `
          <button class="opt" data-id="${o.id}" onclick="answerCard('${o.id}')">
            <span class="k">${o.id}</span>${rich(o.text)}
          </button>`).join('')}
      </div>
      <div id="hintSlot"></div>
      <div id="fb"></div>
    </div>`;
  startCardTimer();
}

/** 卡在一道题上太久 → 很可能是脑雾上来了，主动给出口，而不是让他干耗 */
function startCardTimer() {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    const slot = document.getElementById('hintSlot');
    if (!slot) return;
    slot.innerHTML = `<div class="fog-hint">
      <span>这道题停了 75 秒了。如果是突然想不动了，不是你的问题——先缓一下再回来。</span>
      <button onclick="openFog('超时')">缓一下</button>
      <button class="plain" onclick="this.closest('.fog-hint').remove()">继续想</button>
    </div>`;
  }, 75000);
}

function clearCardTimer() {
  clearTimeout(cardTimer);
  cardTimer = null;
}

/** 只读模式：脑雾之后降负荷用，不答题、不动间隔重复 */
function renderCardReadOnly(card, meta) {
  $('#view').innerHTML = `
    ${cardsNav()}
    ${domainBar()}
    <div class="card">
      <div class="meta">
        <span class="tag type">只读模式</span>
        <span class="tag dom">${esc(card.domain || '')}</span>
        <span class="tag">${esc(card.stage)}</span>
        ${meta ? `<span class="tag">第 ${meta.seen + 1} 次</span>` : ''}
      </div>
      <p class="scene">${rich(card.context)}</p>
      <blockquote class="quote">「${rich(card.quote)}」</blockquote>
      ${card.state ? `<div class="block">
        <div class="label">先读局</div>
        <div>${rich(card.state)}</div>
      </div>` : ''}
      <div class="block">
        <div class="label">要记住的原理</div>
        <div>${rich(card.principle)}</div>
        ${popBtn('为什么', card.explain, '为什么是这条')}
      </div>
      ${card.action ? `<div class="block">
        <div class="label">真要开口时</div>
        <div>${rich(card.action)}</div>
      </div>` : ''}
      <p class="hint" style="margin-top:12px">只看不做题，不计入进度，也不会打乱复习节奏。</p>
      <div class="row" style="flex-direction:column;gap:8px">
        <button class="primary" onclick="nextCard()">下一张（只读）</button>
        <button class="ghost" onclick="exitReadOnly()">我感觉可以了，回去答题</button>
      </div>
    </div>`;
}

function toReadOnly() {
  session.lowLoad = true;
  renderCard();
}

function exitReadOnly() {
  session.lowLoad = false;
  renderCard();
}

/** 读局卡的第一步：判局。选完才放出「找依据」那一步。 */
function pickGenre(btn) {
  const card = session.queue[session.i];
  if (!card || !card.genre) return;
  const picked = btn.dataset.g;
  session.genrePick = picked;
  session.cluePick = null;      // 换了一张卡/重判一次，依据要重新指
  document.querySelectorAll('#genreStep .genre-btn').forEach((b) => {
    b.disabled = true;
    b.classList.toggle('picked', b === btn);
  });
  const step = document.getElementById('genreStep');
  if (step) step.classList.add('done');
  // 有依据这一步就先把依据放出来；没有的话（老卡）直接放动作选项。
  const clue = document.getElementById('clueStep');
  const opts = document.getElementById('opts');
  if (clue) {
    clue.style.display = '';
    // 标出他判的局，好在反馈里跟正确的对比（不在这一步给对错，避免泄题给动作选项）
    const slot = document.getElementById('genrePickSlot');
    if (slot) slot.textContent = picked;
    return;
  }
  if (opts) opts.style.display = '';
  const slot = document.getElementById('genrePickSlot');
  if (slot) slot.textContent = picked;
}

/** 第二步：指一条依据。指完才放出动作选项。
 *
 *  用户的原话是「必须选一句依据才算数」——治的是他自述的「分不清情况、
 *  直接得出结论」。所以这一步是**强制**的：不指依据就看不到动作选项。
 *  而且它和判局一样**要算对**（见 answerCard 里的 counted），
 *  否则「局蒙对了但依据是错的」也会算过——那正是这一步想拦的东西。 */
function pickClue(btn) {
  const card = session.queue[session.i];
  if (!card || !(card.clues || []).length) return;
  const i = Number(btn.dataset.c);
  session.cluePick = i;
  document.querySelectorAll('#clueStep .genre-btn').forEach((b) => {
    b.disabled = true;
    b.classList.toggle('picked', b === btn);
  });
  const step = document.getElementById('clueStep');
  if (step) step.classList.add('done');
  const opts = document.getElementById('opts');
  if (opts) opts.style.display = '';
}

function answerCard(chosen) {
  clearCardTimer();
  /* 页面可能已经被切走了。这道题本来是「用户点了选项之后又立刻切 tab」：
     下面的代码会去写 #opts / #fb，那些节点已经不在，于是抛
     `Cannot set properties of null (setting 'innerHTML')`——
     一个用户看不见、但会打断当前页面的未捕获异常。 */
  if (!document.getElementById('opts')) return;
  const card = session.queue[session.i];
  if (!card) return;
  const ok = card.best === chosen;
  const half = !ok && (card.ok || []).includes(chosen);
  wrongStreak = ok || half ? 0 : wrongStreak + 1;

  document.querySelectorAll('#opts .opt').forEach((el) => {
    const id = el.dataset.id;
    el.disabled = true;
    if (id === card.best) el.classList.add('right');
    else if ((card.ok || []).includes(id)) el.classList.add('half');
    else if (id === chosen) el.classList.add('wrong');
    else el.classList.add('dim');
  });

  const correct = (card.options.find((o) => o.id === card.best) || {}).text || '';
  const picked = card.options.find((o) => o.id === chosen) || {};
  const correctOpt = card.options.find((o) => o.id === card.best) || {};
  const bt = BIAS_TYPES[picked.err];
  const bestBt = BIAS_TYPES[correctOpt.err];

  // 只统计「选了错的」——次优和首选都算正解方向，不算偏差
  if (!ok && !half && picked.err) recordBias(picked.err);

  /* 判局单独记一笔，跟选错动作分开。
   * 两件事混在一起就看不出来他缺的是哪一半：先分类错了、还是分类对了但动作选错。
   * 前者记进「误判场合」。
   * id 上带 #genre 是为了在 answers 里能跟同一张卡的动作作答区分开——
   * 否则纵向比对会把一次作答算成两次。 */
  let genreOk = null;
  if (card.genre) {
    const acceptable = [card.genre].concat(card.genreAlt || []);
    genreOk = acceptable.includes(session.genrePick);
    if (!genreOk) recordBias('误判场合');
    state.answers.push({
      t: Date.now(), id: card.id + '#genre',
      err: genreOk ? '正解' : '误判场合', ok: genreOk,
    });
    if (state.answers.length > 300) state.answers = state.answers.slice(-300);
  }

  /* 「依据」也单独记一笔。和判局分开记的理由同上：要能看出他缺的是哪一半——
     是局都判错了，还是局判对了但依据找错了（后者多半是蒙对的）。
     id 上带 #clue，和 #genre 一样是为了不在纵向比对里被算成两次。 */
  let clueOk = null;
  if ((card.clues || []).length) {
    const idx = (typeof session.cluePick === 'number') ? session.cluePick : -1;
    clueOk = !!(card.clues[idx] && card.clues[idx].ok);
    state.answers.push({
      t: Date.now(), id: card.id + '#clue',
      err: clueOk ? '正解' : '依据没找对', ok: clueOk,
    });
    if (state.answers.length > 300) state.answers = state.answers.slice(-300);
  }
  // 逐次留档，阶段评估的纵向比对要用。只留最近 300 次：要的是趋势，不是档案。
  state.answers.push({ t: Date.now(), id: card.id, err: (ok || half) ? '正解' : (picked.err || '正解'), ok: !!ok });
  if (state.answers.length > 300) state.answers = state.answers.slice(-300);

  const others = card.options.filter((o) => o.id !== chosen && o.id !== card.best);

  $('#fb').innerHTML = `
    <div class="fb">
      <h3 class="${ok ? 'result-good' : half ? 'result-half' : 'result-bad'}">
        ${ok ? '判断正确' : half ? '也算说得通，但不是首选' : '差了' }
      </h3>

      <!-- 「读局」卡先把状态摆出来。
           放在最前面是有意的：读局卡考的是「下一步出什么牌」，而选牌之前
           那道判断（这是什么局、话题还剩多少气）常常被跳过——用户的原话是
           「没有搞清楚情况」「回答的牛头不对马嘴」。所以先让他看到那道题本身，
           再看自己选得对不对。这一步不能提前显示，提前了就等于把答案送出去。 -->
      ${card.state ? `
      <div class="block diag-read">
        <div class="label">先读局：这一步经常被跳过</div>
        ${genreOk === null ? '' : `<div class="genre-verdict ${genreOk ? 'ok' : 'bad'}">
          你判的局：<b>${esc(session.genrePick || '（没判）')}</b>
          ${genreOk ? '✓ 判对了'
            : `✗ 这局其实是：<b>${esc(card.genre)}</b>${
                (card.genreAlt || []).length ? `（${esc((card.genreAlt || []).join(' 或 '))} 也算）` : ''}`}
        </div>`}
        ${clueOk === null ? '' : `<div class="genre-verdict ${clueOk ? 'ok' : 'bad'}">
          你指的依据：<b>${esc(((card.clues[session.cluePick] || {}).text) || '（没选）')}</b>
          ${clueOk
            ? '✓ 这就是那句话露出来的东西'
            : `✗ 这条读起来像，但它不是这句话真正的判据。真正能站住的是：<b>${
                esc((card.clues.find((x) => x.ok) || {}).text || '')}</b>`}
          ${clueOk ? '' : '<br><span class="hint">局判对了但依据找错，多半是蒙对的——换个场景就不成立了。'
            + '所以这一步和判局一样要算对。</span>'}
        </div>`}
        <div class="diag-why">${rich(card.state)}</div>
      </div>` : ''}

      <!-- 「你选的这条」这一块，次优（half）也要显示。
           原来这里的条件是「不是首选 且 有偏差类型」，而 half 选项的 err 是「正解」
           （不在 BIAS_TYPES 里，取出来是 undefined），于是整块不渲染。后果很别扭：
           答得差不多的反馈比答错的还少——答错会得到「问题出在哪 + 往哪个方向改」，
           答「也算说得通」却只看到一句「不是首选」，而那条选项自己的 why
           （数据里早就写好了）哪里都没显示。
           次优恰恰是最值得讲的一类：它是最接近的错法，差在哪才是要学的点。
           所以拆成两支：有偏差类型 → 老样子（诊断 + 改法）；没有 → 讲清它为什么不是首选。

           注意：这段是 **HTML 注释**，不是 JS 的块注释。这个模板是整块 template
           literal，用 /* */ 写的话注释会当成正文渲染出来（我刚好踩了一次，
           check_tabs_unique 里那条「界面上没有露出来的 **」当场就红了）。
           另外反引号也不能出现——它会把模板字符串截断。 -->
      ${!ok ? `
      <div class="block diag-mine">
        <div class="label">${bt ? '你选的这条，问题出在哪' : '你选的这条，为什么不是首选'}</div>
        <div class="diag-head">
          <b>${chosen}</b> · ${rich(picked.text || '')}
          ${bt ? `<span class="tag tag-bad">${esc(bt.label)}</span>` : '<span class="tag">说得通，但更远</span>'}
        </div>
        <div class="diag-why">${rich(picked.why || '')}</div>
        ${bt ? `<div class="diag-fix"><b>往这个方向改：</b>${rich(bt.fix)}</div>`
          : `<div class="diag-fix"><b>它和首选差在哪：</b>它不是读错，是<b>读得浅一层</b>——
              放在别的场合它可能就是对的，但这一次还有一层你没用上。上面「首选答案」那段
              说的就是那一层。</div>`}
      </div>` : ''}

      <div class="block">
        <div class="label">首选答案</div>
        <div class="diag-head">
          <b>${card.best}</b> · ${esc(correct)}
          ${bestBt ? `<span class="tag tag-good">${esc(bestBt.label)}</span>` : ''}
        </div>
        ${correctOpt.why ? `<div class="diag-why">${rich(correctOpt.why)}</div>` : ''}
      </div>

      <div class="block">
        <div class="label">要记住的原理</div>
        <div>${rich(card.principle)}</div>
        ${popBtn('为什么', card.explain, '为什么是这条')}
      </div>
      ${card.alt ? `<div class="row">${popBtn('另一种可能（别把结论定死）', card.alt)}</div>` : ''}

      ${card.action ? `<div class="block">
        <div class="label">真要开口时的方向</div>
        <div>${rich(card.action)}</div>
      </div>` : ''}

      ${others.length ? `<details class="block diag-more">
        <summary>另外 ${others.length} 条读法为什么被排除</summary>
        ${others.map((o) => `
          <div class="diag-other">
            <div class="diag-head">
              <b>${o.id}</b> · ${rich(o.text)}
              ${BIAS_TYPES[o.err] ? `<span class="tag">${esc(o.err)}</span>` : ''}
            </div>
            <div class="diag-why">${rich(o.why || '')}</div>
          </div>`).join('')}
      </details>` : ''}

      ${planEditor(card)}

      <button class="primary" style="margin-top:14px" onclick="nextCard()">继续</button>${''}
      ${wrongStreak >= 2 ? `<div class="fog-hint" style="margin-top:12px">
        <span>连错 ${wrongStreak} 题了。这种时候继续答下去通常只会越错越多，
        不代表你学不会——先缓一下，或者切只读模式。</span>
        <button onclick="openFog('连错${wrongStreak}题')">缓一下</button>
        <button class="plain" onclick="toReadOnly()">切只读</button>
      </div>` : ''}
    </div>`;

  rate(card.id, ok);
  bump('interpret', ok ? 3 : half ? 1 : 0);
  /* 达标只认「判对」的那一次：
     · 有读局步骤 → 看读局判对没有（genreOk）
     · 有依据步骤 → 依据也得指对（clueOk）——局蒙对、依据是错的，不算判准
     · 都没有（老卡） → 看动作有没有选到最好的那个（ok）
     half（也算说得通）不算，见 bumpDaily 的说明。 */
  const counted = card.genre
    ? (genreOk === true && clueOk !== false)
    : ok === true;
  bumpDaily('card', counted);
}

/* ------------------------------------------------------------ 行动预案
   为什么这张卡要让你自己写一句，而不是背一句：
   执行意图（if-then plan）是少数几个有大样本证据、能真的把「知道」变成「做到」的手段。
   Gollwitzer & Sheeran 2006 的元分析（94 个独立检验）效应量 d=.65；
   2024 年更新的 642 个检验里，条件式计划（d=.43）明显优于日程式（d=.29），
   而且**至少预演过一次的人效果更大**。所以这里既让你写，也让你回头复看。
   代价也说清楚：光有「打算」不够。Webb & Sheeran 发现把意图加强，行为只动 d=.36——
   中间那道坎就是缺一个具体到能自动触发的「如果」。 */
function planEditor(card) {
  const seed = card.plan;
  const mine = state.plans.find((p) => p.cardId === card.id);
  const curIf = mine ? mine.if : '';
  const curThen = mine ? mine.then : '';
  return `
    <div class="block plan-box">
      <div class="label">写一句你自己的预案</div>
      <div class="hint" style="margin-bottom:8px">
        光记住「下次注意点」是没用的。要具体到一个你认得出的场景 + 一个明确的动作。
        写完之后，回头在「我的预案」里看一眼——复看过的计划，效果明显更好。
      </div>
      ${seed ? `<div class="plan-seed">
        <div class="label">参考（别照抄，改成你自己的）</div>
        <div><b>如果</b>${esc(seed.if)}</div>
        <div><b>我就</b>${esc(seed.then)}</div>
        <button class="plain tiny" onclick="fillPlan('${card.id}')">照着改</button>
      </div>` : ''}
      <div class="plan-in">
        <div class="plan-row"><span>如果</span>
          <input id="pIf" type="text" value="${esc(curIf)}" placeholder="具体到什么场合、什么信号">
        </div>
        <div class="plan-row"><span>我就</span>
          <input id="pThen" type="text" value="${esc(curThen)}" placeholder="我会做什么（不是我会说什么）">
        </div>
      </div>
      <div id="planMsg" class="plan-msg"></div>
      <button class="ghost" onclick="savePlan('${card.id}')">
        ${mine ? '更新我的预案' : '存进我的预案'}
      </button>
      ${mine ? `<div class="hint" style="margin-top:6px">已存 ${fmtDay(mine.ts)}${mine.rehearsed ? ` · 复看过 ${mine.rehearsed} 次` : ' · 还没复看过'}</div>` : ''}
    </div>`;
}

function fillPlan(cardId) {
  const card = session.queue[session.i];
  if (!card || !card.plan) return;
  const a = document.getElementById('pIf');
  const b = document.getElementById('pThen');
  if (a) a.value = card.plan.if;
  if (b) b.value = card.plan.then;
  if (b) b.focus();
}

function savePlan(cardId) {
  const a = document.getElementById('pIf');
  const b = document.getElementById('pThen');
  const msg = document.getElementById('planMsg');
  if (!a || !b) return;
  const pif = a.value.trim();
  const pthen = b.value.trim();

  if (pif.length < 4) {
    msg.className = 'plan-msg bad';
    msg.textContent = '「如果」太笼统了。要具体到你能一眼认出来的场景和信号。';
    return;
  }
  const prob = planProblem(pthen);
  if (prob) {
    msg.className = 'plan-msg bad';
    msg.innerHTML = esc(prob);
    b.focus();
    return;
  }

  const existing = state.plans.find((p) => p.cardId === cardId);
  if (existing) {
    existing.if = pif;
    existing.then = pthen;
    existing.ts = Date.now();
  } else {
    state.plans.push({ id: 'p' + Date.now(), cardId, if: pif, then: pthen, ts: Date.now(), rehearsed: 0 });
  }
  save();
  msg.className = 'plan-msg ok';
  msg.textContent = '已存进「我的预案」。回头看一眼比写下来更有用。';
  bump('respond', 2);
}

function nextCard() {
  session.i++;
  // 换卡必须把上一张的选择清掉。原来只 i++，genrePick 会带到下一张——
  // 以前被「不选就看不到选项」挡住了，加了依据这一步之后同样一个隐患多了一个字段，
  // 所以在这里显式清一次（靠副作用掩盖状态泄漏，迟早会漏出来）。
  session.genrePick = null;
  session.cluePick = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderCard();
}

function newSession() {
  session = { queue: buildQueue(), i: 0, lowLoad: false, genrePick: null, cluePick: null };
  wrongStreak = 0;
  renderCard();
}

function wrongSession() {
  session = { queue: buildQueue('wrong'), i: 0, lowLoad: false, genrePick: null, cluePick: null };
  wrongStreak = 0;
  renderCard();
}

/* ============================================================ 视图：语境校准 */

const VERDICT_LABEL = { yes: '能说', revise: '改说法才能说', no: '别说' };
let calSingleton = null;

function viewCalib() {
  const phrases = CONTENT.calibration.phrases || [];
  const all = [];
  phrases.forEach((p) => p.cases.forEach((c) => all.push({ ...c, phrase: p })));
  const fresh = all.filter((x) => !state.cal[x.id]);
  const pool = fresh.length ? fresh : all;
  calSingleton = pool[Math.floor(Math.random() * pool.length)];
  renderCalib();
}

function renderCalib() {
  const item = calSingleton;
  if (!item) { $('#view').innerHTML = '<div class="card">题库为空</div>'; return; }
  const p = item.phrase;

  $('#view').innerHTML = `
    <div class="card">
      <div class="meta">
        <span class="tag dom">${esc(item.phrase.domain || '')}</span>
        <span class="tag">${esc(item.stage)}</span>
        <span class="tag">问题：${esc(p.issue)}</span>
      </div>
      <p class="prompt">你打算说这句话：</p>
      <blockquote class="quote">「${esc(p.phrase)}」</blockquote>
      <p class="scene">场合：${esc(item.setting)}</p>
      <p class="prompt">现在这个阶段 + 这个场合，能说吗？</p>
      <div class="verdicts" id="vd">
        <button class="opt" data-v="yes" onclick="answerCalib('yes')">能说</button>
        <button class="opt" data-v="revise" onclick="answerCalib('revise')">改说法才能说</button>
        <button class="opt" data-v="no" onclick="answerCalib('no')">别说</button>
      </div>
      <div id="fb"></div>
    </div>`;
}

function answerCalib(chosen) {
  const item = calSingleton;
  const p = item.phrase;
  const ok = item.verdict === chosen;

  document.querySelectorAll('#vd .opt').forEach((el) => {
    el.disabled = true;
    if (el.dataset.v === item.verdict) el.classList.add('right');
    else if (el.dataset.v === chosen) el.classList.add('wrong');
    else el.classList.add('dim');
  });

  const siblings = p.cases.filter((c) => c.id !== item.id);
  $('#fb').innerHTML = `
    <div class="fb">
      <h3 class="${ok ? 'result-good' : 'result-bad'}">
        ${ok ? '对' : `应该是「${VERDICT_LABEL[item.verdict]}」`}
      </h3>
      <div class="block" style="margin-top:10px">
        <div class="label">为什么</div>
        <div>${rich(item.why)}</div>
      </div>
      ${item.revised ? `<div class="block">
        <div class="label">改后可以说</div>
        <div class="quote" style="font-size:1rem;margin:0">「${esc(item.revised)}」</div>
      </div>` : ''}
      <div class="block">
        <div class="label">这一题的通用原理</div>
        <div>${rich(p.principle)}</div>
      </div>
      <div class="block">
        <div class="label">同一句话，换关系阶段 / 换场合</div>
        ${siblings.map((s) => `
          <div style="margin:8px 0 0;padding:10px 12px;background:var(--panel2);border-radius:10px">
            <div style="font-size:.82rem;color:var(--dim)">
              ${esc(s.stage)} · ${esc(s.setting)}
            </div>
            <div style="margin-top:5px;font-size:.9rem">
              <b class="${s.verdict === 'yes' ? 'result-good' : s.verdict === 'revise' ? 'result-half' : 'result-bad'}">
                ${VERDICT_LABEL[s.verdict]}</b>
              <span class="hint"> — ${rich(s.why)}</span>
            </div>
          </div>`).join('')}
      </div>
      <button class="primary" style="margin-top:14px" onclick="viewCalib()">下一题</button>
    </div>`;

  state.cal[item.id] = { seen: true, correct: ok };
  bump('respond', ok ? 3 : 0);
  state.stats.answered++; if (ok) state.stats.correct++;
  markActivity(); save();
}

/* ============================================================ 视图：表达体检 */

const DIMS = [
  ['canned', '罐头度', '是不是就着此刻这个场景说的'],
  ['overstep', '越级度', '有没有超出你们现在的关系程度'],
  ['narcissism', '自恋度', '句子里「我」的浓度'],
  ['judge', '评判度', '是在了解，还是在评价/说教'],
  ['sexual', '性暗示度', '现阶段带性意味合不合适'],
];

function viewCheckup() {
  $('#view').innerHTML = `
    <div class="card">
      <h2>表达体检</h2>
      <p class="hint" style="margin-top:8px">
        把你要发出去的那句话贴进来。它不从"会不会聊天"打分，只看五件会让人觉得油、爹、越界的事。
        分数高 = 健康。
      </p>
      <div style="margin-top:14px">
        <label class="field"><span>你打算说的话</span>
          <textarea id="ckText" rows="3" placeholder="例：今天这条裙子很好看，是想见我吗？"></textarea></label>
        <label class="field"><span>场景（越具体越准：关系阶段、在哪、刚发生了什么）</span>
          <textarea id="ckCtx" rows="3" placeholder="例：认识两个月，单独出来过五次，她刚主动问我到哪了"></textarea></label>
      </div>
      <button class="primary" id="ckBtn" onclick="runCheckup()">体检</button>
    </div>
    <div id="ckOut"></div>`;
}

async function runCheckup() {
  const text = $('#ckText').value.trim();
  const context = $('#ckCtx').value.trim();
  if (!text) return toast('先写一句要体检的话');
  const btn = $('#ckBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>分析中';
  $('#ckOut').innerHTML = '';
  try {
    // 走前端（llmCall）：原始实现是 post('/api/ai/checkup')，而手机里没有服务端，
    // 所以这个模块在 APK 里一直是死的。
    const r = await aiCheckup(text, context);
    renderCheckup(r);
    bump('respond', 2); markActivity(); save();
  } catch (e) {
    $('#ckOut').innerHTML = `<div class="card"><h3 class="result-bad">没能完成</h3>
      <p class="hint" style="margin-top:8px">${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '体检';
  }
}

function scoreColor(v) { return v >= 8 ? 'var(--good)' : v >= 5 ? 'var(--warn)' : 'var(--bad)'; }

function renderCheckup(res) {
  const s = res.scores || {};
  const signals = res.signals || [];
  const byDim = {};
  signals.forEach((x) => { if (!byDim[x.dim]) byDim[x.dim] = x; });

  $('#ckOut').innerHTML = `
    <div class="card">
      <h2>${esc(res.overall || '')}</h2>
      <div style="margin-top:16px">
        ${DIMS.map(([k, name, desc]) => {
          const v = Number(s[k] ?? 0);
          const sig = byDim[k];
          return `<div class="dimrow">
            <div class="dimhead"><span>${name}<em style="margin-left:7px">${desc}</em></span><b>${v}</b></div>
            <div class="dimbar"><i style="width:${v * 10}%;background:${scoreColor(v)}"></i></div>
            ${sig ? `<div class="dimnote"><b>问题：</b>${rich(sig.problem)}<br><b>怎么改：</b>${rich(sig.fix)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${res.why_greasy ? `<div class="block" style="margin-top:6px">
        <div class="label">整体判断</div><div>${rich(res.why_greasy)}</div></div>` : ''}
      ${(res.revised || []).length ? `<div class="block">
        <div class="label">按这个场景，可以改成</div>
        ${res.revised.map((t) => `<div class="quote" style="font-size:1rem;margin:6px 0">「${esc(t)}」</div>`).join('')}
        <div class="hint">这是方向和样例，不是让你背的模板。换个场景就得重新想。</div>
      </div>` : ''}
      ${res.principle ? `<div class="block">
        <div class="label">能带走的一条原理</div><div>${rich(res.principle)}</div></div>` : ''}
      <div class="hint" style="margin-top:10px">置信度：${esc(res.confidence || '中')}</div>
    </div>`;
}

/* ============================================================ 视图：真实复盘 */

function viewReplay() {
  replay.reveal = null;
  replay.questions = [];
  replay.answers = [];
  renderReplayStep1();
}

function renderReplayStep1() {
  $('#view').innerHTML = `
    <div class="card">
      <h2>真实复盘</h2>
      <p class="hint" style="margin-top:8px">
        贴一段真实的聊天记录。它不会直接告诉你怎么回——先出题让你自己判断，
        你答完才揭晓。这样练的是判断力，不是复制粘贴。
      </p>
      <p class="hint" style="margin:8px 0 0">
        懒得打字就<b>传截图</b>：它会把图里的聊天记录抄成文字填进来（长截图会自动切成几段，
        免得字糊）。抄完先看一眼、改一改再往下走。
      </p>
      <div class="row" style="margin-top:12px">
        <button class="ghost" id="rpShotBtn" onclick="startShotOcr()">📷 上传聊天截图</button>
      </div>
      <div id="rpShotState" class="hint" style="margin-top:10px"></div>
      <p class="warnbox" style="margin:14px 0">
        <b>隐私提醒</b>：贴进来的文字、<b>以及你选的截图本身</b>都会发到模型接口去处理
        （截图只在识别的那一次发出去，App 不留它）。建议先把名字、手机号、住址改掉再贴。
      </p>
      <label class="field"><span>聊天记录</span>
        <textarea id="rpChat" rows="7" placeholder="她：&#10;我：（把她和你自己的话区分开写，标上是谁说的）">${esc(replay.chat)}</textarea></label>
      <label class="field"><span>背景（可选，但很有用）</span>
        <textarea id="rpBg" rows="3" placeholder="例：认识两个月，单独见过三次。我从上周开始回得慢。">${esc(replay.background)}</textarea></label>
      <button class="primary" id="rpBtn" onclick="runReplayQuestions()">出题</button>
    </div>
    <div id="rpOut"></div>`;
}

/* ------------------------------------------------- 截图 → 文字（复盘用）
 *
 * 识别本身在 voice.js（选图 / 切段 / 调视觉模型）。这里只管界面：
 * 按一下 → 说清"在处理" → 成功就把文字填进输入框，失败就说失败在哪。
 *
 * 一条刻意的设计：**填进去之后不自动往下走**。抄错了（尤其长截图切段的地方）
 * 如果不看一眼就出题，后面整套分析都建立在错字上，而用户不会知道。
 * 所以这里只填、不点，把"看一眼"这一步留在它该在的地方。 */

function shotDownloading() {
  const el = $('#rpShotState');
  if (el) el.innerHTML = '<span class="spin"></span> 正在压缩并识别…（长截图要十几秒）';
  const b = $('#rpShotBtn');
  if (b) b.disabled = true;
}

function startShotOcr() {
  shotDownloading();
  pickChatShots();
}

/** 识别结束。r 是 {text, parts} 或 null；why 是失败原因。 */
function shotDone(r, why) {
  const el = $('#rpShotState');
  const b = $('#rpShotBtn');
  if (b) b.disabled = false;
  if (!r) {
    if (el) {
      el.innerHTML = `<span style="color:var(--bad-fg)">没识别成功：${esc(why || '未知原因')}</span>`
        + `<br><span style="color:var(--dim)">可以直接打字贴进来，不影响后面的分析。</span>`;
    }
    return;
  }
  const box = $('#rpChat');
  if (box) {
    // 追加而不是覆盖：万一他先手打了一段、又把截图补上，不该把已经打的字抹掉。
    const old = box.value.trim();
    box.value = old ? (old + '\n' + r.text) : r.text;
    box.scrollTop = box.scrollHeight;
  }
  if (el) {
    el.innerHTML = `识别完成（${r.parts} 张图）。`
      + `<b>先看一眼再点「出题」</b>——长截图切段的地方可能有漏字或重复，改一下更准。`;
  }
}

async function runReplayQuestions() {
  replay.chat = $('#rpChat').value.trim();
  replay.background = $('#rpBg').value.trim();
  if (!replay.chat) return toast('先贴一段聊天记录');
  const btn = $('#rpBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>读这段对话';
  $('#rpOut').innerHTML = '';
  try {
    const r = await aiReplayQuestions(replay.chat, replay.background);
    replay.questions = r.questions || [];
    replay.summary = r.summary || '';
    replay.note = r.note || '';
    replay.answers = replay.questions.map(() => null);
    renderReplayQuestions();
  } catch (e) {
    $('#rpOut').innerHTML = `<div class="card"><h3 class="result-bad">没能完成</h3>
      <p class="hint" style="margin-top:8px">${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false; btn.textContent = '出题';
  }
}

function renderReplayQuestions() {
  $('#rpOut').innerHTML = `
    ${replay.summary ? `<div class="card"><div class="label" style="color:var(--dim);font-size:.78rem">客观描述</div>
      <div style="margin-top:6px">${rich(replay.summary)}</div>
      ${replay.note ? `<p class="hint" style="margin-top:10px">${rich(replay.note)}</p>` : ''}</div>` : ''}
    ${replay.questions.map((q, qi) => `
      <div class="card">
        <div class="meta"><span class="tag">第 ${qi + 1} 题</span></div>
        <p style="font-size:.97rem">${esc(q.q)}</p>
        <div class="opts" id="rq${qi}">
          ${(q.options || []).map((o, oi) => `
            <button class="opt" data-oi="${oi}" onclick="pickReplay(${qi},${oi})">
              <span class="k">${'ABCD'[oi]}</span>${esc(o)}
            </button>`).join('')}
        </div>
      </div>`).join('')}
    <button class="primary" id="rvBtn" onclick="runReplayReveal()" disabled>答完全部题目后揭晓</button>
    <div id="rvOut"></div>`;
}

function pickReplay(qi, oi) {
  replay.answers[qi] = oi;
  document.querySelectorAll(`#rq${qi} .opt`).forEach((el) => {
    const isThis = Number(el.dataset.oi) === oi;
    el.classList.toggle('right', isThis);
    el.classList.toggle('dim', !isThis);
  });
  const done = replay.answers.every((a) => a !== null);
  const btn = $('#rvBtn');
  if (btn) { btn.disabled = !done; btn.textContent = done ? '揭晓' : `还有 ${replay.answers.filter((a) => a === null).length} 题没答`; }
}

async function runReplayReveal() {
  const btn = $('#rvBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>复盘中';
  const payload = replay.answers.map((a, i) => ({
    chosen: a === null ? '(未答)' : (replay.questions[i].options[a] || ''),
    correct: replay.questions[i].options[replay.questions[i].answer_index] || '',
  }));
  try {
    const r = await aiReplayReveal(replay.chat, payload);
    replay.reveal = r;
    renderReplayReveal(r);
    bump('interpret', 3); bump('respond', 2); markActivity(); save();
  } catch (e) {
    toast(e.message);
    btn.disabled = false; btn.textContent = '揭晓';
  }
}

function renderReplayReveal(res) {
  const correctCount = replay.answers.filter(
    (a, i) => a === replay.questions[i].answer_index).length;
  $('#rvOut').innerHTML = `
    <div class="card" style="margin-top:14px">
      <h2>你答对了 ${correctCount} / ${replay.questions.length}</h2>
      <p style="margin-top:8px">${esc(res.score_line || '')}</p>
    </div>
    ${replay.questions.map((q, i) => `
      <div class="card">
        <div class="meta"><span class="tag">第 ${i + 1} 题的答案解析</span></div>
        <p class="hint">正确答案：${esc('ABCD'[q.answer_index])} · ${esc(q.options[q.answer_index])}</p>
        <p style="margin-top:8px">${rich(q.why)}</p>
      </div>`).join('')}
    ${res.turn_point ? `<div class="card">
      <h3>分水岭</h3><p style="margin-top:8px">${esc(res.turn_point)}</p></div>` : ''}
    ${(res.readings || []).length ? `<div class="card">
      <h3>逐句解读</h3>
      ${res.readings.map((r) => `
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <div class="quote" style="font-size:1rem;margin-bottom:8px">「${rich(r.quote)}」</div>
          <div class="label">字面</div><div>${rich(r.face_value)}</div>
          <div class="label" style="margin-top:8px">另一种可能</div><div>${rich(r.possible)}</div>
          <div class="hint" style="margin-top:8px">线索：${rich(r.signals)} · 置信度 ${esc(r.confidence)}</div>
        </div>`).join('')}
    </div>` : ''}
    ${(res.your_part || []).length ? `<div class="card">
      <h3>你那几句实际发出了什么信号</h3>
      ${res.your_part.map((y) => `<div style="margin-top:10px">
        <div class="quote" style="font-size:1rem;margin-bottom:6px">「${rich(y.quote)}」</div>
        <div>${esc(y.effect)}</div></div>`).join('')}
    </div>` : ''}
    ${res.how_to_reply ? `<div class="card">
      <h3>现在该怎么回</h3>
      ${res.how_to_reply.situation ? `<div class="hint" style="margin-top:8px">${rich(res.how_to_reply.situation)}</div>` : ''}
      ${res.how_to_reply.say ? `<div style="margin-top:12px;padding:var(--sp-3);border-radius:var(--r-sm);
        background:var(--accent-bg);border:1px solid var(--accent-line)">
        <div class="label" style="color:var(--accent-fg)">可以这么回</div>
        <div style="margin-top:6px;font-size:var(--fs-md)">${rich(res.how_to_reply.say)}</div></div>` : ''}
      ${res.how_to_reply.why ? `<div style="margin-top:10px"><div class="label">为什么这么回</div>
        <div style="margin-top:4px">${rich(res.how_to_reply.why)}</div></div>` : ''}
      ${res.how_to_reply.avoid ? `<div style="margin-top:10px;padding:var(--sp-3);border-radius:var(--r-sm);
        background:var(--bad-bg);border:1px solid var(--bad-line)">
        <div class="label" style="color:var(--bad-fg)">千万别这么回</div>
        <div style="margin-top:6px">${rich(res.how_to_reply.avoid)}</div></div>` : ''}
      <p class="hint" style="margin-top:12px">这是<b>一个</b>可行的说法，不是标准答案。
        照着念会不像你——把人称、语气换成你自己的。</p>
    </div>` : ''}
    ${(res.branches || []).length ? `<div class="card">
      <h3>如果她下一步这么说</h3>
      <p class="hint" style="margin-top:6px">同一句之后可能往几个方向走，先想一遍，真遇上了就不慌。</p>
      ${res.branches.map((b, i) => `
        <div style="margin-top:14px;padding-top:14px;${i ? 'border-top:1px solid var(--line)' : ''}">
          <div class="quote" style="font-size:var(--fs-md);margin-bottom:8px">如果她说：「${rich(b.if_they_say)}」</div>
          <div class="label">那说明什么</div><div style="margin-top:4px">${rich(b.what_it_means)}</div>
          <div style="margin-top:10px;padding:var(--sp-3);border-radius:var(--r-sm);
            background:var(--good-bg);border:1px solid var(--good-line)">
            <div class="label" style="color:var(--good-fg)">你就这么回</div>
            <div style="margin-top:6px;font-size:var(--fs-md)">${rich(b.you_say)}</div></div>
          ${b.watch_out ? `<div class="hint" style="margin-top:8px">这里的坑：${rich(b.watch_out)}</div>` : ''}
        </div>`).join('')}
    </div>` : ''}
    ${(res.options || []).length ? `<div class="card">
      <h3>真要开口，可以往哪个方向</h3>
      ${res.options.map((o) => `<div style="margin-top:10px">
        <span class="tag type">${esc(o.move)}</span>
        <div style="margin-top:6px">${esc(o.direction)}</div></div>`).join('')}
      <p class="hint" style="margin-top:12px">给的是方向，不是逐字稿。照抄会显得不像你。</p>
    </div>` : ''}
    ${res.principle ? `<div class="card">
      <div class="label">这次最值得记住的一条</div>
      <div style="margin-top:6px">${rich(res.principle)}</div></div>` : ''}
    <div class="row"><button class="ghost" onclick="viewReplay()">再复盘一段</button></div>`;
  $('#rvBtn').remove();
}

/* ============================================================ 视图：心理学 */

function viewLearn() {
  const all = CONTENT.curriculum.lessons || [];
  const seriesList = ['全部', ...new Set(all.map((l) => l.series).filter(Boolean))];
  const lessons = all.filter((l) => lessonSeries === '全部' || l.series === lessonSeries);
  const LV = { A: '证据强', B: '框架有用', C: '流行但没通过验证' };
  const seriesNote = {
    关系心理学: '关系怎么运作：依恋、冲突、连接、阶段。',
    操控识解: '看清操控的机制和代价，也学会识别别人对你用。目标是「看得懂、防得住」，不是「照着做」。',
    证据纠错: '流传很广但没通过验证的理论——你到处都会遇到，得知道哪里站不住。',
  }[lessonSeries] || '';

  $('#view').innerHTML = `
    <div class="chips">${seriesList.map((s) => `
      <button class="chip-btn ${s === lessonSeries ? 'on' : ''}" onclick="setSeries('${s}')">${s}</button>`).join('')}</div>
    ${seriesNote ? `<p class="series-note">${esc(seriesNote)}</p>` : ''}
    ${lessons.map((l) => {
      const st = state.lessons[l.id] || {};
      return `<button class="lesson-item" onclick="openLesson('${l.id}')">
        <span>
          <span class="t">${rich(l.title)}</span>
          <span class="s">${esc(l.series || '')} · ${st.read ? '已读' : '未读'}${st.applyCorrect === true ? ' · 应用题答对' : st.applyCorrect === false ? ' · 应用题做错了' : ''}</span>
        </span>
        <span class="tag lv-${l.level}">${LV[l.level]}</span>
      </button>`;
    }).join('')}
    <p class="hint" style="margin-top:12px">
      标注「流行但没通过验证」的两条不要跳过——它们在网上到处都是，你得知道它们哪里站不住。
    </p>`;
}

function setSeries(s) {
  lessonSeries = s;
  viewLearn();
}

function openLesson(id) {
  const l = (CONTENT.curriculum.lessons || []).find((x) => x.id === id);
  if (!l) return;
  const LV = { A: '证据强', B: '框架有用，预测力有限', C: '流行但未通过验证' };
  const a = l.apply;
  const sheet = document.createElement('div');
  sheet.className = 'sheet open';
  sheet.innerHTML = `<div class="inner" onclick="event.stopPropagation()">
    <button class="ghost close" onclick="closeSheet()">关闭</button>
    <span class="tag dom">${esc(l.series || '')}</span>
    <span class="tag lv-${l.level}">${LV[l.level]}</span>
    <h2 style="margin:12px 0 14px">${rich(l.title)}</h2>
    <div class="reading">${rich(l.read)}</div>
    <div class="warnbox"><b>适用边界：</b>${rich(l.warn)}</div>
    <h3 style="margin:16px 0 10px">应用题</h3>
    <p style="font-size:.95rem">${esc(a.q)}</p>
    <div class="opts" id="la">
      ${a.options.map((o, i) => `
        <button class="opt" data-i="${i}" onclick="answerLesson('${l.id}',${i})">
          <span class="k">${'ABCD'[i]}</span>${esc(o)}
        </button>`).join('')}
    </div>
    <div id="lfb"></div>
  </div>`;
  sheet.addEventListener('click', closeSheet);
  document.body.appendChild(sheet);
  state.lessons[l.id] = Object.assign({ read: true }, state.lessons[l.id]);
  save();
}

function answerLesson(id, chosen) {
  const l = (CONTENT.curriculum.lessons || []).find((x) => x.id === id);
  const ok = chosen === l.apply.answer;
  document.querySelectorAll('#la .opt').forEach((el) => {
    const i = Number(el.dataset.i);
    el.disabled = true;
    if (i === l.apply.answer) el.classList.add('right');
    else if (i === chosen) el.classList.add('wrong');
    else el.classList.add('dim');
  });
  bumpDaily('lesson');
  $('#lfb').innerHTML = `<div class="fb">
      <h3 class="${ok ? 'result-good' : 'result-bad'}">${ok ? '正确' : '这也是最常见的错法'}</h3>
      <div class="block" style="margin-top:10px">
        <div class="label">为什么</div><div>${rich(l.apply.why)}</div></div>
    </div>`;
  state.lessons[id] = { read: true, applyCorrect: ok };
  bump('notice', ok ? 3 : 1);
  state.stats.answered++; if (ok) state.stats.correct++;
  markActivity(); save();
}


/* ---------------------------------------------------------- 「!」小弹窗
 *
 * 用户的要求：「有些解释的地方，能不写出来就不写出来，需要写出来，
 * 也可以弄个感叹号，我点击一下，它才会有一个小窗口弹出来，
 * 这在很多商业 APP 里都很常见。」
 *
 * 做法：正文只留**结论**，过程性的解释（为什么、另一种可能、依据）收进「!」。
 * 这样每一屏的字数降下来，需要的时候点一下还在——不是删掉，是折叠。
 *
 * 一条自我约束：**「要记住的原理」和「真要开口时」不进弹窗**。
 * 那两句是这个 App 的产品本身，藏起来等于没讲。收进去的只有「推导过程」。
 */
function popBtn(label, body, title) {
  if (!body) return '';
  // 内容放进 data 属性会有转义和长度问题，改用一份临时表，点击时按 id 取。
  const id = 'pop' + (++popSeq);
  POP_STORE[id] = { title: title || label, body: String(body) };
  return `<button class="pop-btn" onclick="openPop('${id}')" title="${esc(label)}">
    <span class="pop-i">!</span>${esc(label)}</button>`;
}

let popSeq = 0;
const POP_STORE = {};

function openPop(id) {
  const x = POP_STORE[id];
  if (!x) return;
  document.querySelectorAll('.pop-sheet').forEach((e) => e.remove());
  const el = document.createElement('div');
  el.className = 'pop-sheet';
  el.innerHTML = `<div class="pop-in">
    <div class="pop-h">${esc(x.title)}<button class="pop-x" onclick="closePop()">✕</button></div>
    <div class="pop-b">${rich(x.body)}</div>
  </div>`;
  el.addEventListener('click', (ev) => { if (ev.target === el) closePop(); });
  document.body.appendChild(el);
}

function closePop() {
  document.querySelectorAll('.pop-sheet').forEach((e) => e.remove());
}

/* 浮层里现在显示的是哪一块（'settings' | 'daily' | null）。
   为什么要有这个变量：**浮层不许叠浮层**。
   用户的原话是「一些窗口什么的，感觉设计的不是很好」。查资料时看到 Material 3
   对底部浮层的定义：它本身就是**最上层的模态**（和对话框同一层，z-index 1000），
   再在它上面叠一个浮层是明确的反模式——多步流程应该换成一个整屏目的地。
   我们这儿真实发生过的后果有两个：叠起来之后有两层遮罩（后面的内容看着更暗、
   但还能点），以及 closeSheet() 会**把所有浮层一起删掉**——于是"关掉每日计划"
   把下面那个设置面板也一起关了，用户得从头再点进来一次。
   现在改成：设置和每日计划是**同一个浮层里的两块内容**，中间有一个「← 返回设置」。 */
let sheetPanel = null;

/** 拿一个能往里写内容的浮层。已经有就复用，没有就新建。 */
function sheetHost() {
  let sh = document.querySelector('.sheet');
  if (!sh) {
    sh = document.createElement('div');
    sh.className = 'sheet open';
    sh.innerHTML = '<div class="inner" onclick="event.stopPropagation()"></div>';
    sh.addEventListener('click', closeSheet);
    document.body.appendChild(sh);
  } else {
    sh.querySelector('.inner').innerHTML = '';
  }
  return sh.querySelector('.inner');
}

/** 只把浮层拆掉，**不**重渲染当前页。
    页面级跳转（进对话历史、从历史接着聊、返回）之前必须先拆浮层：浮层是全屏的，
    新页面渲在它下面，"跳过去了"但一眼看不见，表现就是「点了没反应」。
    这跟「状态在、显示没了」是同一类坑——状态换了，屏幕没换。 */
function dropSheets() {
  sheetPanel = null;
  document.querySelectorAll('.sheet').forEach((s) => s.remove());
}

function closeSheet() {
  dropSheets();
  VIEWS[currentTab]();   // 回到当前所在的标签，不要跳走
}

/* ============================================================ 脑雾恢复 */

const FEELINGS = ['好一些了', '差不多', '还是不行'];
let fog = { mode: null, trigger: null, timer: null, cycles: 0, phase: 0 };
const BREATH_PHASES = [
  ['inhale', '吸气…', 4000],
  ['sip', '再补一小口', 1000],
  ['exhale', '慢慢呼出去…', 8000],
];
const BREATH_ROUNDS = 5;

function openFog(trigger) {
  fog = { mode: null, trigger: trigger || '手动', timer: null, cycles: 0, phase: 0 };
  let el = document.getElementById('fogSheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fogSheet';
    el.className = 'sheet open';
    el.addEventListener('click', closeFog);
    document.body.appendChild(el);
  }
  fogHome();
}

function closeFog() {
  clearTimeout(fog.timer);
  fog.timer = null;
  const el = document.getElementById('fogSheet');
  if (el) el.remove();
}

function fogShell(inner) {
  const el = document.getElementById('fogSheet');
  if (el) el.innerHTML = `<div class="inner" onclick="event.stopPropagation()">
    <button class="ghost" style="float:right" onclick="closeFog()">关闭</button>${inner}</div>`;
}

function fogHome() {
  const r = CONTENT.recovery || {};
  /* 从「今天」/闸门页的「脑雾通道」进来时，多给一条出口：今天就这样，记为没达标。
     这一条原来没有入口——fogPassDaily() 写好了、注释也写好了（"不是漏洞，
     是一条被记录的路"），但没有任何按钮指向它，于是那个按钮点进来只能做恢复练习，
     却永远记不下"今天我认了"这件事。自检里靠「死函数」检查抓到的是这一处。
     只在 trigger 是「每日计划」时出现：从卡片练到一半点「缓一下」进来的，
     不该顺手把今天判成未达标。 */
  const fromDaily = fog.trigger === '每日计划';
  fogShell(`
    <h2 style="margin:10px 0 8px">先停一下</h2>
    <p class="hint" style="margin-bottom:16px">${esc(r.intro || '')}</p>
    ${(r.modes || []).map((m) => `
      <button class="mode" onclick="fogMode('${m.id}')">
        <div class="mk">${esc(m.kicker)}</div>
        <div class="mn">${esc(m.name)}</div>
        <div class="mw">什么时候用：${esc(m.when)}</div>
      </button>`).join('')}
    <div class="row">
      <button class="ghost" onclick="showFogLog()">我的脑雾记录（${state.fog.length}）</button>
      <button class="ghost" onclick="showFogHonesty()">该说清的话</button>
    </div>
    ${fromDaily ? `<div class="row" style="margin-top:10px">
      <button class="plain" onclick="fogPassDaily()">今天就这样，记为没达标</button>
    </div>
    <p class="hint" style="margin:8px 0 0">
      不是失败：今天算没达标、明天回来就行。这条记录会留在你的数据里，不会被抹掉——
      下面那些恢复练习也照做不误，两件事不冲突。
    </p>` : ''}`);
}

function fogMode(id) {
  const m = (CONTENT.recovery.modes || []).find((x) => x.id === id);
  if (!m) return;
  fog.mode = id;
  if (id === 'breath') return fogBreath(m);

  const todos = m.steps.map((s, i) => `<li onclick="fogTick(this)" data-i="${i}">
      <span class="box">✓</span><span class="txt">${esc(s)}</span></li>`).join('');
  fogShell(`
    <div class="mk" style="color:#b98ce8;font-size:.72rem;font-weight:600;margin-top:10px">${esc(m.kicker)}</div>
    <h2 style="margin:6px 0 14px">${esc(m.name)}</h2>
    <ul class="steps" id="fogSteps">${todos}</ul>
    <div class="evbox"><b>为什么这么建议：</b>${esc(m.evidence)}</div>
    ${m.caution ? `<div class="warnbox" style="margin-top:12px"><b>要注意：</b>${esc(m.caution)}</div>` : ''}
    ${id === 'stop'
      ? `<div class="row"><button class="primary" onclick="fogFinish('stop','—')">好，今天就到这</button></div>`
      : `<button class="primary" style="margin-top:16px" onclick="fogDone()">做完了，接着问一下</button>`}`);
}

function fogTick(li) {
  li.classList.toggle('done');
}

/* ---- 呼吸节拍器 ---- */
function fogBreath(m) {
  fog.cycles = 0; fog.phase = 0;
  fogShell(`
    <div class="mk" style="color:#b98ce8;font-size:.72rem;font-weight:600;margin-top:10px">${esc(m.kicker)}</div>
    <h2 style="margin:6px 0 4px">${esc(m.name)}</h2>
    <div class="pacer-wrap">
      <div class="pacer" id="pacer"></div>
      <div class="pacer-cue" id="pacerCue">准备好了就开始</div>
      <div class="pacer-count" id="pacerCount">跟着圆圈：胀大时吸气，缩小时呼气</div>
    </div>
    <div class="row" style="justify-content:center">
      <button class="primary" id="breathGo" style="max-width:200px" onclick="startBreath()">开始（5 个呼吸）</button>
    </div>
    <div class="evbox" style="margin-top:16px"><b>为什么这么建议：</b>${esc(m.evidence)}</div>
    ${m.caution ? `<div class="warnbox" style="margin-top:12px"><b>要注意：</b>${esc(m.caution)}</div>` : ''}
    <div class="row"><button class="ghost" onclick="fogDone()">不做了，跳过</button></div>`);
}

function startBreath() {
  const go = document.getElementById('breathGo');
  if (go) go.remove();
  fog.cycles = 0; fog.phase = 0;
  stepBreath();
}

function stepBreath() {
  const [cls, cue, ms] = BREATH_PHASES[fog.phase];
  const p = document.getElementById('pacer');
  const c = document.getElementById('pacerCue');
  const n = document.getElementById('pacerCount');
  if (!p) return;
  p.className = 'pacer ' + cls;
  c.textContent = cue;
  n.textContent = `第 ${fog.cycles + 1} / ${BREATH_ROUNDS} 个呼吸 · 关键在呼气要长`;
  fog.timer = setTimeout(() => {
    fog.phase++;
    if (fog.phase >= BREATH_PHASES.length) {
      fog.phase = 0;
      fog.cycles++;
      if (fog.cycles >= BREATH_ROUNDS) { endBreath(); return; }
    }
    stepBreath();
  }, ms);
}

function endBreath() {
  clearTimeout(fog.timer);
  const c = document.getElementById('pacerCue');
  const n = document.getElementById('pacerCount');
  const p = document.getElementById('pacer');
  if (p) p.className = 'pacer';
  if (c) c.textContent = '做完了';
  if (n) n.textContent = '如果还想继续，可以再来一轮，或者直接接着问一下';
  const box = document.querySelector('#fogSheet .inner');
  if (box && !document.getElementById('breathAgain')) {
    const row = document.createElement('div');
    row.className = 'row';
    row.id = 'breathAgain';
    row.style.justifyContent = 'center';
    row.innerHTML = `<button class="primary" style="max-width:200px" onclick="startBreath()">再来一轮</button>
      <button class="ghost" onclick="fogDone()">就这样</button>`;
    box.appendChild(row);
  }
}

/* ---- 自评 & 收尾 ---- */
function fogDone() {
  clearTimeout(fog.timer);
  const m = (CONTENT.recovery.modes || []).find((x) => x.id === fog.mode) || {};
  fogShell(`
    <h2 style="margin:10px 0 6px">现在怎么样？</h2>
    <p class="hint">点一下就行，这一笔会存进你的记录里。</p>
    <div class="moodrow">
      ${FEELINGS.map((f) => `<button onclick="fogFinish('${fog.mode}','${f}')">${f}</button>`).join('')}
    </div>
    <div class="evbox" style="margin-top:16px"><b>${esc(m.name || '')}：</b>${esc(m.evidence || '')}</div>`);
}

function fogFinish(modeId, feeling) {
  state.fog.unshift({ ts: Date.now(), trigger: fog.trigger, mode: modeId, feeling });
  state.fog = state.fog.slice(0, 200);
  markActivity();                 // 照顾自己也该算今天的活动，不该断连击
  save();

  if (modeId === 'stop') {
    closeFog();
    $('#view').innerHTML = `
      <div class="card">
        <h2>今天就到这</h2>
        <p class="hint" style="margin-top:8px">
          进度都存好了，明天打开还在。停在这里不是中断，是正确的做法——
          微休息恢复不了高难度任务的状态，继续做只会把「学这个」和「难受」绑在一起。
        </p>
        <div class="row"><button class="ghost" onclick="goPracticeCards()">我还是想再看一张（只读）</button></div>
      </div>`;
    return;
  }

  const m = (CONTENT.recovery.modes || []).find((x) => x.id === modeId) || {};
  fogShell(`
    <h2 style="margin:10px 0 6px">记下了</h2>
    <p class="hint">刚才用「${esc(m.name || '')}」，现在${esc(feeling)}。</p>
    <div class="warnbox" style="margin-top:14px">
      <b>提醒：</b>缓过来一点也别马上上难度。微休息能改善的是状态，不是高难度任务的表现。
      接下来切到<b>只读模式</b>：只看已有卡片的一句话原理，不做判断题。
    </div>
    <div class="row" style="flex-direction:column;gap:8px">
      <button class="primary" onclick="fogContinueReadOnly()">好，只看不做题</button>
      <button class="ghost" onclick="closeFog()">不用了，我自己安排</button>
    </div>`);
}

function fogContinueReadOnly() {
  session.lowLoad = true;
  closeFog();
  goPracticeCards();
}

/* ---- 记录 & 说明 ---- */
function showFogLog() {
  const rows = state.fog.slice(0, 30);
  const modeName = (id) => ((CONTENT.recovery.modes || []).find((m) => m.id === id) || {}).name || id;
  const hours = {};
  state.fog.forEach((f) => {
    const h = new Date(f.ts).getHours();
    hours[h] = (hours[h] || 0) + 1;
  });
  const top = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 3);
  fogShell(`
    <h2 style="margin:10px 0 12px">我的脑雾记录</h2>
    ${state.fog.length === 0
      ? '<p class="hint">还没有记录。每次在「卡住了」里做完一步就会自动存一笔。</p>'
      : `
        <div class="evbox" style="margin-bottom:14px">
          <b>最常出现的时段：</b>${top.map(([h, n]) => `${h} 点（${n} 次）`).join('、')}
          <br><span class="hint">如果某个时段特别集中，先看那个时段的睡眠、吃饭和药物时间。</span>
        </div>
        ${rows.map((f) => `<div class="fogrow">
          <span class="l">${new Date(f.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <span>${esc(modeName(f.mode))} · ${esc(f.feeling)}</span>
        </div>`).join('')}`}
    <div class="row"><button class="ghost" onclick="showFogHonesty()">该说清的话</button>
      <button class="ghost" onclick="fogHome()">返回</button></div>`);
}

function showFogHonesty() {
  const h = (CONTENT.recovery || {}).honesty || {};
  fogShell(`
    <h2 style="margin:10px 0 12px">${esc(h.title || '')}</h2>
    <ul class="honesty">${(h.points || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <div class="row"><button class="ghost" onclick="fogHome()">返回</button></div>`);
}

/* ============================================================ 请求 & 导航 */

/* 这里原来有个 post(url, body) 助手，用来调 /api/ai/* 那三个服务端接口。
   那三个接口已经删掉了——提示词搬到前端、统一走 llmCall——所以它没有调用者了，
   就删掉。**不要再照着它写新的 AI 调用**：AI 一律走 llmCall（见 voice.js），
   它已经处理好了手机上的原生桥、电脑上的代理、404 回退和截断重试。 */

/* ====================================================== 这两个模块的提示词
 *
 * 从 server.py 搬过来的。原来它们只在服务端存在，而手机里没有服务端，
 * 于是「表达体检」和「真实复盘」在 APK 里是死的（点下去只得到一句
 * 「这是离线单文件版，不含 AI 功能」）。
 *
 * 现在提示词只在这里存一份，调用走 llmCall（原生桥 / 代理两条路自动选），
 * 所以手机和电脑行为一致、也只需要用户那一把密钥。
 * server.py 里那三个端点已经删掉，避免两处提示词将来各自漂移。
 */
const CHECKUP_SYSTEM = `你在做一次"表达体检"：用户会给你一句他准备发出去的话（可能还有场景），
你要从五个维度打分并解释，帮他自己判断这句话会不会让人觉得油、爹、越界或尴尬。

五个维度，每项 0-10 分（10 = 最健康，0 = 最严重）：
- canned 罐头度：10 分表示完全是就着此刻这个具体场景说的；0 分表示这是任何情况下都能套的预制话。
- overstep 越级度：10 分表示深度匹配当前关系阶段；0 分表示亲密/披露的深度远超关系阶段。
- narcissism 自恋度：10 分表示句子重心在对方或"我们"；0 分表示通篇是"我"。参考句中"我"字出现的密度。
- judge 评判度：10 分表示在了解而非评价；0 分表示在说教、下判断、给未经请求的建议。
- sexual 性暗示度：10 分表示没有性意味；0 分表示在不合适的阶段就带性暗示。

输出严格 JSON：
{
  "scores": {"canned": 0-10, "overstep": 0-10, "narcissism": 0-10, "judge": 0-10, "sexual": 0-10},
  "overall": "一句话总评，30 字以内，别客气但也别刻薄",
  "signals": [{"dim": "canned", "problem": "具体指出句子里哪个词造成的", "fix": "怎么改"}],
  "why_greasy": "如果确实油，说清是哪种油（罐头/越级/自恋/说教/性暗示），以及它为什么会让人不适；如果没问题就说没问题，不要硬找毛病",
  "revised": ["按当前场景改过的版本 1", "版本 2"],
  "principle": "这条能给用户的通用原理，一句话",
  "confidence": "高|中|低"
}
只输出 JSON。signals 最多 3 条，只写真正有问题的维度。`;

const REPLAY_Q_SYSTEM = `用户在复盘一段真实聊天记录。你的任务**不是**直接给答案，而是先出题让他自己判断，
这样才能训练他的判断力而不是依赖你。

根据聊天记录出 2-3 道题，考察：对方情绪在哪一句发生了转折、哪一句是整段对话的分水岭、
对方某句话的真实意图、用户某个回应的实际效果。

输出严格 JSON：
{
  "summary": "这段对话的客观描述，60 字以内，只描述事实不评判",
  "questions": [
    {
      "q": "题干",
      "options": ["选项A", "选项B", "选项C"],
      "answer_index": 0,
      "why": "为什么这个选项对，其余为什么错"
    }
  ],
  "note": "如果这段记录信息不足以判断，在这里说明还需要知道什么"
}
每道题 3-4 个选项。选项里必须至少有一个是"这就是字面意思，没有潜台词"。只输出 JSON。`;

const REPLAY_REVEAL_SYSTEM = `用户已经先自己答过一遍了，现在给他完整分析。顺序很重要：
先确认他答对/答错的地方，再给解读，最后才给可选的回应方向。

用户明确要求过这段输出要包含三件事：**把情况分析清楚**、**我该怎么回**、
**如果对面下一步这么说，我该怎么回**。所以下面的 how_to_reply 和 branches 是必给的，
不能省——他要的就是"现在能用的东西"，不是一份点评。

给回应时要守住这个 App 的底线：给**方向和一句可参考的说法**，不承诺「照念就有效」。
人的反应不是脚本能决定的，所以要写清楚"这么回的用意是什么"和"对方如果接不住怎么办"。

输出严格 JSON：
{
  "score_line": "他判断得怎么样，一句话，具体到哪题",
  "turn_point": "整段对话的分水岭是哪一句，以及为什么是它",
  "readings": [
    {"quote": "对方的原话", "face_value": "字面意思是什么",
     "possible": "另一种可能的解读", "confidence": "高|中|低",
     "signals": "支持或反对这个解读的具体线索"}
  ],
  "your_part": [{"quote": "用户的话", "effect": "这句话实际发出了什么信号"}],
  "how_to_reply": {
    "situation": "现在这个局面最要紧的是什么，两三句说清（对方处在什么状态、你手上有什么牌）",
    "say": "可以这么回：给一到两句具体的话，像人说的，不要模板腔",
    "why": "为什么这么回有效——说清它在回应对方的什么需要",
    "avoid": "千万别这么回：指出最容易犯的那个错，并说明为什么它会让事情变糟"
  },
  "branches": [
    {"if_they_say": "对方接下来可能说的一类话（给具体的一句示例）",
     "what_it_means": "如果她这么说，说明什么（诚实地给两三种可能）",
     "you_say": "那你就这么回（一到两句具体的）",
     "watch_out": "这里最容易踩的坑"}
  ],
  "options": [{"move": "承接情绪|核实歧义|回应需要|划清边界", "direction": "原则和方向，不是逐字模板"}],
  "principle": "这次复盘最值得记住的一条通用原理"
}
readings 最多 4 条，your_part 最多 3 条，options 最多 3 条。
branches 给 3-4 条，要覆盖**最可能出现的两三种走向**（含"她冷下去不回"这一种）。
如果这段记录已经结束、没有下一轮了，branches 就按"下次类似情形"来给。
只输出 JSON。`;

/* ---- 三次调用。都走 llmCall，所以手机（原生桥）和电脑（代理）同一条路。 ---- */

async function aiCheckup(text, context) {
  const ctx = (context || '').trim()
    || '（用户未提供场景，按常见恋爱初期场景谨慎评估，并在 confidence 里体现不确定性）';
  const user = `【这句话】\n${text}\n\n【场景】\n${ctx}`;
  // 体检是要打分的，温度压低一点，让同一句话两次的结果尽量可比。
  return await llmCall(
    [{ role: 'system', content: CHECKUP_SYSTEM }, { role: 'user', content: user }],
    { temperature: 0.3, maxTokens: 4000 });
}

async function aiReplayQuestions(chat, background) {
  let user = `【聊天记录】\n${chat}`;
  const extra = (background || '').trim();
  if (extra) user += `\n\n【背景补充】\n${extra}`;
  return await llmCall(
    [{ role: 'system', content: REPLAY_Q_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 4000 });
}

async function aiReplayReveal(chat, answers) {
  const given = (answers || []).map((a, i) =>
    `第${i + 1}题 他选了：${a.chosen || '(未答)'}；正确答案是：${a.correct || ''}`).join('\n')
    || '（用户跳过了前面的题）';
  const user = `【聊天记录】\n${chat}\n\n【他的作答情况】\n${given}`;
  return await llmCall(
    [{ role: 'system', content: REPLAY_REVEAL_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 5000 });
}

/* ======================================================== 视图：阶段评估 */


function renderStages() {
  const defs = stageDefs();
  const cur = currentStage();
  const data = CONTENT.stages || {};
  if (!defs.length) {
    $('#view').innerHTML = '<div class="card"><h2>阶段评估</h2><p class="hint">内容还没加载。</p></div>';
    return;
  }
  const def = cur.def;
  const sp = cur.snap.biasSplit;

  const dpv = dailyProgress();
  $('#view').innerHTML = `
    <div class="card daily-card ${dpv.met ? 'daily-met' : ''}">
      <div class="meta"><span class="tag dom">每日计划</span>
        <span class="tag">${dpv.met ? '✓ 已达标' : '还没达标'}</span></div>
      <div class="tbar" style="margin:11px 0 9px"><i style="width:${dpv.pct}%"></i></div>
      <div class="daily-line">
        今天：${dpv.cards}/${dpv.tg.cards} 张卡片（判对才算） · ${dpv.lessons}/${dpv.tg.lessons} 条微课
        ${dpv.extra ? ` · <b>加练 ${dpv.extra}</b>` : ''}
      </div>
      <div class="row">
        ${dpv.met
          ? `<button class="ghost" onclick="goPracticeCards()">加练一会儿</button>`
          : `<button class="primary" onclick="closeGate();goPracticeCards()">现在做</button>`}
        <button class="plain" onclick="openDailySettings()">设置</button>
      </div>
    </div>

    <div class="card stage-head">
      <div class="meta">
        <span class="tag dom">第 ${def.id} 关</span>
        <span class="tag">${esc(def.sub)}</span>
      </div>
      <h2>${esc(def.name)}</h2>
      <p class="stage-cap">${esc(def.capability)}</p>
      <p class="hint">${rich(def.why)}</p>
    </div>

    ${def.gate.type === 'streak' ? `<div class="card">
      <h3>这一关没有通过条件</h3>
      <p class="hint" style="margin-top:8px">上面每一关都能靠集中练习在几周内达到，而它们描述的是倾向，不是永久状态。压力上来、关系变长、生活变忙之后，全部会退回去。所以这里看的是频率，不是高度。</p>
      <div class="score-row" style="margin-top:12px">
        <div><b>${state.streak.count || 0}</b><span>连续天数</span></div>
        <div><b>${state.plans.length}</b><span>写过的预案</span></div>
      </div>
    </div>` : `
    <div class="card">
      <h3>还差什么</h3>
      <div class="gate-list">
        ${cur.gate.parts.map((p) => `
          <div class="gate-row ${p.ok ? 'ok' : ''}">
            <span class="gate-mark">${p.ok ? '✓' : '·'}</span>
            <div class="gate-body">
              <div class="gate-label">${esc(p.label)}</div>
              ${p.need != null ? `<div class="tbar" style="margin-top:6px"><i style="width:${Math.min(100, Math.round((p.have || 0) / p.need * 100))}%"></i></div>` : ''}
              ${p.text || p.need != null ? `<div class="gate-num">${p.text || `${p.have || 0} / ${p.need}`}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
      <p class="hint" style="margin-top:12px">${esc(def.gateText)}</p>
    </div>`}

    ${identityCard(cur)}

    ${sp && sp.n >= 6 ? `<div class="card">
      <h3>纵向比对</h3>
      <p class="hint" style="margin-top:8px">这是这个 App 里唯一一个真正的进步指标。命中率受题目难度影响，偏向不受——偏向才是你自己的。</p>
      <div class="score-row" style="margin-top:12px">
        <div><b>${Math.round(sp.earlyShare * 100)}%</b><span>最初的「${esc(sp.topType)}」占比</span></div>
        <div><b>${Math.round(sp.lateShare * 100)}%</b><span>最近的占比</span></div>
        <div><b>${sp.drop >= 0 ? '↓' : '↑'}${Math.abs(Math.round(sp.drop * 100))}%</b><span>变化</span></div>
      </div>
      <p class="hint">对比的是最初 ${sp.k} 次和最近 ${sp.k} 次误读（累计 ${sp.n} 次）。样本还小的时候这个数会抖，看方向就行。</p>
    </div>` : ''}

    <div class="card">
      <h3>全部关卡</h3>
      <div class="stage-list">
        ${defs.map((s) => {
          const done = s.id <= cur.passed;
          const here = s.id === def.id;
          return `<div class="stage-row ${done ? 'done' : ''} ${here ? 'here' : ''}">
            <span class="stage-n">${s.id}</span>
            <div>
              <div class="stage-name">${esc(s.name)}${here ? '<em>当前</em>' : ''}</div>
              <div class="stage-sub">${esc(s.capability)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <p class="hint">${state.boundarySeen
        ? '你看过「这个工具的天花板」了。里面那四条它测不到的东西，比它能测的那四条重要——想再看一遍随时点。'
        : '这个 App 能量化什么、量不到什么，写在下面。建议现在就看一遍，不要等通关。'}</p>
      <div class="row"><button class="ghost" onclick="showBoundary()">${state.boundarySeen
        ? '再看一遍天花板' : '看这个工具的天花板'}</button></div>
    </div>`;
}

/* ------------------------------------------------------------ 身份陈述
   用户要的是「被告诉我是好男人，我就会往那个方向长」。这个直觉对了一半：
   身份层面的改变确实比行为层面强，但**被告知**这个版本有反效果记录——
   写自己正面道德特质的人随后捐钱最少（Sachdeva 等 2009），
   回想自己善行的人随后作弊更多（Jordan 等）。这就是道德许可：
   一个好身份被当成已完成的事实，会把动机提前兑现掉。
   所以这里换个来源：不由 App 下结论，只把你自己做出的事实摆出来，让你自己写。
   形式强制成条件式，因为「我是个好人」是一个可以放下的结论，
   「有人倒苦水时我会先接住」是一个还在生效的标准。 */
function identityCard(cur) {
  const idn = (CONTENT.stages || {}).identity;
  // 门槛是「做完摸底」，不是「过了第几关」：身份陈述的原料是你自己的行为记录，
  // 基线一出来就有原料了。反过来，一条证据都没有的时候就让你写，
  // 写的必然是「我是个好人」那种结论式——那正是这个功能要躲的坑。
  if (!idn || cur.snap.answered < 20) return '';
  const mine = state.identities || [];
  const ev = evidenceLines(cur.snap);
  return `<div class="card">
    <h3>${rich(idn.title)}</h3>
    <div class="block">
      <div class="label">你实际做出来的事</div>
      ${ev.map((e) => `<div class="ev-line">${esc(e)}</div>`).join('')}
    </div>
    <p class="hint" style="margin-top:10px">${esc(idn.prompt)}</p>
    <div class="plan-in" style="margin-top:10px">
      <input id="idnIn" type="text" placeholder="例如：有人跟我倒苦水的时候，我会先……" onkeydown="if(event.key==='Enter')saveIdentity()">
    </div>
    <div id="idnMsg" class="plan-msg"></div>
    <button class="ghost" onclick="saveIdentity()">存下来</button>
    ${mine.length ? `<div class="idn-list">
      ${mine.map((x) => `<div class="idn-item">
        <div>${rich(x.text)}</div>
        <div class="hint">${fmtDay(x.ts)}<button class="plain tiny" onclick="dropIdentity('${x.id}')">删掉</button></div>
      </div>`).join('')}
    </div>` : ''}
    <details class="diag-more" style="margin-top:14px">
      <summary>为什么要求写成「在……的时候，我会……」这种句式</summary>
      <div class="diag-why" style="margin-top:8px">${rich(idn.why_this_form)}</div>
      <div class="diag-why" style="margin-top:8px">${rich(idn.why_evidence)}</div>
      <div class="diag-fix" style="margin-top:10px"><b>所以这里只做一件事：</b>${rich(idn.rule)}</div>
    </details>
  </div>`;
}

/** 把用户自己的行为记录摆出来——写身份陈述的原料必须是事实，不是鼓励。 */
function evidenceLines(snap) {
  const out = [];
  const acc = snap.answered ? Math.round(snap.correct / snap.answered * 100) : 0;
  if (snap.answered) out.push(`做了 ${snap.answered} 次判断，命中率 ${acc}%`);
  const sp = snap.biasSplit;
  if (sp && sp.drop > 0.1) {
    out.push(`你最常犯的「${sp.topType}」，占比从 ${Math.round(sp.earlyShare * 100)}% 降到 ${Math.round(sp.lateShare * 100)}%`);
  } else if (sp) {
    out.push(`你最常犯的误读是「${sp.topType}」，目前占 ${Math.round(sp.lateShare * 100)}%（还没明显下降）`);
  }
  if (snap.plans.length) {
    const reh = snap.plans.reduce((a, b) => a + (b.rehearsed || 0), 0);
    out.push(`写了 ${snap.plans.length} 条预案，回头复看 ${reh} 次`);
  }
  if (out.length < 2) out.push('记录还少，先多做几关——这份原料得靠你自己攒');
  return out;
}

function saveIdentity() {
  const el = document.getElementById('idnIn');
  const msg = document.getElementById('idnMsg');
  if (!el || !msg) return;
  const t = el.value.trim();
  const idn = CONTENT.stages.identity;
  const bad = (idn.examples_bad || []).some((b) => t === b);
  if (t.length < 8) {
    msg.className = 'plan-msg bad';
    msg.textContent = '太短了。要说清什么情况下、你会做什么。';
    return;
  }
  // 必须是条件式：出现「的时候」「时，」这类情境词，且不是「我是个…」这类结论式
  const conditional = /(的时候|时，|时我|每当|一旦|遇到|如果)/.test(t);
  const concluded = /^我(是|就是|是个|属于)/.test(t);
  if (concluded && !conditional) {
    msg.className = 'plan-msg bad';
    msg.innerHTML = '这是结论式，不是身份陈述。「我是个好男人」是一个可以放下的事实，'
      + '说完动机就兑现完了（这叫道德许可，有实验记录）。改成<b>在什么情况下、你会做什么</b>。';
    el.focus();
    return;
  }
  if (!conditional) {
    msg.className = 'plan-msg bad';
    msg.textContent = '没看出情境。写成「在……的时候，我会……」——标准要一直有效，就不能只是一句评价。';
    el.focus();
    return;
  }
  state.identities = state.identities || [];
  state.identities.push({ id: 'i' + Date.now(), text: t, ts: Date.now(), stage: currentStage().passed });
  save();
  // 存下去之后整个视图会重渲染，行内提示会被冲掉，所以用 toast 给反馈
  toast('存下了。这句是你自己写的，不是这个 App 给你的评价。');
  renderStages();
}

function dropIdentity(id) {
  state.identities = (state.identities || []).filter((x) => x.id !== id);
  save();
  renderStages();
}


/* ------------------------------------------------------- 天花板声明 */
function showBoundary() {
  const b = (CONTENT.stages || {}).boundary;
  if (!b) return;
  state.boundarySeen = true;
  save();
  const sh = document.createElement('div');
  sh.className = 'sheet open';
  sh.innerHTML = `
    <div class="inner" onclick="event.stopPropagation()">
      <button class="ghost" style="float:right" onclick="closeSheet()">关闭</button>
      <h2>${rich(b.title)}</h2>
      <p class="hint" style="margin-top:10px">${esc(b.lead)}</p>
      <div class="block"><div class="label">这个 App 测到了</div>
        <ul class="honesty">${b.measured.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="block"><div class="label">它测不到</div>
        <ul class="honesty">${b.not_measured.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <p style="margin-top:12px">${esc(b.closing)}</p>
      <div class="warnbox" style="margin-top:14px">${esc(b.on_identity)}</div>
      <div class="warnbox" style="margin-top:10px">${esc(b.warning)}</div>
      <div class="row"><button class="primary" onclick="closeSheet()">知道了</button></div>
    </div>`;
  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
}

/* ======================================================== 每日计划
 *
 * 规则来自两条实证结论，改这里之前先看 data/stages.json 的 daily.why：
 *   1. Lally 等（2010，96 人 12 周）：错过一次机会对习惯养成没有实质影响，
 *      但累积的错过会显著降低最终达到的自动化水平。
 *   2. 真正杀死习惯的不是漏掉那次，是「反正已经破了」的连锁反应
 *      （what-the-hell effect）。所以对策是 Never Miss Twice。
 * 所以：跳过只允许一次，且一次不算失败。达标线刻意定得很低。
 */

function dailyCfg() {
  return (CONTENT.stages && CONTENT.stages.daily) || {};
}

function dailyTargets() {
  const t = dailyCfg().targets || {};
  return { cards: t.cards || 4, lessons: t.lessons || 1 };
}

/* ---------------------------------------------------------- 今日任务的呈现
 *
 * 用户的原话：「每日任务的这个界面，感觉不是很明显，就是我每天要完成的任务。」
 *
 * 原来那块是一个**仪表盘**：三个数字方块写着 0 / 需 4，配一条进度条和一句
 * 「还差 5 步」。问题有三个：
 *   1. 「需 4」要读的人自己做减法，才知道还差几张；
 *   2. 卡片和微课是两件不同的动作，加起来的「5 步」这个数字没法执行；
 *   3. 「加练」跟两个必做项并排摆着、字号一样，看起来也像任务。
 * 所以改成一张**清单**：用一句人话写出今天要做什么，每一项单独一行带勾选状态，
 * 必做和可选分开，按钮直接点名下一件具体的事。
 */

/** 「今天要做：4 张卡片 + 1 条微课」——这句是这次改动的核心 */
function todayWhat(p, cfg) {
  const L = cfg.labels || {};
  if (p.met) return `今天的量：${p.tg.cards} ${L.cards || '张卡片'} + ${p.tg.lessons} ${L.lessons || '条微课'}，已经做完了。`;
  const parts = [];
  const remC = Math.max(0, p.tg.cards - p.cards);
  const remL = Math.max(0, p.tg.lessons - p.lessons);
  if (remC) parts.push(`${remC} ${L.cards || '张卡片'}`);
  if (remL) parts.push(`${remL} ${L.lessons || '条微课'}`);
  /* 判对才算——这条规则要写在**动手之前**能看到的地方，不能等他答了几张
     发现数字不动才知道。顺手把「答了几张」也说出来，否则一个不动的数字
     看起来就是坏了。 */
  const tail = p.tried > p.cards
    ? `卡片要判对才算数：今天你答了 ${p.tried} 张，判对 ${p.cards} 张。`
    : '卡片要判对才算数。';
  return `还差：${parts.join(' + ')}。${tail}`;
}

/** 一行任务。pct 到了就打勾并把文字压暗——状态一眼可见，不用算。 */
function todoRow(name, have, need, unit, met) {
  const ok = have >= need;
  return `<div class="todo ${ok ? 'todo-done' : ''}">
    <span class="todo-mark">${ok ? '✓' : '○'}</span>
    <span class="todo-name">${esc(name)}</span>
    <span class="todo-num">${Math.min(have, need)} / ${need} <i>${esc(unit)}</i></span>
  </div>`;
}

/** 按钮直接说下一步做什么，而不是「还差 N 步」——后者是个数字，不是个动作。 */
function nextAction(p) {
  if (p.met) return { label: '加练一会儿', fn: "goPracticeCards()" };
  if (p.cards < p.tg.cards) {
    const rem = p.tg.cards - p.cards;
    return { label: `开始做卡片（还差 ${rem} 张判对）`, fn: "closeGate();goPracticeCards()" };
  }
  const rem = p.tg.lessons - p.lessons;
  return { label: `去看微课（还差 ${rem} 条）`, fn: "closeGate();setPracticeSubview('learn')" };
}

/** 跨天了就重置今天的进度。每次读写 daily 之前都要先过一遍。 */
function rollDaily() {
  const t = todayStr();
  const d = state.daily || {};
  if (d.date !== t) {
    // 昨天的结果入档（只有真有活动才记，避免打开一次就留一条空记录）
    if (d.date && (d.cards || d.lessons || d.extra || d.tried)) {
      state.dailyLog = state.dailyLog || [];
      state.dailyLog.push({
        date: d.date, cards: d.cards || 0, lessons: d.lessons || 0,
        extra: d.extra || 0, tried: d.tried || 0,
        met: !!d.met, skipped: !!d.skipped, fogPass: !!d.fogPass,
      });
      if (state.dailyLog.length > 400) state.dailyLog = state.dailyLog.slice(-400);
    }
    state.daily = {
      date: t, cards: 0, lessons: 0, extra: 0, tried: 0,
      skipped: false, met: false, fogPass: false, metAt: null,
    };
  }
}

function dailyProgress() {
  rollDaily();
  const tg = dailyTargets();
  const d = state.daily;
  const cards = Math.min(d.cards || 0, tg.cards);
  const lessons = Math.min(d.lessons || 0, tg.lessons);
  const done = cards + lessons;
  const need = tg.cards + tg.lessons;
  return {
    d, tg,
    cards: d.cards || 0, lessons: d.lessons || 0, extra: d.extra || 0,
    /* tried = 今天答了几张（含没判对的）。达标只看 cards，tried 是给界面
       说清楚用的：「答了 6 张、判对 3 张」比一个不动的 3/4 诚实得多。 */
    tried: d.tried || 0,
    done: Math.min(done, need), need,
    pct: need ? Math.min(100, Math.round(done / need * 100)) : 100,
    met: !!d.met,
    skipped: !!d.skipped,
    // 还没达标、且今天还没用过跳过 → 可以跳
    canSkip: !d.met && !d.skipped,
  };
}

function markDailyMet() {
  rollDaily();
  if (state.daily.met) return;
  state.daily.met = true;
  state.daily.metAt = Date.now();
  save();
  toast('今天达标了。就这么点量，明天见。');
  renderHeader();
  // 达标之后解除护城河，游戏随便打
  syncGate();
}

/**
 * 记录一次练习。kind 是 'card' | 'lesson'。达标线之外算加练。
 *
 * `counted` 是「这一次判对了没有」。**只有判对的才计入达标。**
 *
 * 为什么要有这个参数（2.36 改的，之前是「答了就计数」）：
 *   原来的写法是 `rate(...); bumpDaily('card')`，无条件加一。后果是
 *   **连点四张、全错的也达标、也解锁游戏**——护城河形同虚设。
 *   而这和 App 自己的原则是矛盾的：关卡的通过条件用的是「判局准确率」，
 *   文档里也写着「做得多不等于判得准，而判准是后面所有动作的前提」。
 *   同一个 App 两套标准，宽松的那套正好落在最该严的地方（护城河）。
 *
 * 判据：读局卡看**读局那一步判对没有**（和关卡同一个标准）；没有读局
 * 步骤的卡，看动作有没有选到最好的那个。`half`（也算说得通，但不是首选）
 * 不算——达标要的是判准，不是判得差不多。
 *
 * `tried` 无论对错都加一，**只用来在界面上说清楚**（「答了 6 张、判对 3 张」）。
 * 不记的话，用户看到一个不动的数字只会以为 App 坏了——规则变了就必须说出来，
 * 这是这个项目一直在守的规矩。
 */
function bumpDaily(kind, counted = true) {
  rollDaily();
  const tg = dailyTargets();
  const d = state.daily;
  if (kind === 'card') {
    d.tried = (d.tried || 0) + 1;
    if (!counted) {
      save();
      syncGate();     // 没判对：推一次状态，但不推进达标
      renderHeader();
      return;
    }
    if ((d.cards || 0) >= tg.cards) d.extra = (d.extra || 0) + 1;
    d.cards = (d.cards || 0) + 1;
  } else if (kind === 'lesson') {
    d.lessons = (d.lessons || 0) + 1;
  } else if (kind === 'extra') {
    // 显式的加练分支。原来没有：写成 bumpDaily('extra') 时它走不进任何分支，
    // 静默什么都不做——加练计数永远是 0，而调用方以为记上了。
    d.extra = (d.extra || 0) + 1;
  }
  if (!d.met && (d.cards >= tg.cards) && (d.lessons >= tg.lessons)) {
    markDailyMet();
  } else {
    save();
    syncGate();   // 未达标时也要推一次：目标应用列表可能刚改过
  }
  renderHeader();
}

function skipDaily() {
  rollDaily();
  if (!dailyProgress().canSkip) return;
  state.daily.skipped = true;
  state.daily.skippedAt = Date.now();
  save();
  toast('今天跳过了一次。第二次打开就没有跳过按钮了。');
  closeGate();
}

/** 脑雾通道：不是漏洞，是一条被记录的路。
 *  这个 App 的既有原则是「降负荷」而不是「忍着做完」，所以脑雾真的上来时
 *  必须留出口。但走了这条路今天记未达标——诚实，也不至于连续打断两天。 */
function fogPassDaily() {
  rollDaily();
  state.daily.fogPass = true;
  state.daily.skipped = true;
  save();
  closeFog();
  closeGate();
  toast('走脑雾通道了。今天记为没达标，不是失败——明天回来就行。');
}

/* ---------------------------------------------------------- 护城河
 * 「打游戏之前先完成」这件事的证据很具体（Grüning、Riedel & Lorenz-Spreen 2023，
 * PNAS，n=280，六周）：插入一个摩擦延迟，并且**给一个明确的放弃选项**，
 * 能让目标应用的打开次数下降 57%。而且预注册实验（n=500）发现
 * **单纯给提示语是无效的**——有效的是摩擦 + 那个放弃选项。
 * 所以这里的闸门必须是「要动手才能过」，不能只是一句劝说。 */

/** 把「是否武装闸门」和「目标应用列表」推给原生。
 *  由 JS 算达标、原生只负责执行——这样判定逻辑只有一份，不会两边漂移。 */
function syncGate() {
  const g = state.gate || {};
  const arm = !!g.enabled && !dailyProgress().met;
  g.armed = arm;
  state.gate = g;
  if (window.EQNative && EQNative.setGate) {
    try {
      const dp = dailyProgress();
      // 进度文案和「还能不能跳」都推给原生：浮层是在目标应用露头那一帧弹出来的，
      // 那时来不及回调网页问一遍，所以必须提前落盘在原生那边。
      const summary = dp.met
        ? '今天已达标。'
        : `今天的量很小：还差 ${dp.need - dp.done} 步（卡片判对 ${dp.cards}/${dp.tg.cards} · 微课 ${dp.lessons}/${dp.tg.lessons}）。`
          + '卡片要判对才算——点过去不算。';
      EQNative.setGate(arm ? 1 : 0, JSON.stringify(g.packages || []),
        summary, dp.canSkip ? 1 : 0);
    } catch (e) { /* 非 Android 环境，忽略 */ }
  }
  if (window.EQNative && EQNative.scheduleReminder) {
    try {
      const r = state.reminder || {};
      EQNative.scheduleReminder(r.enabled ? 1 : 0, r.hour || 20, r.minute || 0);
    } catch (e) { /* 同上 */ }
  }
  // 深度拦截开关也落盘到原生：浮层和杀进程都在 GateService 里跑，
  // 那个进程可能压根没有网页在场。
  if (window.EQNative && EQNative.setDeepBlock) {
    try { EQNative.setDeepBlock(g.deepBlock ? 1 : 0); } catch (e) { /* 同上 */ }
  }
  save(false);
}

/* 原生在「目标应用被打开」时调这个——闸门必然强制显示，没有跳过按钮。
   这是整条链路上最关键的一次调用：从这里进来的用户绕不过去。 */
window.__gateKick = function () {
  const dp = dailyProgress();
  if (dp.met) return;           // 已达标就别拦了
  openGate(true);
};

/* 通知权限授权结果回来之后刷新设置页（否则会一直显示「还没给」） */
window.__onPerm = function (which, granted) {
  if (which === 'notif') {
    toast(granted ? '通知权限已开' : '没给通知权限，提醒发不出来');
    if (document.querySelector('.sheet')) openDailySettings();   // 就地在浮层里刷新
    return;
  }
  if (which === 'storage') {
    toast(granted ? '存储权限已开，可以备份了' : '没给存储权限，备份写不进公共目录');
    if (document.querySelector('.sheet')) openDailySettings();   // 就地在浮层里刷新
    return;
  }
  /* 原来这里还有一个 'mic' 分支（麦克风权限），2.31 把语音输入整块删掉之后
     连同授权申请一起删了——App 现在不再申请 RECORD_AUDIO。 */
};

/* ---------------------------------------------------------- 闸门界面 */
let gateForced = false;   // true = 由原生在打开目标应用时拉起，不给跳过

function openGate(forced) {
  if (document.querySelector('.gate')) return;
  gateForced = !!forced;
  const p = dailyProgress();
  const cfg = dailyCfg();
  const sr = cfg.skipRule || {};
  const el = document.createElement('div');
  el.className = 'gate';
  el.innerHTML = `
    <div class="gate-in">
      <div class="gate-top">
        <div class="meta"><span class="tag dom">每日计划</span>
          <span class="tag">${p.met ? '已达标' : '还没达标'}</span></div>
        <h2>${forced ? '先做完今天的量，再打开这个' : '今天的量很小'}</h2>
      </div>
      <div class="card">
        <div class="tbar" style="margin-bottom:12px"><i style="width:${p.pct}%"></i></div>
        <div class="score-row">
          <div><b>${p.cards}</b><span>${esc((cfg.labels || {}).cards || '张卡片')}（需 ${p.tg.cards}）</span></div>
          <div><b>${p.lessons}</b><span>${esc((cfg.labels || {}).lessons || '条微课')}（需 ${p.tg.lessons}）</span></div>
          <div><b>${p.extra}</b><span>加练</span></div>
        </div>
        <p class="hint" style="margin-top:12px">${rich(cfg.why || '')}</p>
        <div class="row">
          <button class="primary" onclick="gotoDailyWork()">现在做（${p.need - p.done} 步）</button>
        </div>
        ${p.canSkip && !forced ? `
          <div class="row"><button class="ghost" onclick="skipDaily()">今天先跳过</button></div>
          <p class="hint">${esc(sr.once || '')}</p>` : ''}
        ${!p.canSkip && !p.met && !p.d.skipped ? '' : ''}
        ${p.skipped && !p.met ? `<div class="warnbox" style="margin-top:12px">
          ${esc(sr.used || '')}
        </div>` : ''}
        <p class="hint" style="margin-top:10px">${esc(sr.fog || '')}</p>
        ${p.skipped && !p.met ? `<div class="row"><button class="ghost" onclick="closeGate();openFog('每日计划')">脑雾通道</button></div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(el);
}

function closeGate() {
  const el = document.querySelector('.gate');
  if (el) el.remove();
}

function gotoDailyWork() {
  closeGate();
  goPracticeCards();
}

/* ------------------------------------------------------- 每日设置面板
 * 目标应用列表要用户自己填包名，因为「打游戏」这件事没法自动猜。
 * 提供 adb 命令和几个常见游戏包名做示例，但默认留空——
 * 猜错包名会导致闸门永远不触发，而用户会以为功能坏了。 */
function openDailySettings() {
  const r = state.reminder || { hour: 20, minute: 0, enabled: true };
  const g = state.gate || { enabled: false, packages: [] };
  // 调用原生桥一律走 EQNative.xxx 这个写法，不要用局部别名（比如 const nat = ...）。
  // 原因：tools/test_bridge.js 靠这个字面量做静态交叉检查，把「网页调了桥里不存在的方法」
  // 这类错误挡在构建之前——而这类错误只在真机上炸（"httpPost is not a function"），
  // 浏览器里永远发现不了。约定统一，检查才可能不漏。
  const hasAcc = window.EQNative && EQNative.hasAccessibility
    ? EQNative.hasAccessibility() : false;
  const hasOv = window.EQNative && EQNative.hasOverlayPermission
    ? EQNative.hasOverlayPermission() : false;
  const hasNotif = window.EQNative && EQNative.hasNotifPermission
    ? EQNative.hasNotifPermission() : false;

  // 防掉线的状态每次都跟原生要一遍，不用缓存里的那份。
  // 理由和上面 hasAcc / hasOv 一样：这个面板的职责就是「现在到底什么状态」，
  // 拿上次渲染时存的旧值去说现在的事，正是要避免的那种假状态。
  const w = refreshGateWatch();

  // 深度拦截的状态要显示成三态，不能是布尔：
  // 「探测过、root 可用」「探测过、root 不可用」「还没探测」是三件不同的事，
  // 压成两态就会出现「未知」被显示成「不可用」这种误报。
  const rootTxt = !window.EQNative
    ? '只在 Android App 里可用。'
    : (!g.rootKnown
      ? '还没检测过。点下面的按钮探一次——<b>会弹 root 授权框，那是正常的</b>。'
      : (g.rootOk
        ? (g.deepBlock
          ? '<b>root 可用，深度拦截已开启</b>——目标应用启动后会被直接杀掉。'
          : 'root 可用，深度拦截还没开。')
        : '<b>root 不可用</b>——打开也不会生效，拦截只能退回成推浮层。'));

  // 防掉线的状态。三态，规矩和上面两条一样：不许把「不知道」说成「没有」。
  // 最要命的那一态是「开关开着、但它没在跑」——那正是「以为有保护、其实没有」，
  // 必须写在脸上，不能只显示一个「已开启」。
  let watchTxt;
  if (!window.EQNative || !EQNative.gateWatchStatus) {
    watchTxt = '只在 Android App 里可用。';
  } else if (!w.want) {
    watchTxt = '没开。掉了就得自己回系统设置里重开一次无障碍。';
  } else if (w.running) {
    watchTxt = `<b>在跑</b>（${w.ago} 秒前还有心跳）——闸门被系统关掉会自动装回来。`;
  } else {
    watchTxt = '<b>开关是开的，可它没在跑</b>，所以闸门还是会掉。'
      + '多半是 root 被拒了或者 root 没了；重新检测一次，不行就先关掉它——'
      + '留着一个「开着但没用」的开关比没有更糟。'
      + `（读到的心跳：${w.ago < 0 ? '没有' : w.ago + ' 秒前' }）`;
  }

  // 备份状态：三态，同样不许把「不知道」说成「没有」或「好着呢」。
  // 真实状态来自原生读回文件的结果，不是来自「我们写过一次」这个记忆。
  let backupTxt;
  if (!backupAvailable()) {
    backupTxt = '只在 Android App 里可用。';
  } else {
    let st = {};
    try { st = JSON.parse(EQNative.backupStatus() || '{}'); } catch (e) { st = {}; }
    const when = state.backup && state.backup.at
      ? new Date(state.backup.at).toLocaleString('zh-CN', { hour12: false })
      : null;
    if (st.needsPerm) {
      backupTxt = '旧版系统（Android 9 及以下）要存储权限才能写公共目录。'
        + '<div class="row" style="margin-top:8px">'
        + '<button class="ghost" onclick="askBackupPerm()">申请存储权限</button></div>';
    } else if (st.ok) {
      backupTxt = `已有备份：<b>${esc(st.where || '')}${esc(st.name || '')}</b>`
        + `（${st.bytes} 字节）`
        + (when ? `<br>最近一次写入：${esc(when)}` : '');
    } else {
      // 写过了但读不回来——这种要单独说，因为它是「看着像成功其实不是」
      backupTxt = when
        ? `<b>写进去了，但读不回来</b>（${esc(st.msg || '')}）。`
          + `文件多半还在 <span class="mono-line">下载/认知训练/</span>，只是这个 App 现在读不到它——`
          + `卸载重装之后 MediaStore 的归属可能变了。文件本身没丢。`
        : `还没有备份文件（${esc(st.msg || '')}）。点下面的「立即备份」写一份。`;
    }
  }

  /* 从设置页进来的时候，这个面板是**同一个浮层里的下一层**，不是新开一个窗口：
     标题右边给一个「← 返回设置」，而不是「关闭」（关闭会把人直接扔回主页面，
     他刚才是从设置里进来的，那就等于把路走丢了）。 */
  const cameFromSettings = sheetPanel === 'settings' || sheetPanel === 'dailySettings';
  const inner = sheetHost();
  sheetPanel = 'daily';
  inner.innerHTML = `
      ${cameFromSettings
        ? '<button class="ghost" style="float:right" onclick="openSettings(\'daily\')">← 返回设置</button>'
        : '<button class="ghost" style="float:right" onclick="closeSheet()">关闭</button>'}
      <h2>每日计划</h2>

      <div class="block">
        <div class="label">提醒</div>
        <p class="hint">每天提醒一次，只在<b>没达标</b>的时候响。已经达标的日子不再打扰你——
        一个天天响、内容和状态无关的提醒，很快会被无意识忽略。</p>
        <div class="plan-row" style="margin-top:10px">
          <span>时间</span>
          <input id="remH" type="text" inputmode="numeric" value="${r.hour}" style="flex:0 0 60px;text-align:center" onchange="saveReminderTime()">
          <span style="flex:0 0 12px">:</span>
          <input id="remM" type="text" inputmode="numeric" value="${String(r.minute).padStart(2, '0')}" style="flex:0 0 60px;text-align:center" onchange="saveReminderTime()">
          <button class="plain tiny" onclick="toggleReminder()">${r.enabled ? '关掉提醒' : '开启提醒'}</button>
        </div>
        ${window.EQNative ? `<div class="hint">${hasNotif ? '通知权限已授权' : '通知权限还没给——点下面的按钮申请'}</div>
          ${hasNotif ? '' : '<div class="row"><button class="ghost" onclick="askNotif()">申请通知权限</button></div>'}
          <div class="row"><button class="ghost" onclick="testReminderNow()">发一条试试</button></div>` : ''}
      </div>

      <div class="block">
        <div class="label">打完卡才能打开的应用</div>
        <p class="hint">
          ${window.EQNative
            ? (hasAcc ? '无障碍服务已开启。' : '还没开无障碍服务——没它检测不到你打开了什么应用。')
            : '这个功能只在 Android App 里可用（网页版检测不到你打开了别的应用）。'}
        </p>
        <p class="hint" style="margin-top:8px">
          闸门是「摩擦 + 一个明确的放弃选项」，不是禁止。研究里光给提示语是无效的，
          起作用的就是这个组合。所以它不会锁死你的手机，只是让你先动手做完那一组。
        </p>
        <div class="row">
          <button class="primary" onclick="openAppPicker()">从已安装应用里挑</button>
        </div>
        <div class="row">
          <button class="plain" onclick="toggleGate()">${g.enabled ? '关掉闸门' : '开启闸门'}</button>
        </div>
        ${(g.packages || []).length ? `<div class="idn-list">
          ${g.packages.map((p) => `<div class="idn-item"><div class="mono-line">${esc(p)}</div>
            <div class="hint"><button class="plain tiny" onclick="dropGatePkg('${esc(p)}')">删掉</button></div></div>`).join('')}
        </div>` : '<p class="hint" style="margin-top:8px">还没加目标应用。</p>'}
        <details class="diag-more" style="margin-top:8px">
          <summary>手动填包名（没有启动图标的应用才需要）</summary>
          <div class="plan-row" style="margin-top:8px">
            <span>包名</span>
            <input id="addPkg" type="text" placeholder="com.tencent.tmgp.sgame">
          </div>
          <div class="row"><button class="ghost" onclick="addGatePkg()">加一个</button></div>
        </details>
        ${window.EQNative ? `<div class="hint" style="margin-top:8px">
          需要两个系统权限，缺一个都会让闸门退化：
          <br>· 无障碍服务 —— ${hasAcc ? '已开' : '<b>没开</b>'}，没它检测不到你打开了什么应用
          <br>· 悬浮窗 —— ${hasOv ? '已开' : '<b>没开</b>'}，没它只能把主界面拉前台（观感是「游戏已经开了再被拽走」）
        </div>` : ''}
        ${window.EQNative && !hasAcc ? '<div class="row"><button class="primary" onclick="openAccSettings()">开启无障碍服务</button></div>' : ''}
        ${window.EQNative && !hasOv ? '<div class="row"><button class="primary" onclick="openOvSettings()">开启悬浮窗权限</button></div>' : ''}
        <p class="hint" style="margin-top:10px">
          挑应用等同于原来手填包名，只是不用去系统设置里找了。
          列表里只有<b>有启动图标的应用</b>（也就是你能从桌面点开的那些）；
          双开、隐藏入口之类的应用不在里面，那种用手动填包名。
        </p>
      </div>

      <div class="block">
        <div class="label">深度拦截（需要 root）</div>
        <p class="hint">
          上面那一层只是把游戏挤到后台——它还在后台活着，切回去就是一秒的事。
          打开这个之后，检测到目标应用启动会<b>直接把它杀掉</b>（am force-stop）。
        </p>
        <p class="hint" style="margin-top:8px">
          代价说清楚：它依赖 root，而 <b>root 不可用时它不会报错，只会什么都不做</b>。
          那种「以为还有保护、其实已经退回成只有浮层」的状态比不做更糟，
          所以这里必须先真探测一次，只有探到了才让你打开。
        </p>
        <div class="hint" style="margin-top:8px">当前状态：${rootTxt}</div>
        <div class="row" style="margin-top:10px">
          <button class="ghost" onclick="probeRootNow()">${g.rootKnown ? '重新检测' : '检测 root'}</button>
          ${(g.rootKnown && g.rootOk) || g.deepBlock
            ? `<button class="plain" onclick="toggleDeepBlock()">${g.deepBlock ? '关掉深度拦截' : '开启深度拦截'}</button>`
            : ''}
        </div>
      </div>

      <!-- 防掉线。这一条是实测出来的需求：Android 在「强行停止」时会连无障碍服务
           一起撤销，而且不自愈；而多数国产 ROM 把「从最近任务划掉」就实现成 force-stop。
           所以用户划一下，闸门就没了，而且界面还在说「闸门已开」。 -->
      <div class="block">
        <div class="label">防掉线（需要 root）</div>
        <p class="hint">
          这一条解决的是个实测过的问题：<b>从最近任务里划掉本应用，闸门会一起消失。</b>
          原因是 Android 在「强行停止」一个应用时，会把它的无障碍服务<b>一并撤销</b>
          （不是被杀后台——普通的后台清理反而碰不到它），而且不会自己恢复。
          多数国产系统把「划掉」就当成强行停止，所以划一下就没。
        </p>
        <p class="hint" style="margin-top:8px">
          打开之后，root 那边跑一个小循环：每 2 秒看一眼本应用在不在，发现被撤了就
          把无障碍服务写回去。实测<b>1 秒内闸门就回来</b>，而且不会覆盖你其它无障碍服务
          （那个设置是一整份列表，写的时候是先读、缺了才追加）。
        </p>
        <p class="hint" style="margin-top:8px">
          边界说清楚：它<b>不</b>往系统分区写东西、<b>不</b>做开机自启、<b>不</b>隐藏自己。
          循环每一轮都会检查包还在不在，<b>卸载之后它自己就退出了</b>；
          那个脚本也放在应用的私有目录里，卸载会被一起删掉。
        </p>
        <div class="hint" style="margin-top:8px">当前状态：${watchTxt}</div>
        <div class="row" style="margin-top:10px">
          ${(g.rootKnown && g.rootOk) || w.want
            ? `<button class="plain" onclick="toggleGateWatch()">${w.want ? '关掉防掉线' : '开启防掉线'}</button>`
            : ''}
          <button class="ghost" onclick="probeRootNow()">${w.want ? '重新检测 root' : '检测 root'}</button>
        </div>
      </div>

      <div class="block">
        <div class="label">进度备份</div>
        <p class="hint">
          卸载是这个 App 唯一的出口。但「想退出」不该等于「全部归零」——
          所以训练记录会作为<b>纯文本</b>留一份在公共目录里，卸载不会把它带走，
          重装之后可以捞回来。要彻底清掉，用你的清理软件删那个文件就行。
        </p>
        <p class="hint" style="margin-top:8px">
          落在公共目录的东西只有这一个 <span class="mono-line">.json</span> 文本文件。
          应用私有目录里另有一份「防掉线」的 shell 脚本（<b>只有开了它才会写</b>）：
          卸载会把私有目录整个删掉，那个守夜循环每轮也会检查包还在不在、卸载后自己退出。
          所以<b>卸载之后磁盘上不会有任何还能跑起来的东西</b>。
        </p>
        <div class="hint" style="margin-top:8px">${backupTxt}</div>
        <div class="row" style="margin-top:10px">
          <button class="ghost" onclick="backupNowClick()">立即备份</button>
          <button class="ghost" onclick="restoreBackup()">从备份恢复</button>
        </div>
      </div>
      <div class="row"><button class="primary" onclick="closeSheet()">知道了</button></div>
    </div>`;
}

function toggleReminder() {
  state.reminder = state.reminder || { hour: 20, minute: 0, enabled: true };
  state.reminder.enabled = !state.reminder.enabled;
  save();
  syncGate();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
}

function saveReminderTime() {
  const h = parseInt((document.getElementById('remH') || {}).value, 10);
  const m = parseInt((document.getElementById('remM') || {}).value, 10);
  state.reminder = state.reminder || { enabled: true };
  state.reminder.hour = (h >= 0 && h <= 23) ? h : 20;
  state.reminder.minute = (m >= 0 && m <= 59) ? m : 0;
  save();
  syncGate();
  toast(`提醒时间设为 ${state.reminder.hour}:${String(state.reminder.minute).padStart(2, '0')}`);
}

function toggleGate() {
  state.gate = state.gate || { packages: [] };
  state.gate.enabled = !state.gate.enabled;
  save();
  syncGate();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
}

function askBackupPerm() {
  if (!backupAvailable()) return;
  if (EQNative.requestBackupPermission && EQNative.requestBackupPermission() === 1) {
    toast('这台机器不需要存储权限，直接备份就行');
    return;
  }
  toast('请在系统弹窗里允许存储权限');
}

function backupNowClick() {
  if (!backupAvailable()) { toast('这个功能只在 Android App 里可用'); return; }
  doBackup(false);
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
}

function probeRootNow() {
  if (!window.EQNative || !EQNative.probeRoot) {
    toast('这个功能只在 Android App 里可用');
    return;
  }
  toast('正在检测 root…');
  // 异步：su 的授权弹窗可能在等人点确认，同步等会把界面卡住
  EQNative.probeRoot();
}

/** 原生探测完回调过来。名字是 native 侧约定的，改这里要同时改 RootGate 那条调用链。 */
window.__onRootProbe = function (ok) {
  state.gate = state.gate || { packages: [] };
  state.gate.rootKnown = true;
  state.gate.rootOk = !!ok;
  if (!ok && state.gate.deepBlock) {
    // 探测失败时顺手把开关关掉。留着它「开着」是最坏的状态：
    // 界面上写着有深度拦截，实际什么都没发生。
    state.gate.deepBlock = false;
    if (window.EQNative && EQNative.setDeepBlock) {
      try { EQNative.setDeepBlock(0); } catch (e) { /* 忽略 */ }
    }
  }
  save();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
  toast(ok ? 'root 可用，深度拦截可以打开了' : 'root 不可用，拦截只能退回成推浮层');
};

function toggleDeepBlock() {
  state.gate = state.gate || { packages: [] };
  state.gate.deepBlock = !state.gate.deepBlock;
  if (window.EQNative && EQNative.setDeepBlock) {
    try { EQNative.setDeepBlock(state.gate.deepBlock ? 1 : 0); } catch (e) { /* 忽略 */ }
  }
  save();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
  toast(state.gate.deepBlock
    ? '深度拦截开了——目标应用启动后会被直接杀掉'
    : '深度拦截关了，只剩把游戏挤到后台');
}

/* ------------------------------------------------------------ 防掉线
 *
 * 「开着」和「真的在跑」是两件事，这个面板必须说后者。
 * 一个应用读不到 root 进程的 /proc，所以判断依据是原生那边**心跳文件的时间戳**：
 *   running=true  → 循环还活着，闸门掉了它会自己装回来
 *   running=false → 用户开了，但循环没在跑（root 被撤、su 被拒、或者它自己退出了）
 * 后者是最坏的状态——和「以为有深度拦截其实没有」是同一类，所以必须显示出来，
 * 而且要能一眼看出「开关开着但没生效」。 */

/** 从原生要一次真实状态，写进 state，返回它。原生不在时给一个保守的默认。 */
function refreshGateWatch() {
  let w = { want: false, running: false, ago: -1, rootKnown: false, rootOk: false };
  if (window.EQNative && EQNative.gateWatchStatus) {
    try {
      const o = bridgeObj(EQNative.gateWatchStatus());
      if (o) w = Object.assign(w, o);
    } catch (e) { /* 读不到就按上面的默认值，也就是「没在跑」 */ }
  }
  state.gate = state.gate || {};
  state.gate.watch = w;
  return w;
}

/* 用户自己点了「开启/关掉防掉线」吗？用来区分「用户点的」和「启动时后台确认的」——
   前者要报结果，后者报了就只是噪音。 */
let watchAsked = false;

function toggleGateWatch() {
  if (!window.EQNative || !EQNative.setGateWatch) {
    toast('这个功能只在 Android App 里可用');
    return;
  }
  const w = refreshGateWatch();
  const want = !w.want;
  watchAsked = true;
  try { EQNative.setGateWatch(want ? 1 : 0); } catch (e) { watchAsked = false; }
  // 不在这里 toast 结果：su 是异步的，现在说什么都是猜的。
  // 原生干完会回调 __onGateWatch，那里才是有依据的那句话。
  if (watchAsked) toast(want ? '正在启动防掉线…（root 可能弹一次授权框）' : '正在关掉防掉线…');
}

/** 原生启停完回调过来。payload 是 q() 包过的 JSON 字符串，所以要归一化。 */
window.__onGateWatch = function (payload, why) {
  const o = bridgeObj(payload);
  if (!o) return;
  state.gate = state.gate || {};
  state.gate.watch = o;
  state.gate.rootKnown = !!o.rootKnown;
  state.gate.rootOk = !!o.rootOk;
  save();
  // 只在设置面板开着的时候就地刷新它（和 toggleDeepBlock 那边一个规矩）；
  // 启动时也会走一次这条路（见 boot 里重新确认它在跑），那时候不该弹面板。
  if (document.querySelector('.sheet')) openDailySettings();
  // 只有用户自己点的才报结果。启动时那次是后台确认，弹 toast 是噪音。
  if (!watchAsked) return;
  watchAsked = false;
  if (why) toast('防掉线没启动成功：' + why);
  else if (o.want) toast(o.running ? '防掉线在跑了' : '启动了，但还没看到心跳——稍等一下再看');
  else toast('防掉线关了');
};

/* 应用清单缓存。挑应用这个面板会被反复打开（挑一个 → 关掉 → 再挑一个），
   每次都去问一次原生没必要，而且列表长的话会有可见的延迟。 */
let PKG_LIST = null;

function openAppPicker() {
  if (!window.EQNative || !EQNative.listApps) {
    toast('这个功能只在 Android App 里可用');
    return;
  }
  const sh = document.createElement('div');
  sh.className = 'sheet open';
  sh.id = 'pkgSheet';
  sh.innerHTML = `<div class="inner" onclick="event.stopPropagation()">
    <button class="ghost" style="float:right" onclick="closePicker()">关闭</button>
    <h2 style="margin:10px 0 6px">挑要拦的应用</h2>
    <p class="hint" id="pkgCount" style="margin-bottom:10px"></p>
    <input type="text" id="pkgSearch" placeholder="搜应用名或包名"
      oninput="filterPkgs()" style="margin-bottom:10px">
    <div id="pkgList"><p class="hint">正在读取已安装的应用…</p></div>
  </div>`;
  sh.addEventListener('click', closePicker);
  document.body.appendChild(sh);

  const draw = (apps, note) => {
    const box = document.getElementById('pkgList');
    if (!box) return;
    const sel = (state.gate && state.gate.packages) || [];
    if (!apps.length) {
      box.innerHTML = `<p class="hint">${note || '没有读到任何应用。'}</p>
        <p class="hint">上面「手动填包名」那条路仍然可用。</p>`;
      updatePkgCount();
      return;
    }
    box.innerHTML = `<div class="pkg-list">${apps.map((a) => `
      <button class="pkg-item ${sel.includes(a.pkg) ? 'on' : ''}" data-pkg="${esc(a.pkg)}"
        onclick="togglePickPkg('${esc(a.pkg)}')">
        <span class="pkg-label">${esc(a.label)}</span>
        <span class="pkg-mark">${sel.includes(a.pkg) ? '已选' : ''}</span>
        <span class="pkg-pkg">${esc(a.pkg)}</span>
      </button>`).join('')}</div>`;
    updatePkgCount();
  };

  if (PKG_LIST) { draw(PKG_LIST); return; }
  try {
    // 有些机型读列表要一会儿，所以先画「正在读取」，再同步替换
    const raw = EQNative.listApps();
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch (e) { arr = []; }
    PKG_LIST = Array.isArray(arr) ? arr : [];
    draw(PKG_LIST, '没有读到任何应用——可能是这台手机限制了应用列表。');
  } catch (e) {
    draw([], '读取失败：' + (e.message || e));
  }
}

function updatePkgCount() {
  const el = document.getElementById('pkgCount');
  if (!el) return;
  const n = ((state.gate && state.gate.packages) || []).length;
  el.textContent = n ? `已经选了 ${n} 个。点一下切换选中，选完直接关掉就行。`
    : '选中的应用会在你达标之前被拦住。点一下选中。';
}

/** 只改这一行的样式，不重画整个列表——重画会丢掉滚动位置和搜索词，
    而这个列表可能有一两百项，用户正挑到一半时被弹回顶部很难受。 */
function togglePickPkg(pkg) {
  state.gate = state.gate || { enabled: false, packages: [] };
  const has = state.gate.packages.includes(pkg);
  if (has) state.gate.packages = state.gate.packages.filter((p) => p !== pkg);
  else state.gate.packages.push(pkg);
  // 挑到一半接个电话就退出去了，所以点一下立刻存，不攒到「完成」才提交
  if (state.gate.packages.length) state.gate.enabled = true;
  save();
  syncGate();
  const btn = document.querySelector(`.pkg-item[data-pkg="${pkg}"]`);
  if (btn) {
    btn.classList.toggle('on', !has);
    const m = btn.querySelector('.pkg-mark');
    if (m) m.textContent = has ? '' : '已选';
  }
  updatePkgCount();
}

function filterPkgs() {
  const el = document.getElementById('pkgSearch');
  const q = (el && el.value || '').trim().toLowerCase();
  const all = PKG_LIST || [];
  const hit = !q ? all
    : all.filter((a) => (a.label || '').toLowerCase().includes(q)
      || (a.pkg || '').toLowerCase().includes(q));
  const box = document.getElementById('pkgList');
  if (!box) return;
  if (!hit.length) { box.innerHTML = `<p class="hint">没有匹配「${esc(q)}」的应用。</p>`; return; }
  const sel = (state.gate && state.gate.packages) || [];
  box.innerHTML = `<div class="pkg-list">${hit.map((a) => `
    <button class="pkg-item ${sel.includes(a.pkg) ? 'on' : ''}" data-pkg="${esc(a.pkg)}"
      onclick="togglePickPkg('${esc(a.pkg)}')">
      <span class="pkg-label">${esc(a.label)}</span>
      <span class="pkg-mark">${sel.includes(a.pkg) ? '已选' : ''}</span>
      <span class="pkg-pkg">${esc(a.pkg)}</span>
    </button>`).join('')}</div>`;
}

/** 关掉面板并回到设置页——挑完要能立刻看见「打勾才能打开的应用」里那几条。 */
function closePicker() {
  const sh = document.getElementById('pkgSheet');
  if (sh) sh.remove();
  openDailySettings();
}

function addGatePkg() {
  const el = document.getElementById('addPkg');
  const v = (el && el.value || '').trim();
  if (!v) return;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(v)) {
    toast('这不像包名。包名长这样：com.tencent.tmgp.sgame');
    return;
  }
  state.gate = state.gate || { enabled: false, packages: [] };
  if (!state.gate.packages.includes(v)) state.gate.packages.push(v);
  state.gate.enabled = true;   // 加了目标应用就顺手打开闸门，否则用户会以为没生效
  save();
  syncGate();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
}

function dropGatePkg(pkg) {
  state.gate.packages = (state.gate.packages || []).filter((p) => p !== pkg);
  save();
  syncGate();
  openDailySettings();     // 就地刷新，不关掉再开（那会把设置面板一起关掉）
}

function testReminderNow() {
  if (window.EQNative && EQNative.testReminder) {
    EQNative.testReminder();
    toast('发了一条。没看到就是通知权限没给。');
  }
}

function askNotif() {
  if (window.EQNative && EQNative.requestNotif) EQNative.requestNotif();
}

function openOvSettings() {
  if (window.EQNative && EQNative.openOverlaySettings) EQNative.openOverlaySettings();
}

function openAccSettings() {
  if (window.EQNative && EQNative.openAccessibilitySettings) EQNative.openAccessibilitySettings();
}

/* ============================================================ 今天 / 分组视图
 *
 * 底部 5 个 tab 按「你要做什么」分，不按功能名分（原来是 7 个平铺，
 * AI 的三个功能散在三处，离线训练的两个也散着）。这里做两件事：
 *   1. 今天页 —— 打开就该看到的：今天要做什么、达标了没、闸门开着吗
 *   2. 分组页内的二级切换，避免再去挤底部栏
 */

let practiceSubview = 'cards';   // cards | calib
let aiSubview = 'voice';         // voice | checkup | replay

/** 二级切换条。样式复用 .chips，和卡片页那三个子视图长得一致。 */
function subTabs(items, cur, setter, act) {
  /* act 是这一路 tab 右侧那个常驻的小入口（现在只有 AI 那一路用：对话历史）。
     为什么要放在切换条上，而不是某一页里：用户的原话是「有一个问题是你这个地方
     还挺好找的，我绕了一圈才到」——历史原来只在「场景对话」这一页上有入口，
     从体检、复盘、或者正在聊的一局里都够不着（要绕回那一页）。
     放在切换条上就是**这一路 tab 里任何一页都一步可达**。
     按 Material/iOS 的通行做法，这种"每一页都能用"的动作应该跟导航同级，
     而不是藏在某一页的内容里。 */
  return `<div class="subnav">
    <div class="chips">${items.map(([k, label]) => `
      <button class="chip-btn subnav-tab ${cur === k ? 'on' : ''}" onclick="${setter}('${k}')">${label}</button>`).join('')}</div>
    ${act || ''}
  </div>`;
}

/* 二级切换：**保留**当前子页状态，只重渲染。
   这里必须用 showTab 而不是 go——go 是「点底部 tab，回到默认子页」，
   用它的话 setAiSubview('checkup') 会被立刻重置回 voice，切换条点了没反应。
   这两个动作名字像、后果完全相反，所以在下面用注释钉住。 */
function setPracticeSubview(v) {
  practiceSubview = v;
  if (v === 'cards') cardsView = 'drill';
  showTab('practice');
}

function setAiSubview(v) {
  aiSubview = v;
  showTab('ai');
}

function setGrowthSubview(v) {
  growthSubview = v;
  showTab('growth');
}

/** 直接落到「练习 → 卡片」这个位置（原来到处写 go('cards')，现在收敛成一个函数） */
function goPracticeCards() {
  practiceSubview = 'cards';
  cardsView = 'drill';
  showTab('practice');
}

/* ============================================================ 信号场（小游戏）
 *
 * 为什么做这个：他最初的问题是「读不懂女生说的话」。那件事靠知识点解决不了——
 * 卡片练的是「想清楚」，而这个练的是**半秒内分辨**，两者要的能力不一样。
 * 分辨是一种手感，手感只能靠大量重复判断 + 立刻知道错在哪 + 看见自己在变。
 *
 * 判据只有一个：**排他性**——她对别人是不是也这样。
 * 这个判据的好处是它对所有情况都成立：不问「她喜欢我吗」（无法观察），
 * 只问「这条线索是不是只对我」（可以观察）。
 *
 * 计分为什么用信号检测论而不是答对数：
 * 一律答「她对谁都这样」也能拿到不错的分（14 条里 10 条确实如此），
 * 那这个游戏就白做了。d' 把两件事拆开——
 *   分辨力 d'：你能不能看出这条和她基线不一样（低 = 还没手感，要多看）
 *   偏向   c ：你倾向于往哪边倒（负 = 见什么都像信号，正 = 把什么都推掉）
 * 这两种毛病的练法正相反，混在一个「答对率」里就看不见了。
 * 依据是 Brandner 2019/2022 用信号检测论重做那批研究后的结论：
 * 差异主要来自分辨力而不是一个普遍的偏向——分辨力可练，所以那个结论更有用。
 */
const SDT_KEEP = 30;      // 只留最近 30 局的成绩，看趋势不需要全部

function normInv(p) {
  // Acklam 的正态分位数近似（|误差| < 1.15e-9）。自己写是为了不引依赖：
  // 这个 App 是单文件离线包，为一个 z 值去捆一个统计库不划算。
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -8 : 8;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/* d' 和偏向 c。
 *
 * 必须做**对数线性校正**（Hautus 1995）：命中率或虚报率正好是 0 或 1 的时候，
 * z(0) = -∞、z(1) = +∞，d' 直接变成 NaN/Infinity。
 * 而这恰恰不是罕见情况——20 轮里全答「是」或全答「不是」就必然发生，
 * 也就是新手最可能出现的那两种局面。校正办法是每个格子加半个试次。
 * 不校正的话，游戏会在最需要给反馈的那两种情况下报不出分数。 */
function sdtScore(hits, misses, fa, cr) {
  const nS = hits + misses, nN = fa + cr;
  const H = (hits + 0.5) / (nS + 1);
  const F = (fa + 0.5) / (nN + 1);
  const zH = normInv(H), zF = normInv(F);
  return {
    hits, misses, fa, cr, nS, nN, H, F,
    d: zH - zF,
    c: -(zH + zF) / 2,
  };
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 每局固定 10 条「是真信号」+ 10 条「不是」，从池子里随机抽。
 *
 * 为什么要**固定一半一半**：d' 的定义要求知道每类各有多少试次。
 * 如果按真实比例抽（池子里不是信号的那类更多），虚报率会被试次数影响，
 * 而且会出现「猜多数类就能得高分」——那样量出来的就不是分辨力。
 * 这是为了测准而牺牲一点「真实比例」，值得。 */
function buildSignalDeck() {
  const cfg = CONTENT.signal || {};
  const all = cfg.items || [];
  const per = cfg.per_class_per_play || 10;
  const yes = all.filter((x) => x.exclusive);
  const no = all.filter((x) => !x.exclusive);
  const take = (arr) => shuffleInPlace(arr.slice()).slice(0, Math.min(per, arr.length));
  return shuffleInPlace(take(yes).concat(take(no)));
}

let game = null;

function startSignalGame() {
  const deck = buildSignalDeck();
  if (!deck.length) { $('#view').innerHTML = '<div class="card"><h2>信号场</h2><p class="hint">题目还没加载。</p></div>'; return; }
  game = { deck, i: 0, hits: 0, misses: 0, fa: 0, cr: 0,
    combo: 0, maxCombo: 0, log: [], answered: false };
  renderSignal();
}

function viewSignal() {
  if (!game) { renderSignalIntro(); return; }
  if (game.i >= game.deck.length) { renderSignalResult(); return; }
  renderSignal();
}

function renderSignalIntro() {
  const s = state.signal || {};
  const plays = s.plays || [];
  const best = s.best;
  const last = plays.length ? plays[plays.length - 1] : null;
  $('#view').innerHTML = `
    <div class="card">
      <h2>信号场</h2>
      <p class="hint" style="margin-top:8px">
        一局 ${(CONTENT.signal && CONTENT.signal.rounds_per_play) || 20} 条线索，每条只问一件事：
        <b>这是只对你，还是她对谁都这样</b>。
      </p>
      <div class="block" style="margin-top:12px">
        <div class="label">为什么只问这一件事</div>
        <div>「她喜不喜欢我」是没法观察的，越想越乱。「她对别人是不是也这样」是可以观察的——
        你只要再看一眼她对别人的样子就有答案。把问题换成可以观察的那个，是这套训练里最省力的一步。</div>
      </div>
      <div class="block">
        <div class="label">答完会给你两个数字，不是一个</div>
        <div><b>分辨力</b>：你能不能看出这条和她平时不一样。<br>
        <b>偏向</b>：你更容易把事说成信号，还是更容易把事推掉。<br>
        这两种毛病的改法正相反，所以分开算。只答「不是信号」拿不到高分——那会显得你看不出区别。</div>
      </div>
      ${plays.length ? `<div class="score-row" style="margin-top:12px">
        <div><b>${plays.length}</b><span>玩过几局</span></div>
        <div><b>${best ? best.d.toFixed(2) : '—'}</b><span>最好分辨力</span></div>
        <div><b>${last ? last.d.toFixed(2) : '—'}</b><span>上一局</span></div>
      </div>` : ''}
      ${plays.length >= 2 ? `<p class="hint" style="margin-top:8px">${signalTrendText(plays)}</p>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="primary" onclick="startSignalGame()">${plays.length ? '再来一局' : '开始'}</button>
      </div>
      <p class="hint" style="margin-top:10px">不联网也能玩。<b>不算达标</b>——达标线仍然是 4 张卡片（判对）+ 1 条微课；
      但它算今天的活动，所以「今日」和连续天数会照常往上走（和「缓一下」同一条规矩：
      只要是真练了就算，只有达标线卡在卡片和微课上）。</p>
    </div>`;
}

function signalTrendText(plays) {
  const ds = plays.map((p) => p.d).filter((x) => typeof x === 'number');
  if (ds.length < 2) return '';
  const early = ds.slice(0, Math.max(1, Math.floor(ds.length / 2)));
  const late = ds.slice(-Math.max(1, Math.floor(ds.length / 2)));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const diff = avg(late) - avg(early);
  if (diff > 0.25) return `前半程平均分辨力 ${avg(early).toFixed(2)}，最近 ${avg(late).toFixed(2)}——在变好。`;
  if (diff < -0.25) return `前半程 ${avg(early).toFixed(2)}，最近 ${avg(late).toFixed(2)}——退了一点，可能是这几局的题偏难，也可能是累了。`;
  return `分辨力基本稳定在 ${avg(ds).toFixed(2)} 上下，没有明显进退。`;
}

function renderSignal() {
  const it = game.deck[game.i];
  const n = game.deck.length;
  const dots = game.log.map((x) => `<i class="sg-dot ${x.ok ? 'sg-ok' : 'sg-no'}"></i>`).join('')
    + Array.from({ length: n - game.log.length }, () => '<i class="sg-dot"></i>').join('');
  /* 整轮都从这里渲染，包括已经答完的状态。
     一开始把反馈用 insertAdjacentHTML 塞进去，结果是**中途切走再回来**时
     会重新画出两个按钮、同一条线索能答第二次，计数就重复了。
     渲染函数只读状态、不靠"刚才发生过什么"，这个问题就不存在。 */
  $('#view').innerHTML = `
    ${game.answered ? '' : `<p class="hint" style="margin-bottom:10px">
      第 ${game.i + 1} / ${n} 条${game.combo >= 2 ? ` · <b>连对 ${game.combo}</b>` : ''}</p>`}
    <div class="sg-dots">${dots}</div>
    <div class="card">
      <div class="meta">
        <span class="tag dom">${esc(it.domain || '')}</span>
        <span class="tag">${game.i + 1}/${n}</span>
        ${game.answered ? `<span class="tag">${game.log[game.log.length - 1].ok ? '答对' : '答错'}</span>` : ''}
      </div>
      <p class="scene">${rich(it.context)}</p>
      <blockquote class="quote">「${rich(it.cue)}」</blockquote>
      <p class="prompt">这条线索——是只对你，还是她对谁都这样？</p>
      ${game.answered ? '' : `<div class="sg-btns" id="sgBtns">
        <button class="sg-btn yes" onclick="answerSignal(true)">
          <b>只对我这样</b><span>这条超出她的平时样子</span>
        </button>
        <button class="sg-btn no" onclick="answerSignal(false)">
          <b>她对谁都这样</b><span>这条不是给我一个人的</span>
        </button>
      </div>`}
      <div id="sgFb">${game.answered ? signalFeedbackHtml(it) : ''}</div>
    </div>`;
}

function signalFeedbackHtml(it) {
  const last = game.log[game.log.length - 1] || {};
  const ok = !!last.ok;
  const kindName = { signal: '这条是**只对你**', base: '这条**她对谁都这样**', thin: '这条**信息还不够**' };
  return `
    <div class="sg-fb ${ok ? 'sg-right' : 'sg-wrong'}">
      <div class="sg-verdict">${ok ? '✓ 对了' + (game.combo >= 3 ? `　连对 ${game.combo}` : '') : '✗ 这条反了'}</div>
      <div class="sg-kind">${rich(kindName[it.kind] || '')}</div>
      <div class="block"><div class="label">判据</div><div>${rich(it.why)}</div></div>
      ${it.trap ? `<div class="block"><div class="label">容易错在哪</div><div>${rich(it.trap)}</div></div>` : ''}
      ${it.settle ? `<div class="block"><div class="label">下一步看什么</div><div>${rich(it.settle)}</div></div>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="primary" onclick="nextSignal()">${game.i + 1 >= game.deck.length ? '看结果' : '下一条'}</button>
      </div>
    </div>`;
}

/* 判一下：说「是信号」时，真值 exclusive → 命中；否则虚报。
   说「不是」时，真值非 exclusive → 正确拒绝；否则漏检。 */
function answerSignal(saidYes) {
  if (!game || game.answered) return;
  const it = game.deck[game.i];
  const truth = !!it.exclusive;
  const ok = saidYes === truth;
  game.answered = true;
  if (truth && saidYes) game.hits++;
  else if (truth && !saidYes) game.misses++;
  else if (!truth && saidYes) game.fa++;
  else game.cr++;
  if (ok) { game.combo++; game.maxCombo = Math.max(game.maxCombo, game.combo); }
  else game.combo = 0;
  game.log.push({ id: it.id, saidYes, truth, ok });
  save();   // 每答一条就存，中间退出不丢
  renderSignal();
  const fb = document.getElementById('sgFb');
  if (fb) fb.scrollIntoView({ block: 'nearest' });
}

function nextSignal() {
  if (!game) return;
  game.i++;
  game.answered = false;
  game.combo = 0;   // 连对是"连续答对"，跨轮不清会把上一轮断掉的连击续上
  /* 走 viewSignal() 而不是 renderSignal()：最后一条答完时 i 会越界，
     直接渲染会读到不存在的题（"看结果"那个按钮点下去就崩）。
     越界这个判断只该有一个地方做，就是 viewSignal。 */
  viewSignal();
}

function signalRank(d, c) {
  // 段位只说两件事：看不看得见区别、往哪边倒。不用"分数"这类含糊的词。
  // 最上面那一档原来写的是「几乎不误判」——但 d′ 到 1.8 的人一局里
  // 仍然会错两三条，那句话是在替用户下一个不准的结论。改成描述能力，不描述战绩。
  const vision = d < 0.4 ? '还看不清' : d < 1.0 ? '刚能分开' : d < 1.8 ? '看得很准' : '分得很清';
  const lean = c < -0.35 ? '偏向把事说成信号'
    : c > 0.35 ? '偏向把事推掉'
    : '两边都不偏';
  return { vision, lean };
}

function renderSignalResult() {
  const s = sdtScore(game.hits, game.misses, game.fa, game.cr);
  const r = signalRank(s.d, s.c);
  const n = game.deck.length;

  // 存成绩。best 按分辨力算——偏向没有"越高越好"，只有偏多偏少。
  //
  // 只记一次：这个函数会在每次重画结果页时被调用（切走再回来就会重画），
  // 而它一旦每次渲染都 push，**同一局会被记成好几笔**，
  // 玩得越多、来回切得越多，历史就被灌得越假。
  // 渲染函数只读状态、不写状态，这条规矩在这里最容易破——所以单独立一个 flag。
  if (!game.recorded) {
    game.recorded = true;
    if (!state.signal) state.signal = { plays: [], best: null };
    state.signal.plays.push({ ts: Date.now(), d: s.d, c: s.c,
      hits: s.hits, fa: s.fa, n, maxCombo: game.maxCombo });
    if (state.signal.plays.length > SDT_KEEP) state.signal.plays = state.signal.plays.slice(-SDT_KEEP);
    if (!state.signal.best || s.d > state.signal.best.d) {
      state.signal.best = { d: s.d, c: s.c, ts: Date.now() };
    }
    markActivity();
    save();
  }

  /* 处方：分辨力和偏向分开给，因为改法完全不同。
     分辨力低要去"看别人"（加样本），偏向偏要去"标事实"（把推测和观察分开）。
     混成一句"多练练"等于什么都没说。 */
  let rx;
  if (s.d < 0.4 && s.c < -0.35) rx = '你现在的主要问题不是看不懂，是**还没看就先往"是信号"那边站**。下一步做两件事：一是看到任何一条线索，先在心里问「她对别人是不是也这样」，答不上来就先记着不下结论；二是这周找一次机会，真的去看她对别人的样子——分辨力只能靠加样本，不能靠想。';
  else if (s.d < 0.4) rx = '分辨力还低，说明你的判断现在和「猜」区别不大。这不是笨，是**样本太少**：你手上关于"她对别人什么样"的信息还不够。下一步最有用的一件事，是刻意观察同一个人对不同人的差别，攒够比较材料再回头玩。';
  else if (s.c < -0.35) rx = '你能看出区别了，但**更愿意把事说成信号**。这是最容易让关系变尴尬的一种偏——因为你会在对方没那个意思的时候先动。下一步是给自己加一道手续：把「我观察到的」和「我猜的」分开写，只让观察到的那半参与判断。';
  else if (s.c > 0.35) rx = '你能看出区别，但**更容易把事推掉**。这个偏的好处是不会自作多情，代价是真实的机会也一起被推掉了——对方给了信号你没接，几次之后她就不给了。下一步允许自己在证据够的时候说"是"。';
  else rx = '分辨力和偏向都在一个健康的位置：既能看出区别，也不往任何一边倒。这个状态要保住，靠的是继续用「排他性」这一条判据，而不是靠感觉。';

  $('#view').innerHTML = `
    <div class="card">
      <h2>这一局</h2>
      <div class="score-row" style="margin-top:12px">
        <div><b>${s.d.toFixed(2)}</b><span>分辨力 d′</span></div>
        <div><b>${s.c.toFixed(2)}</b><span>偏向 c</span></div>
        <div><b>${game.maxCombo}</b><span>最长连对</span></div>
      </div>
      <p class="hint" style="margin-top:8px">${r.vision} · ${r.lean}</p>
      <div class="block" style="margin-top:12px">
        <div class="label">这一局你都答了什么</div>
        <div class="sg-mix">
          <span>真有信号、你也说是：<b>${s.hits}</b></span>
          <span>真有信号、你说是噪声：<b>${s.misses}</b></span>
          <span>只是她的基线、你却说是：<b>${s.fa}</b></span>
          <span>只是她的基线、你也说是噪声：<b>${s.cr}</b></span>
        </div>
        <p class="hint" style="margin-top:8px">分辨力是上面四格算出来的一个数：能不能把「她的基线」和「超出基线的部分」分开。
        偏向是另一个数：你出错时更常出在哪一侧。</p>
      </div>
      <div class="block">
        <div class="label">下一步</div>
        <div>${rich(rx)}</div>
      </div>
      <div class="row" style="margin-top:12px;flex-direction:column;gap:8px">
        <button class="primary" onclick="startSignalGame()">再来一局</button>
        <button class="ghost" onclick="game=null;renderSignalIntro()">回到开头</button>
      </div>
    </div>
    <div class="card">
      <div class="label" style="margin-bottom:8px">这一局的 ${n} 条（点一条看判据）</div>
      <div class="sg-review">
        ${game.log.map((x, i) => {
          const it = game.deck[i];
          return `<button class="sg-rev ${x.ok ? 'ok' : 'no'}" onclick="toggleSignalReview(${i})">
            <b>${x.ok ? '✓' : '✗'}</b><span>${esc((it.cue || '').slice(0, 22))}…</span></button>
            <div class="sg-rev-body" id="sgrev${i}" style="display:none">
              <div class="block"><div class="label">判据</div><div>${rich(it.why)}</div></div>
              ${it.trap ? `<div class="block"><div class="label">容易错在哪</div><div>${rich(it.trap)}</div></div>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function toggleSignalReview(i) {
  const el = document.getElementById('sgrev' + i);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

/* ============================================================ 闲聊：球在谁手里
 *
 * 用户的要求：「关于内容的方面，要查阅资料，要锻炼我闲聊的能力，加一些案例或者
 * 说游戏，或者说其他方式你自己决定。」
 *
 * 为什么做成一局一局的「接球」，而不是再加一批选择题：
 *   现有的 84 张卡都是**单发**的——选完就结束，看不见这句话后面会发生什么。
 *   而用户自己说的毛病是「不想事，直接得出答案」「分不清情况，就胡说」，
 *   这两句话的病根是同一个：**看不见自己这句话把局面推到了哪里**。
 *   所以这一局的机制是：你每说一句，对方**下一句就变**。
 *   选「抢球」他的回应会变短；选「追问」他会接着讲。
 *   把后果演出来，比再讲一遍道理有用。
 *
 * 为什么要先把动作类型藏起来：
 *   出选项时**不标**这句是「追问」还是「抢球」，选完才揭。
 *   先标就等于送答案——人一眼看到「追问」就选它，什么也没学到。
 *   这也是「读局要指依据」那条思路的延续：先做判断，再给名字。
 *
 * 内容里的六种动作和四条研究依据都在 data/chat.json 里，改内容不用动这个文件。
 * 证据的措辞刻意留了边界（含 2025 年那份勘误和一次学术争论），
 * 因为这个项目里凡是「有证据」的地方都得把证据到哪一步写出来。
 *
 * 为什么写在 app.js 而不是新开 public/chat.js：
 * verify_offline.js 有一条断言钉着「内联了 3 段脚本」。新增一个 .js 文件
 * 要同时改 index.html 和 build_offline.py 两处清单——这个坑项目里踩过五次了。
 */

let chatGame = null;

function chatMove(key) {
  const ms = (CONTENT.chat || {}).moves || [];
  return ms.find((m) => m.key === key) || { key: key, name: key, what: '', why_good: '' };
}

/** 闲聊那一屏的总入口。三态：还没开始 / 正在打 / 打完了。 */
function viewChat() {
  const d = CONTENT.chat;
  if (!d || !(d.cases || []).length) {
    $('#view').innerHTML = `<div class="card"><p class="hint">
      闲聊内容没加载上（应该来自 data/chat.json）。离线版里这份是内联的，
      出现这一句说明构建时漏了它。</p></div>`;
    return;
  }
  if (!chatGame) return renderChatIntro();
  if (chatGame.phase === 'done') return renderChatResult();
  // 「一案打完、还没进下一案」那一屏也要能被切回来时正确重建，
  // 否则从别的页切回来会跳回上一步的选项上，看着像回档。
  if (chatGame.phase === 'ending') return renderChatEnding();
  return renderChatStep();
}

function startChatGame() {
  const d = CONTENT.chat;
  const all = (d.cases || []).slice();
  shuffleInPlace(all);
  const n = Math.min(d.rounds_per_play || 4, all.length);
  chatGame = {
    queue: all.slice(0, n), i: 0, step: 0, picked: null, phase: 'step',
    // picks 是「这一局你说过的每一句」：对方的下一句靠它推（chatAskOf），
    // 复盘、结局统计也靠它。**第一版把这一项漏了**，于是第一次点击就抛异常——
    // 是 check_chat.js 抓出来的：它按真实入口建状态，而不是自己手写一个字面量。
    picks: [],
    caught: 0, total: 0, byMove: {}, caseKeeps: 0, review: [], recorded: false,
  };
  renderChatStep();
}

function renderChatIntro() {
  const d = CONTENT.chat;
  const st = state.chat || { plays: [], byMove: {} };
  const byMove = st.byMove || {};
  const played = Object.keys(byMove).reduce((a, k) => a + byMove[k], 0);
  const worst = played ? Object.keys(byMove).sort((a, b) => byMove[b] - byMove[a])[0] : null;
  const last = (st.plays || []).length ? st.plays[st.plays.length - 1] : null;

  $('#view').innerHTML = `
    <div class="card">
      <h2 class="today-h">球在谁手里</h2>
      <p class="hint" style="margin-top:8px">
        闲聊练的不是「会说话」，是<b>接住对方递过来的东西，再递回去</b>。
        这一局里你说三句话，对方的三句回应会跟着你说的变——<b>你选什么，他就怎么回</b>。
        所以你能看见「我这句话把局面推到了哪儿」，而不只是被告知哪句更好。
      </p>
      <p class="hint" style="margin-top:8px">
        每局 <b>${d.rounds_per_play || 4} 个场合</b>，一个场合三句。选项上<b>不标</b>动作名字，
        选完才揭——先看名字再选，等于什么也没练到。
      </p>
    </div>

    ${played ? `<div class="card">
      <div class="meta"><span class="tag dom">你的出手习惯</span>
        <span class="tag">累计 ${played} 句</span></div>
      ${worst ? `<p class="hint" style="margin-top:8px">
        你出手最多的是「<b>${esc(chatMove(worst).name)}</b>」（${byMove[worst]} 次）。
        ${esc(chatMove(worst).why_good)}
      </p>` : ''}
      ${last ? `<p class="hint" style="margin-top:8px">
        上一局：${last.total} 句里接住了 ${last.caught} 句。
      </p>` : ''}
    </div>` : ''}

    <div class="card">
      <div class="label">六种动作（这一局只用得上这六个）</div>
      ${(d.moves || []).map((m) => `<div class="chat-move ${m.keep ? 'ok' : 'bad'}">
        <div class="chat-move-h"><span class="tag ${m.keep ? 'tag-good' : 'tag-bad'}">${esc(m.name)}</span>
        ${m.keep ? '<span class="tag">球还在</span>' : '<span class="tag">球没了</span>'}</div>
        <p class="hint">${rich(m.what)}</p>
        ${m.how ? `<p class="hint"><b>长这样：</b>${rich(m.how)}</p>` : ''}
        <p class="hint">${rich(m.why_good)}</p>
      </div>`).join('')}
      <p class="hint" style="margin-top:10px">
        注意后三种（抢球 / 掉球 / 说飞）是同一类：<b>球都掉地上了</b>。
        区别只在掉法——而「抢球」是最像热络的那一种，也是这一局最想让你看见的一种。
      </p>
    </div>

    <div class="card">
      <div class="label">为什么是这六个动作（依据）</div>
      ${(d.evidence || []).map((e) => `<div class="chat-ev">
        <div class="chat-ev-h">${esc(e.who)}</div>
        <p class="hint">${rich(e.what)}</p>
      </div>`).join('')}
      <p class="hint" style="margin-top:10px">${rich(d.caveat || '')}</p>
    </div>

    <div class="row"><button class="primary" onclick="startChatGame()">开始一局</button></div>
  `;
}

/** 对方这一轮说了什么。第 0 步是开场；后面每一步都由你上一句的 keep 决定。 */
function chatAskOf(c) {
  if (chatGame.step === 0) return c.open || [];
  const prev = chatGame.picks[chatGame.picks.length - 1];
  const st = c.steps[chatGame.step];
  return (st.ask || {})[prev && prev.choice.keep ? 'keep' : 'drop'] || [];
}

function renderChatStep() {
  const c = chatGame.queue[chatGame.i];
  const st = c.steps[chatGame.step];
  const picked = chatGame.picked != null ? st.choices[chatGame.picked] : null;
  const lastIdx = c.steps.length - 1;
  const isLast = chatGame.step === lastIdx;

  $('#view').innerHTML = `
    <div class="card">
      <div class="meta">
        <span class="tag dom">场合 ${chatGame.i + 1} / ${chatGame.queue.length}</span>
        <span class="tag">第 ${chatGame.step + 1} 句 / 共 ${c.steps.length} 句</span>
      </div>
      <h3 style="margin-top:6px">${esc(c.title)}</h3>
      <p class="chat-where">${rich(c.where)}</p>
      <blockquote class="quote">${chatAskOf(c).map((l) => `「${rich(l)}」`).join('<br>')}</blockquote>

      ${picked ? '' : `<div class="opts">
        ${st.choices.map((o, i) => `<button class="opt" onclick="answerChat(${i})">
          ${rich(o.text)}</button>`).join('')}
      </div>`}

      ${picked ? `
      <div class="block diag-mine">
        <div class="label">你这句是「${esc(chatMove(picked.move).name)}」${picked.keep
          ? '——球还在' : '——球没了'}</div>
        <p class="hint">${rich(picked.why)}</p>
      </div>
      <p class="hint" style="margin-top:10px"><b>他接着说：</b></p>
      <blockquote class="quote" id="chatNext">${
        isLast
          ? '<span class="hint">（这一案到这里就结束了）</span>'
          : ((c.steps[chatGame.step + 1].ask || {})[picked.keep ? 'keep' : 'drop'] || [])
              .map((l) => `「${rich(l)}」`).join('<br>')
      }</blockquote>
      <div class="row" style="margin-top:10px">
        <button class="primary" onclick="nextChatStep()">${isLast ? '看这一案的结果' : '下一句'}</button>
      </div>` : ''}
    </div>

    <div class="card hint">${rich(c.why)}</div>
  `;
}

function answerChat(i) {
  if (chatGame.picked != null) return;
  const c = chatGame.queue[chatGame.i];
  const st = c.steps[chatGame.step];
  const ch = st.choices[i];
  chatGame.picked = i;
  chatGame.picks.push({ caseId: c.id, step: chatGame.step, choice: ch });
  chatGame.total++;
  if (ch.keep) { chatGame.caught++; chatGame.caseKeeps++; }
  else chatGame.review.push({ caseTitle: c.title, text: ch.text, move: ch.move, why: ch.why });
  chatGame.byMove[ch.move] = (chatGame.byMove[ch.move] || 0) + 1;
  renderChatStep();
}

function nextChatStep() {
  const c = chatGame.queue[chatGame.i];
  chatGame.picked = null;
  if (chatGame.step < c.steps.length - 1) {
    chatGame.step++;
    renderChatStep();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // 这一案打完 → 按「一个场合里保住了几个球」给结局
  const k = chatGame.caseKeeps;
  chatGame.ending = (c.endings || {})[k >= 3 ? 'all' : (k === 2 ? 'some' : 'few')] || {};
  chatGame.phase = chatGame.i >= chatGame.queue.length - 1 ? 'done' : 'ending';
  if (chatGame.phase === 'done') { recordChat(); renderChatResult(); }
  else renderChatEnding();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderChatEnding() {
  const c = chatGame.queue[chatGame.i];
  const e = chatGame.ending || {};
  $('#view').innerHTML = `
    <div class="card">
      <div class="meta"><span class="tag dom">${esc(c.title)}</span>
        <span class="tag">保住 ${chatGame.caseKeeps} / ${c.steps.length} 句</span></div>
      <h3 style="margin-top:6px">${esc(e.title || '这一案结束了')}</h3>
      <p class="hint" style="margin-top:8px">${rich(e.text || '')}</p>
      <div class="row" style="margin-top:12px">
        <button class="primary" onclick="chatNextCase()">去下一个场合</button>
      </div>
    </div>
  `;
}

function chatNextCase() {
  chatGame.i++;
  chatGame.step = 0;
  chatGame.caseKeeps = 0;
  chatGame.picked = null;
  chatGame.phase = 'step';
  renderChatStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function recordChat() {
  if (chatGame.recorded) return;
  chatGame.recorded = true;
  if (!state.chat) state.chat = { plays: [], byMove: {} };
  state.chat.plays.push({ ts: Date.now(), caught: chatGame.caught, total: chatGame.total });
  if (state.chat.plays.length > 30) state.chat.plays = state.chat.plays.slice(-30);
  Object.keys(chatGame.byMove).forEach((k) => {
    state.chat.byMove[k] = (state.chat.byMove[k] || 0) + chatGame.byMove[k];
  });
  markActivity();
  save();
}

function renderChatResult() {
  const st = state.chat || { plays: [], byMove: {} };
  const byMove = st.byMove || {};
  const played = Object.keys(byMove).reduce((a, k) => a + byMove[k], 0);
  const sorted = Object.keys(byMove).sort((a, b) => byMove[b] - byMove[a]);
  const rate = chatGame.total ? Math.round((chatGame.caught / chatGame.total) * 100) : 0;

  $('#view').innerHTML = `
    <div class="card">
      <div class="meta"><span class="tag dom">这一局打完了</span>
        <span class="tag">接住 ${chatGame.caught} / ${chatGame.total} 句</span></div>
      <h2 class="today-h" style="margin-top:6px">接住率 ${rate}%</h2>
      <p class="hint" style="margin-top:8px">
        这个数不看高低，看的是<b>你掉在哪儿</b>。一次掉球不说明你不擅长闲聊；
        六次里有五次都是同一种掉法，那才是要改的地方。
      </p>
      <div class="chat-bars">
        ${sorted.map((k) => {
          const m = chatMove(k);
          const n = byMove[k];
          const w = played ? Math.round((n / played) * 100) : 0;
          return `<div class="chat-bar-row">
            <span class="chat-bar-name">${esc(m.name)}</span>
            <span class="tbar chat-bar ${m.keep ? 'keep' : 'lost'}"><i style="width:${w}%"></i></span>
            <span class="chat-bar-num">${n}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <div class="label">掉球的那些句（${chatGame.review.length} 句）</div>
      ${chatGame.review.length ? chatGame.review.map((r, i) => `
        <div class="chat-rev">
          <div class="meta"><span class="tag tag-bad">${esc(chatMove(r.move).name)}</span>
            <span class="tag">${esc(r.caseTitle)}</span></div>
          <p class="hint" style="margin-top:6px">「${rich(r.text)}」</p>
          <div class="row" style="margin-top:6px">
            <button class="plain tiny" onclick="toggleChatReview(${i})">这句怎么了</button>
          </div>
          <p class="hint" id="chatrev${i}" style="display:none;margin-top:6px">${rich(r.why)}</p>
        </div>`).join('') : `<p class="hint">
        这一局一句都没掉——${chatGame.total} 句全接住了。可以试试把场合换成更难的那种，
        或者去「场景对话」里真练一轮。</p>`}
    </div>

    <div class="card">
      <div class="label">有件事值得你知道（这不是安慰）</div>
      <p class="hint">${rich((CONTENT.chat.evidence || [])[1] ? CONTENT.chat.evidence[1].what : '')}</p>
      <p class="hint" style="margin-top:8px">
        它跟这一局直接相关：你刚才可能觉得某句话「会不会显得我很烦」而选了保守的那句。
        研究里量到的正是这件事——<b>别人对你的评价比你以为的高</b>，而且越是不好意思的人，差得越大。
        这不是让你盲目自信，只是说：<b>「他会不会觉得我烦」不能当成压住自己的理由</b>，
        因为你的估计有个稳定的偏差方向。
      </p>
    </div>

    <div class="row">
      <button class="primary" onclick="startChatGame()">再来一局</button>
      <button class="plain" onclick="chatGame = null; viewChat()">回到说明</button>
    </div>
  `;
}

function toggleChatReview(i) {
  const el = document.getElementById('chatrev' + i);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

/* ============================================================ 背景声
 *
 * 用户的要求：「我神经比较紧张，容易焦虑，所以加入音乐或者脑波。每次进入 APP
 * 之前需要询问我是否需要开，最好多来几首，让我在设置里可以更改。」
 *
 * 全部由 WebAudio **现场合成**，不含任何音频文件。两个理由：
 *   · 体积：APK 现在 0.45 MB，一首 3 分钟 mp3 就是 3–5 MB，几首就是十倍以上，
 *     还要处理版权。而这几类声音本来就能合成——噪声加滤波器就是雨和风，
 *     左右耳差几个赫兹就是双耳节拍。
 *   · 它真的无限长，不会有听得出来的循环接缝。
 *
 * 证据（这一段的结论和界面上写的一致，改动前请先读）：
 *   有证据的是**「安静听一会儿声音」**这件事本身。音乐干预的元分析（累计九千
 *   多名被试）报告的焦虑下降「与部分药物干预相当」，所以「听点东西能松下来」
 *   站得住。
 *   双耳节拍那部分要小心：被引最多的 Garcia-Argibay 等 2019 元分析（22 项研究）
 *   g≈0.45–0.58，作者自称「有希望但不算确证」；2023 年一篇脑电牵引综述里
 *   14 项只有 5 项支持、8 项相反；2023 年一项大型居家试验里它让学习表现略变差；
 *   还有综述指出双耳节拍的皮层牵引比单耳/等时节拍**更弱**。最要命的是绝大多数
 *   实验把节拍**混在音乐里**放，分不清效果来自哪个；有 2022 年双盲试验发现
 *   ASMR 与「双耳节拍+音乐」效果一样，2025 年 n≈308 的随机对照发现**单耳**
 *   节拍同样有效——都不支持「双耳」有什么特别。
 *   **所以界面上不能写「缓解焦虑」了事，必须把这段边界写出来。**
 *
 * 为什么放在 app.js 而不是新开一个 public/audio.js：
 * 新文件要在 index.html 加 script 标签、还要在 build_offline.py 里再列一次，
 * 也就是又一次「新增文件后要记得改两处清单」——这个坑这个项目已经踩过五次了。
 */
const AUDIO = {
  ctx: null, master: null, out: null, trem: null,
  nodes: [],        // 要停掉的东西（振荡器、噪声源、LFO）
  api: null,        // 当前音轨的接口
  playing: false,
  duck: 1,          // 她在说话时压到 0.35
};

function audioCfg() { return CONTENT.audio || {}; }
function audioTracks() { return CONTENT.audio.tracks || []; }
function audioTrack(id) { return audioTracks().find((t) => t.id === id) || null; }
function audioSupported() { return !!(window.AudioContext || window.webkitAudioContext); }

/* ------------------------------------------------------------------ 雨
 *
 * 用户的原话：「这个雨声有点吵，而且难听。」
 * 他是对的，而且原因很具体：原来那条雨是**一段连续的粉噪**经 1500 赫兹低通
 * 再叠一层 300 赫兹的棕噪。连续噪声低通之后剩下的是 500–1500 赫兹的一片
 * 「嘶——」，那就是"吵"；而真正的雨不是连续的，它是**成千上万个离散的撞击**，
 * 所以耳朵听到的是「沙沙沙」的颗粒感，不是「嘶」。
 * 更难看的是：那条音轨的说明里写着「中高频有细密的颗粒」——那句话在旧实现里
 * 是假的（连续噪声没有颗粒）。这是这个项目的老毛病：**说明承诺了合成没做的事**。
 * 所以这次不是调参数，而是把雨的合成方式换掉，让那句说明变成真的。
 *
 * 做法（不引入任何音频文件，仍然是纯合成）：
 *   1. 一层很低很闷的底噪（棕噪 + 低通 600 赫兹）——雨落在远处的那层垫底；
 *   2. 颗粒：按随时间起伏的密度丢出一个个"雨滴"。每一滴是一个**带通滤过的
 *      噪声短促爆发**乘以指数衰减包络，中心频率在 900–4500 赫兹之间随机。
 *      用噪声爆发而不是正弦：正弦的一声是"叮"（木琴），噪声爆发才是"啪"。
 *   3. 密度按一条慢速随机游走起伏（阵雨有疏有密），全部预先算进一段缓冲区里
 *      循环播放，所以不需要定时器、不会漂移、也不需要每滴都建一个 WebAudio 节点。
 *
 * 带通用 RBJ 双二阶带通（常数 0 dB 峰值那一型）逐滴滤波，转置直接二型。
 * Q 取 1.1：太尖就成了音高，太宽就和底噪分不开。
 */
function rainBandpass(f0, fs, q) {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0, b1: 0, b2: -alpha / a0,
    a1: -2 * Math.cos(w0) / a0, a2: (1 - alpha) / a0,
  };
}

/** 生成一段雨。全程纯计算，没有任何 WebAudio 节点——所以它是可以在 Node 里
 *  单独验的对象（tools/check_audio.js 直接调它，数颗粒）。 */
function rainBuffer(ctx, seconds, p) {
  const fs = ctx.sampleRate;
  const len = Math.floor(fs * seconds);
  const buf = ctx.createBuffer(1, len, fs);
  const d = buf.getChannelData(0);

  /* 1. 底噪：棕噪（白噪积分）经一个单极点低通，让它更闷。
        不用 noiseBuffer() 是因为这里要的就是一次平滑，别再多建一层函数。 */
  const bed = p.bed || {};
  let brown = 0, smooth = 0;
  const bedCut = Math.min(0.95, 2 * Math.PI * (bed.lowpass || 600) / fs);
  const bedGain = bed.gain != null ? bed.gain : 0.5;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    brown = (brown + 0.02 * w) / 1.02;
    smooth += bedCut * (brown * 3.5 - smooth);
    d[i] = smooth * bedGain;
  }

  /* 2. 颗粒。密度围绕 1.0 轻微起伏（实测每 0.5 秒一个控制点、落在 0.72–1.16 之间）。
        原来写的是一条**带反射壁的随机游走**（0.25–1.6）：这类过程会在壁上趴很久，
        也就是雨几乎停掉一大段、然后突然变密——对一条要当背景循环的雨来说这是错的，
        而且均值会漂（"每秒几滴"这个参数就变得不好使了）。现在改成向 1.0 回归的过程，
        只有 ±25% 的轻微疏密，像真的小雨那样是稳的。
        想要"阵雨"的疏密对比是另一条音轨的事，不该做在一条背景雨里。 */
  const dr = p.drops || {};
  const perSec = dr.perSecond != null ? dr.perSecond : 34;
  const fMin = dr.fMin || 900, fMax = dr.fMax || 4500;
  const tau = dr.decay || 0.02;              // 衰减时间常数（秒）
  const dGain = dr.gain != null ? dr.gain : 0.5;
  const q = dr.q || 1.1;
  // 每 0.5 秒一个控制点，两点之间线性插值
  const seg = Math.max(1, Math.floor(fs * 0.5));
  const nSeg = Math.ceil(len / seg) + 2;
  const walk = [];
  let lvl = 1;
  for (let i = 0; i < nSeg; i++) {
    lvl += (1 - lvl) * 0.3 + (Math.random() - 0.5) * 0.3;
    lvl = Math.max(0.6, Math.min(1.5, lvl));
    walk.push(lvl);
  }
  const densAt = (i) => {
    const x = i / seg, k = Math.floor(x), t = x - k;
    const a = walk[Math.min(k, nSeg - 1)], b = walk[Math.min(k + 1, nSeg - 1)];
    return perSec * (a + (b - a) * t);
  };

  const burstN = Math.max(64, Math.ceil(tau * 5 * fs));   // 一滴占的样本数
  let t = 0, zi1 = 0, zi2 = 0;   // 转置直接二型的状态
  let made = 0;                  // 真的丢出了多少滴（测试要数它，见 buf.dropsGenerated）
  while (t < len) {
    // 下一滴什么时候来：按当前密度的指数分布间隔 → 泊松过程，天然不均匀
    const rate = Math.max(1e-3, densAt(t));
    t += Math.max(1, Math.round(-Math.log(1 - Math.random()) / rate * fs));
    if (t >= len) break;
    made++;
    const f0 = fMin + Math.random() * (fMax - fMin);
    const co = rainBandpass(f0, fs, q);
    // 幅度：小雨滴多、大雨滴少，所以用平方让分布偏向小声（听着更自然）
    const amp = dGain * (0.25 + 0.75 * Math.pow(Math.random(), 2));
    zi1 = 0; zi2 = 0;
    const n = Math.min(burstN, len - t);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (tau * fs));
      const x = (Math.random() * 2 - 1) * env;
      const y = co.b0 * x + zi1;
      zi1 = co.b1 * x - co.a1 * y + zi2;
      zi2 = co.b2 * x - co.a2 * y;
      d[t + i] += y;
    }
  }

  /* 3. 归一化 + 只有顶部才起作用的软拐点。
        按"最响的那一瞬间"去归一化是错的：雨里偶尔几滴撞在一起，那一瞬间会把
        整段压得很小，剩下的雨声就全变成又轻又平的一片——颗粒感正是这样被压没的。
        但**整段都過 tanh 也不行**：那等于给每一滴都做压缩，颗粒又被抹平了
        （试过，峭度从 4.9 掉到 3.6）。所以拐点只放在 0.5 以上：
        0.5 以下是完全透明的（绝大多数雨滴都在这一段，颗粒原样保留），
        只有偶尔撞在一起的那几处被连续压下去，而不会硬切成"啪"的破音。 */
  const samp = [];
  for (let i = 0; i < len; i += 7) samp.push(Math.abs(d[i]));
  samp.sort((a, b) => a - b);
  const p995 = samp[Math.floor(samp.length * 0.995)] || 1e-9;
  const k = 0.5 / p995;
  const knee = 0.5, span = 1 - knee;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    let x = d[i] * k;
    const a0 = Math.abs(x);
    if (a0 > knee) x = (x < 0 ? -1 : 1) * (knee + span * Math.tanh((a0 - knee) / span));
    const y = x * 0.9;
    d[i] = y;
    const a = Math.abs(y); if (a > peak) peak = a;
  }
  /* 丢掉多少滴记在 buffer 上。不是为了给界面看，是为了让"每秒几滴"这个参数
     有一个可验的落点——否则它又是「声明了但没人读」的那类参数。
     实测（tools 里数过）：这个数 ≈ perSecond × 秒数 × 0.6~1.0。 */
  buf.dropsGenerated = made;
  return buf;
}


/* 白噪 / 粉噪 / 棕噪。
   粉噪用 Paul Kellet 的那套近似（几个一阶低通加权求和），棕噪就是白噪积分。
   自己算而不是找样本，是为了整条链路零资源——上面那段注释说了原因。 */
function noiseBuffer(ctx, color, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = d[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * d[i]) / 1.02; d[i] = last * 3.5; }
  }
  return buf;
}

function audioEnsureCtx() {
  if (AUDIO.ctx) return AUDIO.ctx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  const ctx = new C();
  AUDIO.ctx = ctx;
  AUDIO.master = ctx.createGain();
  AUDIO.master.gain.value = 0;             // 一律从 0 淡入，避免"啪"的一声
  AUDIO.master.connect(ctx.destination);
  return ctx;
}

/** 一个滤波层。params 里 lowpass / highpass / bandpass 各建一个。 */
function audioFilter(ctx, kind, freq, depth, lfoRate) {
  const f = ctx.createBiquadFilter();
  f.type = kind;
  f.frequency.value = freq;
  f.Q.value = kind === 'bandpass' ? 0.8 : 0.7;
  let lfo = null;
  if (depth && lfoRate) {
    // 缓慢扫频：这是"海浪"和"风"唯一区别于白噪声的地方
    lfo = ctx.createOscillator();
    lfo.frequency.value = lfoRate;
    const amt = ctx.createGain();
    amt.gain.value = depth;
    lfo.connect(amt); amt.connect(f.frequency);
    lfo.start();
  }
  return { node: f, lfo };
}

/** 一层噪声：源 + 滤波链。preset 给了就用它当源（雨那种预先算好的复合波形）。 */
function audioNoiseLayer(ctx, p, preset) {
  const stops = [];
  const src = ctx.createBufferSource();
  src.buffer = preset || noiseBuffer(ctx, p.color || 'pink', 6);
  src.loop = true;
  let last = src;
  for (const [k, kind] of [['highpass', 'highpass'], ['bandpass', 'bandpass'], ['lowpass', 'lowpass']]) {
    if (!p[k]) continue;
    const depth = k === 'bandpass' ? p.bandpassDepth : p.lowpassDepth;
    const rate = k === 'bandpass' ? p.bandpassLfo : p.lowpassLfo;
    const f = audioFilter(ctx, kind, p[k], depth, rate);
    last.connect(f.node);
    last = f.node;
    if (f.lfo) stops.push(f.lfo);
  }
  const g = ctx.createGain();
  g.gain.value = p.gain != null ? p.gain : 1;
  last.connect(g);
  src.start();
  stops.push(src);
  return { node: g, stops };
}

/** 按音轨定义搭出整条链。返回 { head, stops }。 */
function audioBuild(ctx, track) {
  const p = track.params || {};
  const stops = [];
  const head = ctx.createGain();
  head.gain.value = 1;

  if (track.kind === 'binaural') {
    /* 双耳节拍：左右耳各一个正弦，差几赫兹。
       必须用 ChannelMerger 而不是 StereoPanner——要的是**两只耳朵听到的频率
       真的不一样**，差一点点都不行（外放出来会变成一个颤音，那就不是它了）。 */
    const merger = ctx.createChannelMerger(2);
    [[p.carrier, 0], [p.carrier + p.beat, 1]].forEach(([f, ch]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      o.connect(g);
      g.connect(merger, 0, ch);
      o.start();
      stops.push(o);
    });
    merger.connect(head);
  } else if (track.kind === 'drone') {
    const vs = p.voices || [];
    vs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = p.type || 'sine';
      o.frequency.value = f;
      // 轻微失谐：两个同频率的正弦叠在一起会呆板，差几音分就有"活"的感觉
      o.detune.value = (i % 2 ? 1 : -1) * (p.detune || 0);
      const g = ctx.createGain();
      g.gain.value = 1 / Math.max(1, vs.length);
      o.connect(g);
      g.connect(head);
      o.start();
      stops.push(o);
    });
    /* 铺底下面也可以垫一层噪声（「深夜」用它加一层低频的沙沙）。
       这一段是补上的：数据里先写了 layer_noise，而引擎只对 kind='noise' 读 layer，
       于是那个参数**被静默忽略**——界面上说"一层棕噪"，实际什么都没放。
       数据和代码不一致时，界面上那句说明就成了假话，所以两边都要管。 */
    if (p.layer_noise) {
      const l = audioNoiseLayer(ctx, p.layer_noise);
      l.node.connect(head);
      stops.push(...l.stops);
    }
  } else if (track.kind === 'rain') {
    /* 雨：预先把「底噪 + 颗粒」算成一段波形，再走和噪声音轨一样的滤波链。
       滤波链只留两个作用——削掉最上面的嘶声、垫掉最下面的隆隆声；
       雨的质感在缓冲区里就已经成形了（见 rainBuffer 上面那段注释）。 */
    const preset = rainBuffer(ctx, p.bufferSeconds || 16, p);
    const l = audioNoiseLayer(ctx, {
      highpass: p.highpass || 90,
      lowpass: p.lowpass || 5200,
      gain: p.mixGain != null ? p.mixGain : 1,
    }, preset);
    l.node.connect(head);
    stops.push(...l.stops);
    if (p.layer) {                     // 再垫一层（大雨的低频轰鸣）
      const l2 = audioNoiseLayer(ctx, p.layer);
      l2.node.connect(head);
      stops.push(...l2.stops);
    }
  } else {
    const l = audioNoiseLayer(ctx, p);
    l.node.connect(head);
    stops.push(...l.stops);
    if (p.layer) {                     // 雨下面的那层低频轰鸣
      const l2 = audioNoiseLayer(ctx, p.layer);
      l2.node.connect(head);
      stops.push(...l2.stops);
    }
  }

  const out = ctx.createGain();
  out.gain.value = p.gain != null ? p.gain : 0.6;
  head.connect(out);

  // 起伏。没有它，噪声听起来是"机器"，有了才像自然里的东西。
  let trem = null;
  if (p.tremolo && p.tremoloDepth) {
    trem = ctx.createGain();
    trem.gain.value = 1 - p.tremoloDepth / 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.tremolo;
    const amt = ctx.createGain();
    amt.gain.value = p.tremoloDepth / 2;
    lfo.connect(amt); amt.connect(trem.gain);
    lfo.start();
    stops.push(lfo);
    out.connect(trem);
    trem.connect(AUDIO.master);
  } else {
    out.connect(AUDIO.master);
  }
  return { stops, out };
}

/** 目标音量 = 设置里的音量 × 是否正在朗读（她说话时压下去） */
function audioTargetGain() {
  const v = Math.max(0, Math.min(1, Number(settings().audioVolume)));
  const base = isFinite(v) ? v : 0.22;
  return base * (AUDIO.duck || 1);
}

function audioApplyGain(seconds) {
  if (!AUDIO.ctx || !AUDIO.master) return;
  const g = AUDIO.master.gain;
  const t = AUDIO.ctx.currentTime;
  const target = AUDIO.playing ? audioTargetGain() : 0;
  try {
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + (seconds || 0.8));
  } catch (e) { g.value = target; }
}

/* ------------------------------------------------- 用户自己的音乐（原生播放）
 *
 * 为什么不是内置几首歌：用户说「自用、不商用，有版权的也行」。但把别人的商业唱片
 * 打包进 APK 不因为自用就成立，而且**我做不了这个决定**——我不知道那些文件的来源，
 * 也不该让他为了听一首歌而把来源不明的东西塞进一个要长期用、要能干净卸载的 App。
 * 能做、而且更好的那条路是：放**他自己手机里**的音乐。
 * 选一次，App 记住（持久化 URI 授权，重启还在），卸载就全没了——
 * 我们没有复制他的文件，也没有留下任何残留。
 *
 * 播放交给原生的 MediaPlayer（见 MainActivity 里 musicPlay 上面那段），
 * 因为一首歌几十兆，网页里 <audio> 还要拿到能长期访问的地址。
 * 网页这边只负责三件事：把「我自己的音乐」当成一条音轨出现在列表里、
 * 把音量/压低转给原生、以及把原生的状态如实显示出来。
 */
const MY_TRACK = '__mine';
function musicSupported() { return !!(V.native && V.caps.music); }
function myTrack() {
  const m = V.music || {};
  return {
    id: MY_TRACK, kind: 'native', headphone: false,
    name: m.name ? ('我自己的音乐：' + m.name) : '我自己的音乐',
    desc: m.has
      ? '放你手机里的这个文件。不复制、不上传，卸载 App 不会动它。'
      : '从手机里挑一个音频文件当背景声（mp3 / m4a / flac / wav 都行）。',
  };
}
/** 列表里显示的条目：合成的音轨 + （原生可用时）「我自己的音乐」 */
function allTracks() {
  const t = audioTracks().slice();
  if (musicSupported()) t.push(myTrack());
  return t;
}
/** 只停合成音轨（不动原生音乐）。从合成切到自己的音乐时要先走这一步，
 *  否则两条声音会一起响——合成那条是网页里的节点，原生那条根本不知道它还在。 */
function stopSynthOnly() {
  (AUDIO.nodes || []).forEach((n) => { try { n.stop(); } catch (e) { } });
  AUDIO.nodes = [];
}

function musicStart() {
  if (!musicSupported()) { toast('网页里放不了手机本地文件，装到手机上才有这一条。'); return false; }
  if (!V.music.has) { toast('先挑一个文件'); openSettings('sound'); return false; }
  if (AUDIO.track !== MY_TRACK) stopSynthOnly();   // 合成那条要让位
  try { V.native.musicPlay(); } catch (e) { toast('调不动原生播放器'); return false; }
  AUDIO.track = MY_TRACK;
  AUDIO.playing = true;
  saveSettings({ audioTrack: MY_TRACK });
  renderAudioFab();
  V.native.musicSetVolume(Number(settings().audioVolume) || 0.22);
  return true;
}
function musicStop() {
  if (!musicSupported()) return;
  try { V.native.musicStop(); } catch (e) { }
  if (AUDIO.track === MY_TRACK) { AUDIO.playing = false; AUDIO.track = null; renderAudioFab(); }
}
/** 原生的状态回来。type: picked/playing/stopped/error/cancel/forgot/state */
function onMusicState(o) {
  /* 原生发过来的是 JSON 字符串，不是对象——这里原来写的是
     `typeof o !== 'object'` 就 return，于是「选好了」的提示和播放状态
     更新一次都没生效过，而且完全不报错。见 voice.js 里 bridgeObj 的说明。 */
  o = bridgeObj(o);
  if (!o) return;
  V.music = {
    has: !!o.has, name: o.name || '', playing: !!o.playing,
    persist: o.persist !== false,
  };
  if (o.type === 'picked') {
    /* 拿不到"重启后仍然有效"的授权时要说出来。不说的话，用户下次打开发现
       放不了、却不知道是为什么——那正是这个项目一直在防的「假成功」。 */
    toast(o.persist === false
      ? '选好了。但这个文件只授权了这一次，重启后可能要重新选一遍。'
      : '选好了：' + (o.name || ''));
  } else if (o.type === 'playing') {
    /* 原生那边真的开始放了。这里要先把合成那条停掉：用户可能正放着「雨」，
       然后去挑了一个音乐文件——原生直接开始放，而网页里那层噪声还在响，
       两条会叠在一起（原生根本不知道网页里还有声音）。 */
    if (AUDIO.playing && AUDIO.track && AUDIO.track !== MY_TRACK) stopSynthOnly();
    AUDIO.track = MY_TRACK; AUDIO.playing = true; renderAudioFab();
  } else if (o.type === 'stopped' || o.type === 'forgot') {
    if (o.type === 'forgot') toast('已经忘掉这个文件（你手机里的音乐本身没动）');
    if (AUDIO.track === MY_TRACK) { AUDIO.playing = false; AUDIO.track = null; renderAudioFab(); }
  } else if (o.type === 'error') {
    toast(o.detail || '音乐放不出来');
    if (AUDIO.track === MY_TRACK) { AUDIO.playing = false; AUDIO.track = null; renderAudioFab(); }
  }
  // 设置页开着就刷新那一块（不整体重画，否则滚动位置会跳）
  const box = document.getElementById('musicBox');
  if (box) box.innerHTML = musicBoxHtml();
}
window.__onMusic = onMusicState;

function audioStart(id) {
  if (id === MY_TRACK) return musicStart();
  const track = audioTrack(id) || audioTrack(audioCfg().default_track) || audioTracks()[0];
  if (!track) { toast('音轨数据没加载。'); return false; }
  if (!audioSupported()) { toast('这台手机的浏览器不支持实时合成音频，放不了背景声。'); return false; }
  if (AUDIO.playing && AUDIO.track === track.id) return true;
  audioStop(true);
  const ctx = audioEnsureCtx();
  if (!ctx) return false;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } }
  try {
    const built = audioBuild(ctx, track);
    AUDIO.nodes = built.stops;
    AUDIO.out = built.out;
    AUDIO.track = track.id;
    AUDIO.playing = true;
    audioApplyGain(1.6);
    saveSettings({ audioTrack: track.id });
    renderAudioFab();
    return true;
  } catch (e) {
    toast('这个音轨没能起来：' + (e.message || e));
    AUDIO.nodes = [];
    AUDIO.playing = false;
    return false;
  }
}

function audioStop(silent) {
  // 自己选的那个音乐文件走的是原生播放器，和合成音轨要分开停
  if (AUDIO.track === MY_TRACK) {
    musicStop();
    return;
  }
  if (!AUDIO.ctx) { AUDIO.playing = false; return; }
  if (AUDIO.playing) audioApplyGain(0.5);
  const nodes = AUDIO.nodes;
  const delay = silent ? 0 : 600;      // 淡出之后再真正掐掉，否则会"啪"一声
  const kill = () => nodes.forEach((n) => { try { n.stop(); } catch (e) { } });
  if (delay) setTimeout(kill, delay); else kill();
  AUDIO.nodes = [];
  AUDIO.playing = false;
  AUDIO.track = null;
  renderAudioFab();
}

function audioToggle() {
  if (AUDIO.playing) { audioStop(); toast('背景声已关'); return; }
  const id = settings().audioTrack || audioCfg().default_track;
  if (audioStart(id)) {
    // 名字要从 allTracks() 里查：自己那条音乐不在合成音轨表里，
    // 拿 audioTrack('__mine') 会是 null，toast 就会显示 "已开：undefined"
    const t = allTracks().find((x) => x.id === id) || {};
    toast('背景声已开：' + (t.name || ''));
  }
}

/** 她在朗读时把背景声压下去。
 *  不这么做的话，两个声音会互相盖——TTS 是语音，音乐盖住它比反过来更糟。 */
function audioDuck(on) {
  const want = on ? 0.35 : 1;
  if (AUDIO.duck === want) return;
  AUDIO.duck = want;
  if (AUDIO.playing) audioApplyGain(0.35);
  // 她说话时，用户自己的音乐也要压低——否则合成音轨压了、音乐没压，
  // 听着就是"她的声音被音乐盖住"，而那正是这一条要解决的问题。
  if (musicSupported()) { try { V.native.musicDuck(!!on); } catch (e) { } }
}

/* 挂在 __onSpeak 上，而不是去改 voice.js 里的那个函数。
   跨文件的调用点越少越好；这里只包一层，转发原样。 */
(function hookAudioDuck() {
  const prev = window.__onSpeak;
  window.__onSpeak = function (state) {
    if (state === 'start') audioDuck(true);
    else if (state === 'done' || state === 'error' || state === 'stop' || state === 'unavailable') audioDuck(false);
    if (prev) return prev.apply(this, arguments);
  };
})();

function renderAudioFab() {
  const el = document.getElementById('audioFab');
  if (!el) return;
  const on = AUDIO.playing;
  el.classList.toggle('on', on);
  el.title = on ? '关掉背景声' : '开背景声（设置里可以换音轨）';
  el.innerHTML = `<span class="audio-note">${on ? '♪' : '♪'}</span>${on ? '响着' : '声音'}`;
}

/* ---------------------------------------------------------------- 进入时询问 */
/** 每次进来问一次（用户明确要的）。但「以后别再问」要能生效，
 *  否则这就是个每次都要点掉的弹窗——那种东西的结局是用户开始讨厌这个 App。 */
function maybeAskAudio() {
  const s = settings();
  if (!s.audioAsk) return;
  if (!audioSupported()) return;
  if (AUDIO.playing) return;
  // 别和别的东西抢屏幕：闸门和「恢复备份」都是启动时可能出现的浮层
  if (document.querySelector('.sheet.open') || document.querySelector('.gate')) return;
  const cfg = audioCfg();
  const want = s.audioTrack || cfg.default_track;
  const cur = allTracks().find((t) => t.id === want) || audioTrack(cfg.default_track);
  /* 选的是自己那条音乐、但文件已经不在了（被删/授权失效）：问的时候就说清楚，
     否则用户会以为"App 坏了"。原生的状态由 __onMusic 送过来，这里只读。 */
  const mineBroken = want === MY_TRACK && !(V.music || {}).has;
  const sh = document.createElement('div');
  sh.className = 'sheet open';
  sh.innerHTML = `<div class="inner" onclick="event.stopPropagation()">
    <h2 style="margin:6px 0 8px">要不要放点声音</h2>
    <p class="hint" style="margin-bottom:14px">
      你说过容易紧张、容易焦虑，所以每次进来都问一次。
      ${cur ? `现在选的是「<b>${esc(cur.name)}</b>」` : ''}，设置里可以换。
    </p>
    ${mineBroken ? `<p class="warnbox" style="margin-bottom:12px">
      你上次选的是自己手机里的一个音乐文件，但它现在读不到了（可能被删掉、
      或者移走了）。到设置里重选一个就行。</p>` : ''}
    <div class="row" style="flex-direction:column;gap:9px">
      <button class="primary" onclick="closeSheet();audioToggle()">
        ${AUDIO.playing ? '关掉' : '放起来'}</button>
      <button class="ghost" onclick="closeSheet()">这次不用</button>
      <button class="plain" onclick="closeSheet();setAudioAsk(false)">以后别再问了（设置里能开回来）</button>
    </div>
    <p class="hint" style="margin-top:12px">
      说清楚一句：这一类声音有证据的部分是<b>「安静听一会儿」</b>这件事本身，
      双耳节拍那部分证据是不明的。所以它是个让人松一点的小工具，不是治疗。
    </p>
  </div>`;
  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
}

function setAudioAsk(on) {
  saveSettings({ audioAsk: !!on });
  toast(on ? '以后每次进来都会问' : '以后不再问，设置里可以开回来');
}

/* 二级切换条只在 showTab() 里注入一次，而不是改十几个渲染函数各加一遍。
   这样新增子视图不用动任何已有代码。 */
const SUBNAV = {
  practice: () => subTabs([['cards', '卡片'], ['calib', '语境校准'], ['learn', '微课'],
    ['signal', '信号场'], ['chat', '闲聊']],
    practiceSubview, 'setPracticeSubview'),
  ai: () => subTabs([['voice', '场景对话'], ['checkup', '表达体检'], ['replay', '真实复盘']],
    aiSubview, 'setAiSubview',
    // 数字直接写进标签里（talkCountLabel 会给「历史」或「历史 3」），
    // 不用一个额外的空 <em> 再等着谁来填——那种"看着有、其实没有"的占位
    // 在这个项目里出过好几次。
    `<button class="chip-btn subnav-act" onclick="openTalkHistory()"
       title="以前练过的对话和当时的分析">📋 ${typeof talkCountLabel === 'function' ? talkCountLabel() : '历史'}</button>`),
  growth: () => subTabs([['stages', '阶段'], ['bias', '偏差画像'], ['plans', '我的预案']],
    growthSubview, 'setGrowthSubview'),
};

function injectSubnav(tab) {
  const f = SUBNAV[tab];
  if (!f) return;
  const v = document.getElementById('view');
  if (v) v.insertAdjacentHTML('afterbegin', f());
}


/** 今天页：一眼看到「今天要做什么、达标了没、闸门开着吗」。 */
function renderToday() {
  const p = dailyProgress();
  const cfg = dailyCfg();
  const cur = currentStage();
  const g = state.gate || {};

  // 闸门那张卡不许只看 armed。armed 算的是「你想拦 + 今天还没达标」，
  // 也就是**意图**；而系统那边完全可能已经把无障碍服务撤了（划掉应用就是这种情况）。
  // 那时候 card 上写着「闸门已开、打开应用会先弹这个页面」——是句假话，
  // 而且用户只有真去打游戏才发现。所以这里必须跟系统对一次账。
  // 这一条和「达标要判对才算」是同一个道理：界面说的必须是事实，不是期望。
  const gateLive = !!window.EQNative && !!EQNative.hasAccessibility
    ? EQNative.hasAccessibility() : null;   // null = 不在 App 里，判断不了
  const gateBroken = g.armed && gateLive === false;

  $('#view').innerHTML = `
    <div class="card today-card ${p.met ? 'today-met' : ''}">
      <div class="meta">
        <span class="tag dom">${p.met ? '✓ 今日达标' : '今日任务'}</span>
        ${state.streak.count ? `<span class="tag">🔥 连续 ${state.streak.count} 天</span>` : ''}
      </div>

      <!-- 一句话把「今天到底要做什么」说完。
           原来这里只有三个数字方块（0 / 需 4），要读的人自己做减法才知道
           还差什么；而且「加练」跟两个必做项并排摆着，看起来一样是任务。
           现在必做和可选分开，必做的用一句人话说清楚。 -->
      <h2 class="today-h">${p.met ? '今天做完了' : '今天要做这几件'}</h2>
      <p class="today-what">${todayWhat(p, cfg)}</p>

      <div class="tbar today-bar"><i style="width:${p.pct}%"></i></div>

      <div class="todo-list">
        ${todoRow('卡片', p.cards, p.tg.cards, (cfg.labels || {}).cards || '张卡片', p.met)}
        ${todoRow('微课', p.lessons, p.tg.lessons, (cfg.labels || {}).lessons || '条微课', p.met)}
      </div>
      ${(!p.met && p.tried > p.cards) ? `<p class="hint" style="margin-top:8px">今天你答了 ${p.tried} 张，其中 <b>判对 ${p.cards} 张</b>。没判对的不算——护城河拦的就是「点过去」。判错了正好，那才是要练的地方。</p>` : ''}

      ${p.met ? `<div class="todo-extra">加练 ${p.extra} 次（可选，不达标也不影响）</div>` : ''}

      <div class="row">
        <button class="${p.met ? 'ghost' : 'primary'}" onclick="${nextAction(p).fn}">${nextAction(p).label}</button>
      </div>
      ${p.met ? '' : `<p class="hint">${esc((cfg.skipRule || {}).once || '')}${p.skipped ? ' 今天已经跳过一次了。' : ''}</p>`}
      ${!p.met && p.skipped ? `<div class="row"><button class="plain" onclick="openFog('每日计划')">脑雾通道</button></div>` : ''}
    </div>

    ${g.enabled ? `<div class="card gate-status ${gateBroken ? 'gate-broken' : (g.armed ? 'armed' : '')}">
      <div class="meta"><span class="tag ${gateBroken ? 'tag-bad' : (g.armed ? 'tag-warn' : 'tag-good')}">${
        gateBroken ? '闸门失效了' : (g.armed ? '闸门已开' : '闸门已解除')}</span>
        <span class="tag">${(g.packages || []).length} 个目标应用</span></div>
      <p class="hint" style="margin-top:8px">${gateBroken
        ? '开关是开的，但<b>系统那边已经把无障碍服务关掉了</b>，所以现在拦不住任何东西。'
          + '多半是你从最近任务里划掉过它——Android 会顺手撤销无障碍服务，而且不会自己恢复。'
          + '想彻底解决就打开「防掉线」（需要 root），开了之后它会自己装回来。'
        : (g.armed
          ? '没达标之前，打开你指定的应用会先弹这个页面。达标之后自动解除。'
          : '今天已达标，游戏随便打。')}</p>
      <div class="row"><button class="plain" onclick="openDailySettings()">设置</button></div>
    </div>` : ''}


    <div class="card">
      <div class="meta"><span class="tag dom">第 ${cur.def.id} 关</span>
        <span class="tag">${esc(cur.def.sub)}</span></div>
      <h3 style="margin-top:6px">${esc(cur.def.name)}</h3>
      <p class="hint" style="margin-top:6px">${esc(cur.def.capability)}</p>
      <div class="row">
        <button class="ghost" onclick="go('growth')">看还差什么</button>
        <button class="plain" onclick="showBoundary()">天花板</button>
      </div>
    </div>`;
}

/* ============================================================ 视图表 */

/* 四个入口，按**用途**分，不按功能列表分：
 *   今天  —— 该做什么（入口）
 *   练习  —— 离线训练三件：卡片 / 语境校准 / 微课
 *   AI    —— 要联网的三件：场景对话 / 表达体检 / 真实复盘
 *   成长  —— 看进度：阶段 / 偏差画像 / 我的预案
 *
 * 原来底部五个，而且「练习 → 卡片 → 刷卡片／我的预案／偏差画像」是三层：
 * 那一层里「我的预案」和「偏差画像」根本不是练习，是看进度，所以它们搬到成长，
 * 卡片那一路就只剩一层。用户的原话是「很多窗口可以归为一类」「不要把它摊开」——
 * 归并的判据就是「这是练的，还是看的」，不是「它原来是哪个菜单里的」。 */
const VIEWS = {
  today: renderToday,
  practice: () => {
    if (practiceSubview === 'cards') viewCards();
    else if (practiceSubview === 'calib') viewCalib();
    else if (practiceSubview === 'signal') viewSignal();
    else if (practiceSubview === 'chat') viewChat();
    else viewLearn();
  },
  ai: () => {
    if (aiSubview === 'voice') renderPractice();
    else if (aiSubview === 'checkup') viewCheckup();
    else viewReplay();
  },
  growth: () => {
    if (growthSubview === 'stages') renderStages();
    else if (growthSubview === 'bias') { cardsView = 'bias'; viewCards(); }
    else { cardsView = 'plans'; viewCards(); }
  },
};

/* 每一路 tab 的默认子页。点底部 tab 时回到这里。
 *
 * 为什么必须重置：四个子页状态（practiceSubview / aiSubview / growthSubview /
 * cardsView）都是模块级变量，**切走再切回来会保留上次的位置**。于是出现过
 * 「去过成长→我的预案，再点练习，练习下面渲染出的是预案页」这种串台，
 * 以及「点 AI 看到的不是场景对话」这种困惑。
 *
 * 让子页状态属于「这一次浏览」而不是「整个 App」，行为就唯一了：
 * 点进来永远是这一路的第一个页面，想深入用页内的二级切换。
 * 需要「回到我刚才那页」的场景本来就不存在——四个 tab 的内容各自独立。 */
const TAB_HOME = {
  today: null,          // 今天页没有二级子页
  practice: 'cards',
  ai: 'voice',
  growth: 'stages',
};

/** 切到某个 tab 并重画，**不动**子页状态。
 *  二级切换条（setXxxSubview）和 goPracticeCards 用它。 */
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0 });
  VIEWS[tab]();
  injectSubnav(tab);   // 二级切换条统一在这里加，渲染函数不用各自关心
}

/** 点底部 tab 用的：先回到这一路的默认子页，再画。
 *
 *  两个函数长得像，后果正相反，所以分开：
 *  go()      = 从外面进这一路  → 丢弃上次的子页，永远落在第一个页面
 *  showTab() = 已经在这一路里  → 保留子页，只换内容
 *  混用的后果在 2.22 上真出现过一次：setAiSubview 调 go，
 *  于是「表达体检」「真实复盘」两个按钮点了就弹回场景对话。 */
function go(tab) {
  const home = TAB_HOME[tab];
  if (home) {
    if (tab === 'practice') { practiceSubview = home; cardsView = 'drill'; }
    else if (tab === 'ai') { aiSubview = home; }
    else if (tab === 'growth') { growthSubview = home; }
  }
  showTab(tab);
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => go(b.dataset.tab));
});

/* ============================================================ 启动 */

(async function boot() {
  renderHeader();
  try {
    const r = await fetch('/api/content');
    const j = await r.json();
    // 不要在这里写白名单。原来是一个键一个键列的，加了 stages.json 之后
    // 忘了往上加，结果是 CONTENT.stages 一直是 null、阶段页显示「内容还没加载」，
    // 而接口本身返回得好好的——这种失败模式没有任何报错，只能靠人肉记。
    // 改成吸收服务端返回的每一个内容键，新增数据文件就自动生效。
    Object.keys(j || {}).forEach((k) => {
      if (k !== 'ok' && j[k] && typeof j[k] === 'object') CONTENT[k] = j[k];
    });
  } catch (e) {
    toast('内容加载失败，请确认服务已启动');
  }
  try {
    const r = await fetch('/api/progress');
    const j = await r.json();
    if (j.progress && Object.keys(j.progress).length) {
      const local = localStorage.getItem(LS_KEY);
      if (!local) { state = Object.assign(structuredClone(DEFAULT_STATE), j.progress); save(false); }
    }
  } catch (e) { /* 离线也要能用 */ }

  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    aiReady = !!j.has_key;
  } catch (e) { aiReady = false; }
  const dot = $('#aiDot');
  dot.className = 'dot ' + (aiReady ? 'on' : 'off');
  dot.title = aiReady
    ? 'AI 陪练可用'
    : (window.__EQ_OFFLINE__
        ? '离线版：AI 模块需在电脑上运行 server.py'
        : 'AI 陪练不可用：未找到 DEEPSEEK_API_KEY（离线模块不受影响）');

  go('today');   // 落地在「今天」：打开先看到达标进度和该做什么

  // 闸门：原生在目标应用被打开时用 ?gate=1 拉起本页 → 强制显示，不给跳过按钮。
  // 否则只在「今天还没达标、且今天没用过跳过」时拦一下。
  // 闸门是覆盖层，底层界面照常渲染，所以不会挡住加载。
  const forced = /[?&]gate=1/.test(location.search);
  // root 的探测结果**故意不跨启动保留**：root 是会变的（系统更新、换机、Magisk 被
  // 关掉）。留着一个上次的 true，界面就会拍胸脯说有深度拦截，而实际早就没有了。
  // 宁可每次都显示「还没检测过」，也不显示一个可能已经过期的「可用」。
  state.gate = state.gate || {};
  state.gate.rootKnown = false;
  state.gate.rootOk = false;
  syncGate();

  /* 防掉线：用户开过的话，每次启动顺手确认一遍它还在跑。
     守夜脚本用 mkdir 锁做了幂等，已经在跑的实例会让新实例直接退出，
     所以这里重复调用是安全的；而它正好兜住「循环被系统清掉了」——
     下次打开应用就把它装回去。
     只在用户自己开过的时候才做：没开过就绝不去碰 root。 */
  if (state.gate.watch && state.gate.watch.want
      && window.EQNative && EQNative.setGateWatch) {
    try { EQNative.setGateWatch(1); } catch (e) { /* 面板上会如实显示它没跑起来 */ }
  }

  // 重装之后把上次留在「下载」里的那份捞回来。
  //
  // 用 offer（点一下才恢复），不是静默自动恢复：覆盖进度是破坏性的，
  // 而且「卸载了、又装回来、数据自己全回来了」这件事如果不说一声就发生，
  // 观感上像软件删不干净。所以要问一句，而且是用户自己点。
  maybeOfferRestore();

  const dp = dailyProgress();
  if (!dp.met && (forced || !dp.skipped)) openGate(forced);

  /* 背景声的开关要先把状态画对，否则用户在设置里开了、回到界面看到的是「声音」
     而不是「响着」。询问放在最后，而且放在一个 timeout 里：
     启动时可能已经有浮层（闸门 / 恢复备份），浮层叠浮层会变成一坨。 */
  renderAudioFab();
  /* 自己那条音乐的状态在原生那一边（选过没有、在不在放）。
     启动时问一次，否则界面上会出现"列表里显示已选、实际上没选"这种假状态。 */
  if (musicSupported()) {
    try { V.native.musicState(); } catch (e) { }
  }
  setTimeout(maybeAskAudio, 900);
})();

/* 只有「本地是空的」才提恢复。本地有数据的时候弹这个框只会烦人，
   而且会诱导用户用一个旧备份覆盖掉新的进度。 */
function maybeOfferRestore() {
  if (!backupAvailable()) return;
  if (HAD_LOCAL_AT_START) return;                    // 这次启动之前本地就有进度
  if (Object.keys(state.srs || {}).length) return;   // 服务端已经给过进度了
  if ((state.answers || []).length) return;
  let raw = '';
  try { raw = EQNative.backupRead() || ''; } catch (e) { return; }
  if (!raw) return;
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return; }
  const cards = Object.keys((j && j.srs) || {}).length;
  const ans = ((j && j.answers) || []).length;
  if (!cards && !ans) return;                        // 空备份，没恢复的价值
  setTimeout(() => {
    if (!confirm(`发现上次卸载前的备份：${cards} 张卡片记录 · ${ans} 条作答。\n\n要恢复吗？\n（恢复会用这份备份替换当前进度；不恢复就从头开始，那个文件也还在）`)) return;
    state = Object.assign(structuredClone(DEFAULT_STATE), j);
    save();
    renderHeader();
    go(currentTab || 'today');
    syncGate();
    toast('已从备份恢复');
  }, 600);
}
