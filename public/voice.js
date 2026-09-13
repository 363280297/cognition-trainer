'use strict';
/* ============================================================================
   AI 陪练 —— 这一模块只在 App 里才能发挥全部能力：
     · 语音合成走 Android 系统中文 TTS（她出声）
     · 调大模型走原生 HTTPS（绕开网页的跨域限制）
   在电脑浏览器里打开时自动降级：合成用浏览器语音，请求走服务端代理。

   ---------------------------------------------------------------- 为什么不做语音输入
   2.31 把「听你说话」（麦克风 + 语音识别）**整块删掉了**。用户的原话：

     「做情景模拟 ai 对话的时候，等他说完话，我这边就会自动录音，停止这个功能。
       直接把这个录音的功能删除。我直接打字算了。」

   删掉的不只是那个"她说完就自动开麦"的循环，而是整条输入链：免提、按住说话、
   开始说按钮、语音识别（系统的三条路 + 2.30 才打进去的那套开源离线识别）、
   麦克风权限、以及设置页里那一整块识别诊断。她的声音（TTS）保留。

   为什么整条删而不是只关掉自动那段：只留"按住说话"的话，那一整套识别代码、
   65MB 的中文离线模型、RECORD_AUDIO 权限都还得留着——为一个他明确说不要的功能
   背着这些，比删掉更糟。删掉之后安装包从 48MB 回到 14MB，权限从 7 个回到 6 个。
   想找回来的话：代码在 git 历史里没有（这个项目没有版本控制），但
   `android/vendor/` 里的东西（Vosk 的 jar/.so、中文模型）都还在磁盘上，
   见 android/vendor/README.md。
   ============================================================================ */

const V = {
  native: (typeof EQNative !== 'undefined') ? EQNative : null,
  /* 原生能力。**只剩语音合成**：识别（听你说话）整块在 2.31 被删掉了，
     所以这里没有 asr / mic / local 这些字段了。见下面「为什么不做语音输入」。 */
  caps: { tts: false, http: false, music: false, shot: false },
  /* 用户自己那条音乐的状态（原生送过来）。has=选过、name=文件名、playing=在放、
     persist=是不是"重启后仍然有效"的授权。界面只读这一份，不自己猜。 */
  music: { has: false, name: '', playing: false, persist: true },
  asrInfo: null,    // 兼容旧存档的空位，现在没有识别诊断了
  waiters: {},
  seq: 0,
  sess: null,       // 当前陪练会话
  sessionEpoch: 0,  // 结束/切换都会失效；续聊同一个 sid 也算新的上下文
  turnRequest: null,
  debriefRequest: null,
  sceneRequest: null,
  speechRequest: null,
  historyAnalysisRequests: new Map(),
  busy: false,
  /* 她正在出声。这时不该做别的（比如她说到一半你又发一句），
     而且界面上的提示文字靠它区分「她在说」和「等你打字」。 */
  speaking: false,
  ended: false,     // 这一局已经结束，不许再自动推进
  lastDebrief: null,
};

const TONE_STYLE = {
  '冷淡': { rate: 0.92, pitch: 0.90 },
  '不耐': { rate: 1.06, pitch: 0.94 },
  '平淡': { rate: 0.98, pitch: 0.98 },
  '温和': { rate: 1.00, pitch: 1.02 },
  '热情': { rate: 1.06, pitch: 1.08 },
  '委屈': { rate: 0.90, pitch: 1.02 },
  '紧张': { rate: 1.08, pitch: 1.05 },
};

const RATING_STYLE = {
  '妙': { cls: 'r-great', delta: 8 },
  '好': { cls: 'r-good', delta: 4 },
  '平': { cls: 'r-mid', delta: 0 },
  '失误': { cls: 'r-bad', delta: -6 },
  '漏着': { cls: 'r-bad', delta: -8 },
};

/* ---------------------------------------------------------------- 设置 */

const SET_KEY = 'eq-settings-v1';
const MIGRATED_KEY = 'eq-model-switched';

/* 实测出来的每轮耗时（真实请求，见 tools/probe_chat.py 的输出）。
   写进代码里的原因：**「像不像对话」几乎只由这一项决定**——
   同一个 App、同一个提示词，换成带推理的模型就从「一秒回一句」变成「等半分钟」。
   数字会过期，所以只用它来当参考文案和默认值；真正判断「快不快」
   靠的是运行时实测（见 noteTurnLatency），那个不会过期。 */
const MODEL_FAST = 'deepseek-chat';
const MODEL_CHOICES = [
  { id: 'deepseek-chat', name: 'deepseek-chat',
    note: '实测约 1.6 秒一轮，无推理。对话用这个。' },
  { id: 'deepseek-flash', name: 'deepseek-flash',
    note: '实测约 4.6 秒一轮（带推理）。能用，但等得出来。' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro',
    note: '实测约 30 秒一轮（推理 5000 字）。适合写内容，不适合对话。' },
];

/* 把老的默认模型改掉。
 *
 * 为什么必须有这一步：用户手机上 localStorage 里已经存了 deepseek-v4-pro。
 * **只改代码里的默认值对他一点效果都没有**——默认值只在没有存过的时候生效，
 * 而他早就存过了。所以「改了默认值但没迁移」= 什么都没改。
 *
 * 会「返回内容为空」的那一批：推理和正文共用 max_tokens，推理一写几千字，
 * 正文一个 token 都不剩。第一版这里只写了 'deepseek-v4-pro' 一个字符串——
 * 而用户报的正是「模型返回内容为空」，说明他存的很可能不是这一个名字
 * （deepseek-reasoner / deepseek-r1 都是常见的同一类）。所以列全，
 * 并且用**小写包含**匹配，免得大小写和带日期后缀的变体漏掉。
 * deepseek-flash 也带推理，但它还有 4.6 秒的可用性，是设置页里允许的选择，
 * 所以刻意不在这里——迁移只处理「测下来没法用来对话」的那些。 */
const REASONING_MODELS = ['deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-r1'];
function isReasoningModel(id) {
  const s = String(id || '').toLowerCase();
  return REASONING_MODELS.some((m) => s.indexOf(m) >= 0);
}

function migrateOldModel() {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && isReasoningModel(s.model)) {
      const from = s.model;
      s.model = MODEL_FAST;
      localStorage.setItem(SET_KEY, JSON.stringify(s));
      localStorage.setItem(MIGRATED_KEY, JSON.stringify({ from: from, at: Date.now() }));
    }
  } catch (e) { /* 读不动就算了，settings() 会退回默认值 */ }
}

function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { }
  return Object.assign({
    apiKey: '', model: MODEL_FAST,
    /* 截图转文字用的视觉模型。留空 = 用它代码里那个默认值（VISION_MODEL）。
       单独一个字段是因为**它必须和对话模型不同**：文本模型收不下图片。
       允许用户改，是因为官方那个名字带 Exp 后缀，将来可能改名。 */
    visionModel: '',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    /* 这里原来有 handsFree 和 asrOffline 两条（免提开关、识别在线/离线偏好）。
       2.31 把语音输入整块删掉之后它们就没用了——留着就是"只写不读"的状态，
       自检脚本抓的正是这一类。旧存档里还留着这两个键，无害。 */
    voice: '',           // 空 = 自动（用系统默认那个中文音色）
    /* 背景声。用户的诉求是「容易紧张焦虑」，并且要求**每次进来都问一次**——
       所以 audioAsk 默认为 true。但「以后别再问」必须真的生效，
       否则它就是个每次都要点掉的弹窗，那种东西的结局是被讨厌。 */
    audioTrack: '',      // 空 = 用 data/audio.json 里的 default_track
    audioVolume: 0.22,   // 默认偏小：背景声不该盖过她说话，也不该伤听力
    audioAsk: true,
  }, s);
}

function saveSettings(patch) {
  const s = Object.assign(settings(), patch);
  localStorage.setItem(SET_KEY, JSON.stringify(s));
  return s;
}

/* 把用户填的「接口地址」规范化成一个完整的 OpenAI 端点。
 *
 * 为什么需要这一步：这个输入框里的东西是**被直接 POST 的**（不拼任何路径）。
 * 但「接口地址」四个字读起来像「服务地址」，很多人会填域名或者基础路径，
 * 于是就 POST 到 https://api.deepseek.com/v1 这种地方，拿到一个 404。
 * 而 404 在这里的含义是「这个地址上没东西」，跟密钥、跟模型名都无关——
 * 用户完全猜不到该改哪个字。
 *
 * 所以这里做两件事：
 *   1. 能补的补全（只有域名、/v1 结尾、结尾多一个斜杠）；
 *   2. **补了什么要说出来**。不能偷偷改用户的输入——改了不说，他下次看设置页
 *      发现跟记忆里不一样，只会更糊涂。
 *
 * 特别注意 /anthropic：那是 Anthropic 协议的地址，请求体形状都不一样
 * （那边 max_tokens 必填、system 是单独字段、不认 response_format），
 * 靠补路径解决不了，只能明确让用户换地址。这就是一次真实故障：
 * 用户填了 https://api.deepseek.com/anthropic，界面上只显示「模型返回 404」。
 */
/** 已知可用的正式端点。404 自动回退时用它。 */
const CANONICAL_URL = 'https://api.deepseek.com/chat/completions';

function normalizeEndpoint(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  const DEF = CANONICAL_URL;
  if (!s0) return { url: DEF, note: '地址是空的，用了默认地址' };
  if (!/^https?:\/\//i.test(s0)) {
    return { url: DEF, note: '地址要以 http:// 或 https:// 开头，已改回默认地址' };
  }

  let u = s0.replace(/\/+$/, '');           // 去掉结尾多余的斜杠
  if (/\/anthropic(\/|$)/i.test(u)) {
    return {
      url: DEF,
      bad: '你填的是 Anthropic 协议的地址（/anthropic）。本应用说的是 OpenAI 协议，'
        + '两边的请求体形状不一样，填它一定会 404。已改回默认地址。',
      note: '已把 /anthropic 换成默认地址',
    };
  }
  const before = u;
  if (/\/chat\/completions$/i.test(u)) {
    // 已经是完整端点，不动
  } else if (/\/v\d+$/i.test(u)) {
    u += '/chat/completions';
  } else if (!/^https?:\/\/[^/]+\/.+/.test(u)) {
    // 只有域名，补全
    u += '/chat/completions';
  }
  // 其余情况（自定义反代的路径等）原样保留，不乱动用户的输入
  return { url: u, note: u === before ? '' : `地址已补全成 ${u}` };
}

/** 设置页和报错信息都用它：拿到「实际会 POST 到的地址」 */
function endpoint() {
  return normalizeEndpoint(settings().baseUrl).url;
}

/* 把一次失败的 HTTP 响应翻成一句能照着改的话。
 *
 * 这里原来只做一件事：JSON.parse 之后取 error.message，取不到就只显示状态码。
 * 于是用户看到的是一句「模型返回 404」——没有地址、没有原文、没有方向，
 * 而 404 在这一层可能来自三个完全不同的原因（地址不对／模型名不存在／
 * 反代路径不对），光看状态码分不出来。
 *
 * 更糟的是那个 catch：**这个网关的报错是纯文本**（实测
 * `Authentication Fails (governor)`，不是 JSON），JSON.parse 一抛异常，
 * 服务端的话就被整段丢掉了。所以现在无论是不是 JSON，原文都要露出来。
 */
function httpProblem(res, url, model) {
  const status = res.status || 0;
  const raw = String(res.body == null ? '' : res.body).trim();
  let detail = '';
  try {
    const j = JSON.parse(raw || '{}');
    detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || '';
    if (typeof detail === 'object') detail = JSON.stringify(detail);
  } catch (e) { /* 不是 JSON，下面直接用原文 */ }
  if (!detail && raw) detail = raw.slice(0, 240);   // 纯文本也要露出来
  if (!detail && res.error) detail = res.error;     // 原生桥层面的失败（超时等）

  // 按状态码给一句方向。只写有把握的推断，不确定就不猜。
  let hint = '';
  if (status === 404) {
    hint = '\n404 在这里的意思是「这个地址上没东西」，跟密钥无关（密钥错会是 401）。'
      // 这句是走 setOut.textContent（纯文本）显示的，所以不能带 ** 标记——
      // 带了就会在设置页上原样显示两个星号。这类文案一律不用 markdown。
      + '检查接口地址是不是「完整端点」，而不是域名或者 /anthropic 那种基础地址。';
    if (/\/anthropic/i.test(url)) {
      hint += '\n你填的这个地址是 Anthropic 协议，本应用说的是 OpenAI 协议，必须换掉。';
    }
  } else if (status === 401 || status === 403) {
    hint = '\n密钥没被接受。检查是不是复制少了字符，或者这个 key 已被吊销。';
  } else if (/model/i.test(detail) && /(not|no).{0,12}(exist|found)|不存在|invalid/i.test(detail)) {
    hint = `\n服务端说这个模型名不认：「${model}」。模型名要以 platform.deepseek.com 的文档为准。`;
  } else if (status === 400) {
    hint = '\n请求被拒。如果地址是 /anthropic 结尾，那是协议不对（本应用说 OpenAI 协议）。';
  }

  return `模型返回 ${status}${detail ? '：' + detail : ''}`
    + `\n（发到 ${url}，模型 ${model}）` + hint;
}

/* ---------------------------------------------------------------- 原生桥 */

function nativeHttp(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++V.seq);
    const timer = setTimeout(() => {
      delete V.waiters[id];
      reject(new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs || 120000);
    V.waiters[id] = (res) => { clearTimeout(timer); resolve(res); };
    V.native.httpPost(id, url, JSON.stringify(headers), body);
  });
}

window.__onHttp = function (id, resultJson) {
  const w = V.waiters[id];
  if (!w) return;
  delete V.waiters[id];
  let res;
  try { res = JSON.parse(resultJson); } catch (e) { res = { status: 0, error: '返回无法解析' }; }
  w(res);
};

/**
 * 原生发给网页的对象，**到手时是一个 JSON 字符串**，不是对象。
 *
 * 这个约定必须记住，因为它的失败方式特别隐蔽：原生那边把 JSON 用
 * JSONObject.quote 包成 JS 字符串字面量再注入（`__onX("{\"ok\":true}")`），
 * 所以 JS 收到的 typeof 是 'string'。而处理函数如果直接读 payload.ok，
 * 得到的是 undefined —— 不报错、不抛异常，只是**每一路都走了"不成立的默认分支"**。
 *
 * 这个坑真的踩到了，两个功能各中一次：
 *   · 复盘传截图：一直提示「没识别成功：没选到图片」，而原生日志明明是
 *     `emit ok=true len=43195` —— 图读出来了、base64 也送过来了，JS 却把它
 *     当成"没有 payload"。查了半天怀疑桥、怀疑权限、怀疑选择器，最后是在
 *     __onShot 里临时把 typeof payload 打到界面上才看见是 'string'。
 *   · 音乐状态：onMusicState 开头 `typeof o !== 'object'` 直接 return，
 *     于是「选好了」的提示和播放状态更新从来没生效过（同样是静默的）。
 *
 * 所以统一从这里过一道。**以后新增任何 __onXxx，第一步都调它。**
 */
function bridgeObj(x) {
  if (typeof x === 'string') {
    try { return JSON.parse(x); } catch (e) { return null; }
  }
  return (x && typeof x === 'object') ? x : null;
}


window.__onSpeak = function (state) {
  if (state === 'unavailable') {
    toast('这台手机的语音合成不可用，只能看文字');
    onSpeakDone();          // 也必须往前推进，否则这一轮停在这儿不动了（她那句话永远不会"说完"）
    return;
  }
  if (state === 'done' || state === 'error' || state === 'stop') onSpeakDone();
};

function probeNative() {
  if (!V.native) return;
  try { V.caps = JSON.parse(V.native.capabilities()); } catch (e) { }
}


/* 这个函数**必须被调用**，而且这件事有过一次代价很大的教训。
 *
 * 上一版它写好了、却没有任何一处调用它（`function probeNative()` 定义在那儿，
 * 全项目再没有第二个 probeNative）。后果不是"少一个优化"，而是 V.caps 一直是
 * 全 false 的默认值：
 *   · V.caps.tts 为 false → 合成退到浏览器的 speechSynthesis，而 Android WebView
 *     根本没有它，于是她不会出声。（识别那一条同样的错现在不存在了：
 *     听你说话这一整块在 2.31 被删掉了，见下面「为什么不做语音输入」。）
 * 这一整类错误（"写了一个函数/状态，却没有任何一处读它"）在这个项目里出现过
 * 好几次，所以这次一并加了两道守卫（见 tools/check_music_asr.js 里那条
 * "网页真的问了原生能力、并且拿到了值"，以及 audit 的死函数检查）。
 *
 * 除了载入时探一次，还有两个必须补的点：
 *   · 原生那边 TTS 是**异步**初始化的，载入时问可能拿到 tts=false，
 *     而一两百毫秒之后就好了——所以原生在 TTS 就绪后会推一次 __onCaps；
 *   · 用户真要开口说话/要她出声之前再确认一次（ensureCaps），
 *     这样即便上面两条顺序出了意外，也不会把功能变成"永久不可用"。 */
probeNative();
window.__onCaps = probeNative;

/** 用户要有声音/要说话之前再确认一次原生能力。
 *  只在"看起来还没探到"的时候重探，正常情况下就是一次很便宜的判断。 */
function ensureCaps() {
  if (!V.native) return;
  if (V.caps.tts) return;
  probeNative();
}

/* 载入时就跑一次迁移，而不是等用户打开设置页——否则他会先经历几次 30 秒的等待。 */
migrateOldModel();

/* 把存着的音色应用上。放在载入时做：原生那边 TTS 初始化是异步的，
   所以这里失败一次没关系——真正的合成之前原生会再确认一次（见 applyVoice）。 */
function applyVoiceSetting() {
  if (!V.native || !V.native.setVoice) return;
  try { V.native.setVoice(settings().voice || ''); } catch (e) { }
}
applyVoiceSetting();

/* ---------------------------------------------------------------- 大模型 */

function llmSystem(sc) {
  return [
    // 这里原来写的是「你扮演一位中国女性」。6 个老场景的 her 里都是女性，所以看不出来；
    // 但随机场景会造出男同事、男上级，那时角色的身份和这个写死的性别对不上。
    // 现在性别由 her 决定——role 里不再重复。
    // 名字跟界面上的一致（「AI 陪练」这一路里的「场景对话」）。以前写的是「语音陪练」，
    // 2.31 删掉语音输入之后这个名字就只剩误导了——模型会以为在跑语音。
    '你在做一个「情景对话陪练」：你扮演下面这个角色，用户在练习和他/她对话。你要演得像个真人，不要像个老师。',
    '',
    '【你的角色（性别、年龄、身份都在这里面，照它演）】',
    sc.her,
    '【她现在的真实处境（你自己知道，但绝不直接说出来）】',
    sc.her_state,
    '【你们的关系阶段】' + sc.stage,
    '',
    '【怎么说话——很重要】',
    '· 口语，短句。一次说 1-2 句，最多 40 字。真人说话不会一口气讲一大段。',
    '· 有情绪就会流露，但不会直接报情绪名。失望的人会说「没事」，不会说「我很失望」。',
    '· 不要每次都顺着用户。用户说得不好时，你会更冷、更短、更敷衍。',
    '· 不要主动开新话题帮用户解围；球在他那边。',
    '· 不要用书面语和网络鸡汤腔。不叫「亲」「宝」。',
    '· 允许沉默感：可以只回「嗯」「哦」「……」，如果用户的话确实不值得多回。',
    '',
    '【红线】',
    '· 不写露骨的性内容；不鼓励用户操控、冷暴力、欲擒故纵、贬低你。',
    '· 如果用户在用套路或试图操控，你就按真人的反应来：识破、变冷、或者直接点出来。',
    '',
    '【每一轮你返回一个 JSON 对象】',
    '{',
    '  "reply": "你说出口的话（口语，1-2 句）",',
    '  "tone": "冷淡|不耐|平淡|温和|热情|委屈|紧张 里选一个",',
    '  "inner": "你的内心独白：你刚才那句话背后真正在想什么。要具体、诚实，40 字以内",',
    '  "signal": "用户上一句实际发出的信号是什么。一句，25 字以内",',
    '  "rating": "给用户这一轮打分：妙|好|平|失误|漏着",',
    '  "rating_why": "为什么给这个分，35 字以内，要具体到他的用词",',
    '  "temp": 0-100 的整数，表示你此刻的舒适/亲近程度（初始 ' + (sc.temp0 || 50) + '），',
    '  "temp_delta": 这一轮的增减，整数',
    '}',
    '打分的标准：妙 = 接住了情绪还推进了关系；好 = 得体；平 = 没毛病但没进展；',
    '失误 = 逻辑上说得通但会让人不舒服；漏着 = 完全错过了对方真正在要的东西。',
    '只输出 JSON。',
  ].join('\n');
}

async function llmCallOnce(messages, temperature, maxTokens, noFormat, textOk, modelOverride, isCurrent) {
  const s = settings();
  if (!s.apiKey && V.native) throw new Error('还没填 API 密钥：点右上角 ⚙ 填一次就行');
  /* 这一次实际用的模型名。绝大多数调用就是设置里那个；只有「截图转文字」
     要换成视觉模型（文本模型收不下图片）。报错里也必须用它——不然用户
     看到的是"你的模型 xxx 出错"，而他明明配的是另一个。 */
  const mdl = (modelOverride || '').trim() || s.model;
  const body = {
    model: mdl,
    messages,
    max_tokens: maxTokens || s.maxTokens,
    temperature: temperature == null ? 0.9 : temperature,
  };
  /* response_format 默认带上（官方文档要求提示词里出现 json 这个词，
     这个 App 的提示词都满足）。但**重试那一次会去掉它**——这是有依据的：
     那次失败最可能就是 JSON 模式这条路的问题，换个请求形状比原地重打同一发
     更可能成功。 */
  if (!noFormat) body.response_format = { type: 'json_object' };
  const payload = JSON.stringify(body);

  let res;
  let url = endpoint();            // 规范化之后的真实地址，报错里要用它

  const send = async (u) => {
    if (V.native) {
      return nativeHttp(u,
        { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
        payload, 150000);
    }
    // 电脑上打开时走服务端代理（服务端用 .env 里的密钥，且避开跨域）
    const r = await fetch('/api/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    });
    return { status: r.status, body: await r.text() };
  };

  res = await send(url);
  if (isCurrent && !isCurrent()) throw new Error('请求已失效');

  /* 404 自动回退一次。
   *
   * 404 在这一层的含义是「这个地址上没东西」——跟密钥无关（密钥错是 401）、
   * 跟模型名也基本无关。用户填过一次 https://api.deepseek.com/anthropic
   * （那是 Anthropic 协议的基础地址），只拿到一个「404」，完全没有方向。
   *
   * 规范化已经能挡住大多数写法，但挡不住所有（比如某个自定义反代的路径写错了）。
   * 所以这里再加一道：404 就用**已知可用的正式端点**重试一次。成了就说明确实是
   * 地址问题，并且把这件事明确告诉用户（写进 localStorage 一条，下次设置页会提示）。
   * 这样他至少不会被一个光秃秃的 404 卡住。
   *
   * 只对 404 做这件事：401/403 是密钥问题，400 是请求形状问题，重试都是白费。
   */
  let fellBack = '';
  if (res.status === 404 && url !== CANONICAL_URL) {
    const retry = await send(CANONICAL_URL);
    if (isCurrent && !isCurrent()) throw new Error('请求已失效');
    if (retry.status >= 200 && retry.status < 300) {
      fellBack = url;
      url = CANONICAL_URL;
      res = retry;
    }
  }

  if (!res.status || res.status < 200 || res.status >= 300) {
    throw new Error(httpProblem(res, url, mdl));
  }
  if (fellBack) {
    // 让设置页下次打开时把这件事说出来，而不是悄悄改了地址
    try {
      localStorage.setItem('eq-url-fallback', JSON.stringify({ from: fellBack, to: url, at: Date.now() }));
    } catch (e) { /* 忽略 */ }
  }
  const j = JSON.parse(res.body);
  const ch0 = j.choices && j.choices[0];
  const content = ch0 && ch0.message ? (ch0.message.content || '') : '';
  // finish_reason === 'length' 表示是被 max_tokens 截断的，内容不完整。
  // 这个信号必须往上传：截断后的 JSON 是残缺的，再往下走只会得到
  // 「返回的不是 JSON」这种指不到原因的错误。
  if (ch0 && ch0.finish_reason === 'length') {
    const e = new Error('输出被 max_tokens 截断');
    e.truncated = true;
    e.raw = String(content);
    throw e;
  }
  /* 拿不到内容时**不在这里下结论**，交给 llmCall 去重试——
   * 因为这件事官方文档自己就承认了会偶尔发生：deepseek 的 JSON Output 文档里
   * 写着「the API may occasionally return empty content」，还说「我们正在优化
   * 这个问题」。也就是说它不是用户的模型名写错了，也不是这个 App 的提示词写坏了。
   * 这里只把「发生了什么」如实带上：finish_reason、是不是只有推理、用了多少
   * token、哪个模型、哪个端点、原文前 200 字——这些是下次判断的唯一线索。 */
  if (!String(content).trim() || isSchemaEcho(content)) {
    const e = new Error('模型这次没有返回内容');
    e.empty = true;
    e.diag = {
      finish: (ch0 && ch0.finish_reason) || '（没给）',
      reasoning: ((ch0 && ch0.message && ch0.message.reasoning_content) || '').length,
      completion: (j.usage && j.usage.completion_tokens) || 0,
      prompt: (j.usage && j.usage.prompt_tokens) || 0,
      model: j.model || mdl,
      url: url,
      noFormat: !!noFormat,
      head: String(res.body || '').slice(0, 200),
    };
    throw e;
  }
  // 注意：这里返回的是「解析好的对象」。调用方不要再解析一次——
  // 之前两层都解析，结果把对象当字符串丢给 stripFence，报 t.match is not a function。
  try {
    return parseJsonLoose(stripFence(String(content)));
  } catch (e) {
    /* 模型没按格式回，而是直接说了一句人话——这在**对话**里完全够用：
       用户要的是她开口说话，不是一份 JSON。以前这种情况会把
       「返回的不是 JSON：…」这行字打在她的对话区里，用户看到的就是一个报错框，
       而她想说的那句话就藏在后面。用户明确要求：「这个前缀删掉，直接输出对话就行」。
       所以给 textOk 的调用方（目前只有对话）一个白话说回来的通道：
       把原文当她的话。其它模块（体检/复盘/出题）仍然必须给 JSON，那是对的——
       它们要的是结构化结果，不是一句话。 */
    if (!textOk) throw e;
    const plain = stripFence(String(content)).replace(/^["'「]+|["'」]+$/g, '').trim();
    if (!plain) throw e;
    return { __plain: true, reply: plain };
  }
}

/** 是不是把 response_format 的参数本身当成答案回显回来了。
 *  实测见过这个形状：content = {"type":"json_object"}——它是合法 JSON，
 *  但没有任何一个模块要的是它。这种也必须当成「没给内容」，
 *  否则会一路变成"模型答非所问"，报错指不到真正的原因。 */
function isSchemaEcho(content) {
  const t = String(content).trim().replace(/^```(?:json)?|```$/g, '').trim();
  if (t.length > 60) return false;
  try {
    const o = JSON.parse(t);
    return o && o.type === 'json_object' && Object.keys(o).length <= 1;
  } catch (e) { return false; }
}

/* 截断兜底：被 max_tokens 截断就把额度翻倍重试一次，还截断就如实报错。
 *
 * 为什么需要它：推理模型的**推理 token 和正文共用这个额度**，
 * 所以同一个 max_tokens 在不同模型上结果完全不同——这个项目真踩过
 * （1800 被推理吃掉 1762，正文只剩 83 字节的残缺 JSON，报的是
 * 「返回的不是 JSON」，完全看不出是额度问题）。
 *
 * 只重试一次、上限 12000：翻倍是解决「差一点」，不是在追一个永远不够的额度。
 * 第二次还截断就说明这个模型要的额度远超预期，那时**如实说出来**比继续加钱有用。 */
/* opts 可以是数字（旧写法，等于 temperature）或对象
 * { temperature, maxTokens }。加对象形式是因为这三个模块各有自己的额度需求
 * （体检/出题 4000、揭晓 5000），而设置里的 maxTokens 是对话用的。
 *
 * 这里管两类「这一次白打了」的重试，两类都要重试而不是直接报错：
 *   1. 被 max_tokens 截断（推理 token 和正文共用额度）→ 把额度翻倍再来一次
 *   2. 模型没给出内容 → 换个形状（去掉 response_format）再来一次
 * 第 2 类是被用户逼出来的：他说「这个 AI 语音出了这么多轮错误」。查下来的结论是
 * **官方文档承认的一条偶发行为**（JSON 模式下偶尔返回空内容），
 * 而不是他的模型名写错了——旧版报错却让他去检查模型名，方向是错的。
 * 偶发的东西的正确处理方式是重试，不是让用户去改配置。 */
async function llmCall(messages, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const temperature = o.temperature != null ? o.temperature
    : (typeof opts === 'number' ? opts : undefined);
  const base = o.maxTokens || settings().maxTokens;
  /* textOk：允许模型用白话回答（只有对话用）。
     它同时会影响"没按格式回"的处理——不再抛错，而是把那句话当她说的。 */
  const textOk = !!o.textOk;
  let budget = base;
  /* noFormat: 第一次就不要带 response_format。
     要白话的地方（比如"给我一句能照着说的"）本来就**不该**要 JSON：
     带了它，网关会把 {"type":"json_object"} 当 schema 交给模型，
     而提示词又要求"只输出那一句话"——两个要求互相矛盾，
     实测结果是模型回了一个 JSON 对象（于是 reply 是空的），或者干脆回空。
     以前那个参数是无条件带的，所以这一条必须显式关掉。 */
  let noFormat = !!o.noFormat;
  /* 第一次请求到底带没带 response_format。重试逻辑和报错文案都要用它：
     本来就是白话模式的（hint / OCR），重试不可能改变请求，所以不重试，
     报错时也不许说「换过形状」——那是一句会被用户照着去排查的假话。 */
  const startedWithFormat = !noFormat;
  let truncRetried = false;
  let lastEmpty = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (o.isCurrent && !o.isCurrent()) throw new Error('请求已失效');
      return await llmCallOnce(messages, temperature, budget, noFormat, textOk, o.model, o.isCurrent);
    } catch (e) {
      // 会话切换后的失败也要静默，不能提示重试或再发一次旧请求。
      if (o.isCurrent && !o.isCurrent()) throw e;
      if (e.truncated) {
        if (!truncRetried && budget < 12000) {
          truncRetried = true;
          budget = Math.min(budget * 2, 12000);
          toast(`模型输出被长度限制截断了，把额度提到 ${budget} 重试一次`);
          continue;
        }
        throw new Error(
          `模型输出被长度限制截断了（${budget} tokens 还不够）。`
          + '如果当前用的是带推理的模型，推理会吃掉大半额度——'
          + '换成 deepseek-chat 这类不带推理的模型通常就好了；'
          + '或者在设置页把模型换掉再试。');
      }
      if (e.empty) {
        lastEmpty = e;
        /* 只有「还能换个形状」的时候才值得重试。
         *
         * hint（接话提示）和 OCR 本来就是 noFormat——它们第一次就已经不带
         * response_format 了。对这两条路，「换个形状再试」实际发出的是**一模一样的请求**：
         * 同样的输入、同样的参数，对"偶发空返回"没有任何帮助，
         * 只是多花一倍的钱和时间，而且会让下面那句提示变成假话
         * （它说"第二次去掉了 response_format"，那两次其实都没带）。
         * 所以这两种情况直接如实报错——真正有效的那一步是用户再点一次。 */
        if (attempt === 0 && !noFormat) {
          /* 只重试一次，而且那一次**真的换了形状**（去掉 response_format）。
             为什么不是重试三次：第二、三次会是一模一样的请求，
             对"偶发空返回"没有额外帮助，只是多花用户的钱和时间。
             两种形状都空，就如实报错并让他再点一次（那才是真正有效的那一步）。 */
          noFormat = true;
          toast('模型这次没给出内容（官方文档承认 JSON 模式会偶发这种情况），换个方式再试一次');
          continue;
        }
        throw emptyContentError(e, budget, startedWithFormat);
      }
      throw e;      // 其它错误（网络/密钥/地址/400）原样上抛，不重试
    }
  }
  throw emptyContentError(lastEmpty, budget, startedWithFormat);   // 理论上到不了，兜一下
}

/** 空内容最终失败时的那句话。
 *  旧的写法是「再试一次；如果一直这样，检查一下设置里的模型名」——
 *  方向错了：这件事跟模型名无关，用户照着改了也不会好。
 *  现在把真正能用的信息给他：发生了什么、官方怎么说、下一步做什么，
 *  以及一行可以拿去问我的原始返回。 */
function emptyContentError(e, budget, changedShape) {
  const d = e.diag || {};
  const lines = [
    '模型这次没有返回内容（连着换了两种问法都没给）。',
    '这不是你的设置问题，也不是密钥问题——官方文档里就写着这类 JSON 模式'
    + '「偶尔会返回空内容」，他们也在修。',
    '下一步：直接再点一次通常就好。如果连着好几次都这样，把这行原文发我：',
    `  模型 ${d.model || '?'} · 端点 ${d.url || '?'} · finish_reason ${d.finish || '?'}`,
    `  prompt ${d.prompt || 0} tokens · 输出 ${d.completion || 0} tokens · `
    + `额度 ${budget} · 推理 ${d.reasoning || 0} 字 · 这次${
      changedShape ? '换过形状（第二次去掉了 response_format）'
        : '没重试（本来就是白话模式，重试只会发出同样的请求，所以没必要再花一次钱）'}`,
  ];
  if (d.reasoning > 0) {
    lines.splice(2, 0, '（这一次模型只写了推理、没写正文，多半是推理把额度吃掉了——'
      + '换一个不带推理的模型会稳很多，设置页可以换。）');
  }
  lines.push('服务端返回：' + (d.head || '（空）'));
  return new Error(lines.join('\n'));
}

function stripFence(t) {
  const m = String(t).match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : String(t);
}

function parseJsonLoose(t) {
  const s = stripFence(t);
  try { return JSON.parse(s); } catch (e) { }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('返回的不是 JSON：' + s.slice(0, 80));
}

/* ---------------------------------------------------------------- 语音 */

function speak(text) {
  ensureCaps();      // 她出声之前确认一下原生能力（TTS 是异步就绪的）
  const st = settings();
  const style = TONE_STYLE[(V.sess && V.sess.lastTone) || '平淡'] || { rate: 1, pitch: 1 };
  const rate = style.rate * (st.rate || 1);
  const pitch = style.pitch * (st.pitch || 1);
  const request = {};
  V.speechRequest = request;
  V.speaking = true;
  if (V.native && V.caps.tts) {
    V.native.speak(text, rate, pitch);
  } else if (window.speechSynthesis) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = rate; u.pitch = pitch;
      // 浏览器侧没有原生回调，得自己接上，否则「她正在说」永远不会结束
      const done = () => { if (V.speechRequest === request) onSpeakDone(); };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    } catch (e) { V.speaking = false; }
  } else {
    // 连合成都没有：当作「已经说完了」，不要卡在这里
    V.speaking = false;
    onSpeakDone();
  }
}

/** 她出声结束（正常说完 / 被打断 / 失败）。
 *  2.31 之前这里还负责"她说完就自动开麦"——那整条（免提循环）已经删了，
 *  所以现在它只把状态落回来。留着这个函数是因为 TTS 的回调必须有地方落。 */
function onSpeakDone() {
  V.speaking = false;
}

function stopSpeak() {
  // 先自己把状态落下来再去停声音。原因：tts.stop() 在 Android 上只回调 onStop，
  // 而「不回调」和「晚回调」在界面上是分不清的——状态由声音那边负责的话，
  // 一旦回调没来，界面就一直停在"她在说"，且不报错。
  V.speaking = false;
  V.speechRequest = null;
  if (V.native && V.caps.tts) V.native.stopSpeak();
  else if (window.speechSynthesis) speechSynthesis.cancel();
}

/* ---------------------------------------------------------------- 会话 */

function sessionIsCurrent(sess, epoch) {
  return V.sess === sess && V.sessionEpoch === epoch;
}

/** 旧请求可以在后台结束，但从这里起不能再写会话、画界面或解锁新请求。 */
function invalidateSessionWork() {
  V.sessionEpoch++;
  V.turnRequest = null;
  V.debriefRequest = null;
  V.sceneRequest = null;
  V.busy = false;
  V.lastTurnMs = 0;
  V.latencyWarned = false;
  closeTalkHint();
  stopSpeak();
}

async function startSession(scOrId) {
  /* 两条路都走：按 id 查，或者直接把对象传进来。
     id 要在**全部**场景里查（现成 + AI 造进库的）。只查现成那 14 个的话，
     从库里点一个 AI 造的场景会静静地什么都不发生——`if (!sc) return;`
     是这一页最容易犯的那类毛病：点了没反应、也不报错。 */
  const sc = typeof scOrId === 'string'
    ? allSceneList().find((x) => x.id === scOrId)
    : scOrId;
  if (!sc) return;
  invalidateSessionWork();
  V.ended = false;
  V.lastDebrief = null;
  V.sess = {
    sc, turn: 0,
    /* sid = 这一局在历史记录里的 id，开局就定下来。
       有了它，「分析没生成出来 → 再试一次」是往同一条记录上补，
       而不是在历史里堆出第二条（那正是"看着有、其实会重复"的那类毛病）。 */
    sid: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    temp: sc.temp0 || 50,
    history: [],      // 给模型的对话历史
    log: [],          // 逐轮记录，用于复盘
    lastTone: null,
    asked: 0,         // 你主动提问的次数
    followUps: 0,     // 其中追着她刚说的内容问的
  };
  renderPractice();
  // 她先说第一句
  V.sess.history.push({ role: 'user', content: '（对话开始，你刚说完第一句话）' });
  V.sess.pendingOpening = true;
  await nextTurn(null, sc.opening);
}

/** 拿她的下一句。userText 为 null 时表示由你给出她的开场白 */
async function nextTurn(userText, forcedReply) {
  if (!V.sess || V.ended || V.busy) return;
  const sess = V.sess, epoch = V.sessionEpoch;
  const request = {};
  V.turnRequest = request;
  const current = () => sessionIsCurrent(sess, epoch) && !V.ended && V.turnRequest === request;
  V.busy = true;
  try {
    if (forcedReply) {
      sess.lastTone = '平淡';
      sess.turn++;
      /* 这里原来对 her_state 做了 slice(0, 40) —— 那是**用户看得见的正文**，
         砍在 40 字正好把 s1 最后那半句「…如果你一直找话题、表现自己，她会累」
         切成了「…如果你一直找话题、表」。六个现成场景全中，砍掉的恰好是最要紧那句。
         正文一个字都不该在渲染时截——要短就在数据里写短。 */
      showHerTurn({ reply: forcedReply, tone: '平淡', inner: sess.sc.her_state || '', signal: '（开局）', rating: '平', rating_why: '先听她说，别急着回', temp: sess.temp, temp_delta: 0 });
      sess.history.push({ role: 'assistant', content: forcedReply });
      if (settings().autoSpeak) speak(forcedReply);
      return;
    }

    setHerThinking(true);
    const t0 = Date.now();
    /* textOk: true —— 对话这一路允许她**直接说人话**。
       模型偶尔不按 JSON 回（有时干脆就是一句白话），那就把这句话当成她说的：
       用户在练「接住一句话」，一句真人话比一份格式完美的 JSON 有用得多。
       以前这种情况的表现是：她的话没显示出来，对话区多了一个
       「返回的不是 JSON」的红框——用户的原话是「这个前缀删掉，直接输出对话就行」。
       缺的字段在下面补成"明说了没有"，而不是留空。 */
    const o = await llmCall(
      [{ role: 'system', content: llmSystem(sess.sc) }, ...sess.history],
      { temperature: 0.9, textOk: true, isCurrent: current });
    if (!current()) return;
    V.lastTurnMs = Date.now() - t0;

    sess.turn++;
    /* 白话回来的时候，把缺的字段补成"明说了没有"。
       留空会让下游（内心独白、打分、复盘引用、温度条）显示成空白或 undefined——
       那正是这个项目一再踩的「看着有、其实没有」。 */
    if (o.__plain) {
      o.tone = o.tone || '平淡';
      o.inner = o.inner || '（这一轮她没给内心独白）';
      o.signal = o.signal || '（这一轮没有信号分析）';
      o.rating = o.rating || '平';
      o.rating_why = o.rating_why || '这一轮模型没按格式回，所以没有打分——话本身是有效的';
    }
    sess.lastTone = o.tone || '平淡';
    const d = Number(o.temp_delta) || 0;
    sess.temp = Math.max(0, Math.min(100, Number(o.temp) || (sess.temp + d)));
    o.temp = sess.temp;
    // 把用户**自己的原话**记进这一轮的记录里。以前只存了模型给的 signal（「他这句
    // 发出了什么信号」），于是复盘时想引用他说过的词只能靠模型转述——
    // 引用原话和转述在教练这件事上差别很大，前者才是可执行的。
    o.userText = userText || '';
    sess.history.push({ role: 'assistant', content: o.reply });
    sess.log.push(o);
    /* 每聊完一轮就落一次盘。
       用户的原话：「历史记录并不是结束之后才保存，而是只要有过一轮对话，
       即便中途没结束，也可以继续续上。」所以这里不等「结束」——
       中途关掉 App、切走、甚至忘了点结束，这一局都在历史里躺着，能接着聊。 */
    storeTalkRecord(sess, V.lastDebrief, false);
    showHerTurn(o);
    if (settings().autoSpeak) speak(o.reply);
    else onSpeakDone();      // 静音模式下没有「说完」这个事件，得自己推进循环
  } catch (e) {
    if (!current()) return;
    toast(e.message);
    const box = document.getElementById('herSlot');
    if (box) box.insertAdjacentHTML('beforeend',
      `<div class="v-err">${esc(e.message)}</div>`);
  } finally {
    if (current()) {
      setHerThinking(false);
      V.busy = false;
      V.turnRequest = null;
      noteTurnLatency();
    }
  }
}

/* 一轮特别慢时主动说一句。
 *
 * 为什么不写死模型名来判断：模型可用性是会变的（今天是这三个，下个月未必），
 * 而「这一轮实测等了几秒」永远是真的。所以判断依据是**实测延迟**，
 * 建议里才提具体的模型名。这样即使以后模型改名，这条提示也还有效。
 *
 * 阈值 8 秒：正常一轮 1~2 秒，带推理的 5 秒起、往往十几秒以上。
 * 8 秒足够区分，又不会因为偶尔的网络抖动误报。 */
function noteTurnLatency() {
  const ms = V.lastTurnMs || 0;
  if (!ms || ms < 8000) return;
  if (V.latencyWarned) return;      // 一局只提醒一次，不刷屏
  V.latencyWarned = true;
  const cur = settings().model;
  const box = document.getElementById('turnHint');
  const secs = (ms / 1000).toFixed(1);
  /* 已经在用快的那个时，不能还劝人家换它自己——那是句废话，还会让人以为坏了。
     这种情况把方向指向网络/密钥/地址，那才是真正剩下的可能。 */
  const msg = cur === MODEL_FAST
    ? `刚才这一轮等了 ${secs} 秒。模型本身是够快的，所以多半是网络或服务端慢，`
      + `也可能是接口地址被绕到了别处（设置页能看）。`
    : `刚才这一轮等了 ${secs} 秒。当前模型 ${cur} 大概是带推理的——`
      + `换成 ${MODEL_FAST} 一轮大约 1.6 秒，对话会顺得多。`;
  if (box) box.textContent = msg;
  toast(msg);
}

/** 用户说了一句 */
async function userSaid(text) {
  if (!V.sess || V.ended || !text || !text.trim() || V.busy) return;
  V.historyAnalysisRequests.delete(V.sess.sid);
  closeTalkHint();          // 已经作答，旧示范作废；即便本轮失败也不能卡在「正在想」
  const t = text.trim();
  const herLast = [...V.sess.history].reverse().find((h) => h.role === 'assistant');
  noteQuestion(t, herLast ? herLast.content : '');
  V.sess.history.push({ role: 'user', content: t });
  pushBubble('me', t);
  renderTurnHint('');
  updateAskMeter();
  await nextTurn(t);
}

/* -------------------------------------------------------------- 追问计数
 * 为什么单独统计这个：在一项包含三次真实对话的研究里（Huang 等，2017，
 * 《It doesn't hurt to ask》），**提问多的人被对方更喜欢，追问尤其有效**。
 * 后续研究（Yeomans 等，2019）发现追问的收益是累积的——每多一个都还有用。
 * 更关键的是：人们普遍**预料不到**提问会让人更喜欢自己，所以这是一个
 * 「反直觉但可操作」的动作，正好适合在练完一局之后摆出来。
 *
 * 机制是「被感知到的回应性」——倾听、理解、认可、在意。追问之所以有效，
 * 是因为它证明你上一句真的听进去了。
 *
 * 这里的判定是启发式的，不是严格实验测量，两条路各管一类追问：
 *   - 字面重合：问题里出现她上一句的片段（「李姐为什么打回来」）
 *   - 指代回指：用「那你当时…」「后来呢」这类词把话头递回去。
 *     这一类**没有字面重合**，但恰恰是最典型的追问，所以必须单独认。
 * 只认字面重合会漏掉相当一部分真追问——测试里「那你当时怎么说的」
 * 一开始就被判成了「不是追问」，而它显然是。
 */
const QMARK = /[?？]|吗|呢|什么|怎么|为什么|哪|谁|几点|多少|多久|多长|如何|怎样|咋|干嘛|干什么|是不是|有没有|好不好|行不行|要不要|还是|对不对/;

// 回指：把话题递回给她刚说的内容，即使一个字都没重复
const ANAPHOR = /那(你|他|她)?(当时|刚|后来|现在|之后)|你刚|你刚才|刚说|刚才说|当时|后来呢|然后呢|结果呢|后来怎么|你说的|你说的那|那件事|这件事|所以呢/;

function bigrams(s) {
  const clean = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

function noteQuestion(userText, herText) {
  if (!V.sess) return;
  if (!QMARK.test(userText)) return;
  V.sess.asked = (V.sess.asked || 0) + 1;
  const mine = bigrams(userText);
  const hers = bigrams(herText);
  let hit = ANAPHOR.test(userText);
  if (!hit) {
    for (const g of mine) { if (hers.has(g)) { hit = true; break; } }
  }
  if (hit) {
    V.sess.followUps = (V.sess.followUps || 0) + 1;
    V.sess.lastWasFollowUp = true;
  } else {
    V.sess.lastWasFollowUp = false;
  }
}

function updateAskMeter() {
  const el = document.getElementById('askMeter');
  if (!el || !V.sess) return;
  const a = V.sess.asked || 0;
  const f = V.sess.followUps || 0;
  el.innerHTML = a
    ? `这一局你提了 <b>${a}</b> 个问题${f ? `，其中 <b>${f}</b> 个是在追着她说的内容问` : ''}`
      + (V.sess.lastWasFollowUp ? ' <span class="ask-hit">刚才这个就是追问</span>' : '')
    : '还没提过问题。试着追问她刚说的那句里的细节。';
}

/* ---------------------------------------------------------------- 渲染 */


/* ============================================================ 场景对话
 *
 * 用户的要求：「先给提示词，然后建造一个场景。」
 *
 * 这里的取舍值得写下来：他要的是**围绕一个场景练**，不是「随便聊」。
 * 两者的区别不是界面，是训练目标：
 *   - 开放聊天里模型会配合你、会顺着你说，你练的是「聊得下去」；
 *   - 场景对话里模型**有立场、有未说出口的期待、也会因为你的失分而降温**，
 *     你练的是「在具体情况下做对那一个动作」。
 * 这个 App 的全部内容都指向后者，所以这里不做开放聊天——那等于换了一个产品。
 *
 * 场景的形状沿用 data/scenarios.json 那套字段，一字不改，
 * 这样下面那套对话机制（轮次、温度、追问计数、复盘）完全不用动。
 */

/** 一键填入的示例提示词。老的 6 个场景不浪费，转成提示词的写法。 */
const SCENE_SEEDS = [
  '刚认识两周，第一次单独约出来，我想练「让她说得比我多」',
  '同事在群里当着大家的面否了我的方案，我想练一句不软不硬的回应',
  '朋友连着三周找我倒同一件苦水，我想练「听住但不做垃圾桶」',
  '我妈又拿我和别人家孩子比，我想练不吵架但把话说清楚',
  '伴侣说「算了，随便吧」，我想练听出她真正要的是什么',
  '我想退掉一个总是占我便宜的饭局邀约，但不想把关系弄僵',
];

/** 造场景的系统提示词。抽成常量是因为有两条路要用它：
 *  单造一个（buildScenario）和一次造几个（buildSceneBatch）。两处各写一份的话，
 *  迟早有一份被改、另一份没改，而症状是"两种方式造出来的场景质量不一样"。
 *
 *  2.32 这一版加的是**硬规则**。用户的原话是「不能随机生成，你得给一些比较好的
 *  提示词让 AI 生成」——好提示词的具体落点就是下面这几条：
 *    · opening 要留接话口，不许写"客套+抱怨"这种没钥匙的句子；
 *    · her_state 必须解释 opening（用户先看到的是 opening，her_state 是他解码的钥匙）。
 *      这两条正是现成场景 s1 那个 bug 的解药：开头说「地方挺好找的，我绕了一圈才到」，
 *      内心独白却在说"她紧张、怕尴尬"——两句话指的不是一件事，用户会卡在
 *      "到底好找还是不好找"上，而不是在练情商。
 *    · 第三人只能在、不能开口：对话引擎只演一个人（她一句你一句），
 *      一桌人的场景能开局但演出来会怪。
 *    · difficulty 给判据，否则模型报的难度是噪声。
 *    · stage 只能从固定枚举里选：列表要按关系分组，关系名一发散就没法分组了。 */
const SCENE_SYS = `你在给一个情商训练 App 建造「对话练习场景」。
用户会给你一份 brief（这次要补哪些关系、难度、已经有哪些场景），你按 brief 造场景。

硬规则（每一条都必须过）：
1. 具体：有确切的关系、场合、此刻正在发生的事。不要写成泛泛的咨询建议。
2. 对方必须有自己的立场和一个**没说出口的期待**。对方只是配合你，这个场景就没有训练价值。
3. opening 是对方说的第一句话：口语、能直接说出口、不超过 40 字，而且**必须留出自然的接话口**。
   不许写"客套话 + 抱怨"这种没有钥匙的句子（例如"地方还挺好找的，我绕了一圈才到"——
   用户会卡在"到底好找还是不好找"上，而不是在练情商）。
4. **her_state 必须解释 opening**：她嘴上说的和心里想的差在哪、那句话真正要的是什么。
   用户先看到 opening，her_state 是他解码用的钥匙，两句话必须指同一件事。
5. 这个场景里"你"要有一件**具体要办成的事**（例如：让她愿意约第二次／把交付期限推后一天／
   不翻脸地把界限说清楚）。goal 写这件事，不要写"练一种态度"。
6. **对方是唯一跟你说话的人**。可以有别人在场，但他们只是背景，不开口、不参与对话。
7. difficulty 按这个标准给：1＝对方基本配合，你只要把话说清楚；2＝对方有情绪，或场上有别人；
   3＝对方不配合、你的信息还不全，得先察言观色。
8. her 里写清对方是谁、**是男是女**、年龄身份性格、你们的关系和此刻位置。
   ta 只填「他」或「她」，必须与 her 一致。
9. theme 是这一局的主题，4-8 个字（例：拒绝加急需求／被夸怎么接／把话题拉回正事）。
   它是去重用的：同一个主题换个说法也算重复。
10. 全部中文口语，不要书面腔，不要油腻话术。不要写成「你要如何如何」的教程。

只输出 JSON，字段固定为：
{"scenarios":[{"title":"场景标题，12字以内","stage":"关系阶段，只能从 brief 给的枚举里挑",
 "difficulty":2,"ta":"他或她","theme":"主题4-8字",
 "her":"对方是谁：年龄/身份/性格/你们的关系和此刻位置",
 "her_state":"对方此刻真实的感受、最在意什么；必须解释 opening 那句的言外之意",
 "opening":"对方开口说的第一句话","goal":"你这一局要办成的那件事",
 "trap":"这一局最常见的错法"}]}`;

/** 把模型给的一个对象变成能用的场景（字段补默认值、难度夹在 1–3、关系夹进枚举）。 */
function normalizeScenario(out, i) {
  const kt = cutWithEllipsis(out.title || '练习场景', 24);
  const sc = {
    /* id 必须真的唯一：库是按 id 去重的，一次造几个时更要小心——
       只用 Date.now() 的话，同一个毫秒里的两条会撞成同一个 id，
       第二条会被**静静地扔掉**（用户看到的是"造了 6 个只多了 3 个"）。
       所以带上随机后缀；-i 只是方便肉眼看出这是同一批里的第几个。 */
    id: 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        + (i == null ? '' : '-' + i),
    title: kt,
    /* 关系必须是枚举里的一个：列表要按它分组、缺口表要按它统计，
       模型自己编一个「同事之间」，那个场景就会掉进"泛社交"里，两边都错。
       枚举外的（很少见）落到"泛社交"，和 sceneDomain 的兜底一致。 */
    stage: SCENE_STAGES.indexOf(String(out.stage || '')) >= 0 ? String(out.stage) : '泛社交',
    difficulty: Math.min(3, Math.max(1, parseInt(out.difficulty, 10) || 2)),
    ta: out.ta === '他' ? '他' : '她',
    theme: cutWithEllipsis(out.theme || '', 20),
    her: String(out.her || ''),
    her_state: String(out.her_state || ''),
    opening: cutWithEllipsis(out.opening || '', 80),
    goal: String(out.goal || ''),
    trap: String(out.trap || ''),
    createdAt: Date.now(),      // 淘汰时按它排先后（练过的不淘汰，没练过的先走）
  };
  // 开场白是这套机制的地基，缺了就没法开始——宁可报错，也不要造一个空场景
  if (!sc.opening.trim()) throw new Error('场景生成得不完整（缺开场白），再试一次');
  return sc;
}

async function buildScenario(prompt, isCurrent) {
  const s = settings();
  if (!s.apiKey && V.native) throw new Error('还没填 API 密钥：点下面的「⚙ 设置」填一次就行');
  if (!String(prompt || '').trim()) throw new Error('先写一句你想练什么');

  let out = await llmCall([
    { role: 'system', content: SCENE_SYS },
    { role: 'user', content: '我想练：' + String(prompt).trim() },
  ], { temperature: 0.85, isCurrent });

  // 模型偶尔会把整个场景塞进一个外层键里（{"scenario":{...}} 这种）。
  // 字段名是明确的，所以只要顶层缺 opening 就往里找一层，别白白让它报错。
  if (out && !out.opening) {
    const inner = Object.values(out).find((v) => v && typeof v === 'object' && v.opening);
    if (inner) out = inner;
  }
  return normalizeScenario(out);
}

/* ---------------------------------------------------- 直接给你选好的情景
 *
 * 用户的原话：「然后情景是你直接选好的。」
 * 原来进 AI 页要先自己写提示词、或者自己从六个里挑。现在一进去就已经选好一个
 * 摆在最上面，一个按钮开始。
 *
 * 选法：**本地轮换，不花钱**。按「练得最少」优先，同分时难度低的优先。
 * （这里**不是**弱项倾斜——用户拍板的是生成按缺口铺开；轮换只管"哪个练得少先给哪个"，
 * 而且候选里包含 AI 造进库的场景，所以库里那些也会轮到。）
 * 故意不用模型现造——那样每次打开 AI 页都要等一次请求、花一次钱，
 * 而大多数人打开只是想先看一眼。想要新的可以点「换一个」（本地换，仍然免费），
 * 或者走下面那几条路。
 */
let dailySceneId = null;
const SCENES_PAGE = 6;
let scenesExpanded = false;
let sceneFilter = '全部';       // 复用 DOMAINS（和卡片页那个筛选条同一套词）

function setSceneFilter(d) {
  sceneFilter = d;
  scenesExpanded = false;       // 换了关系就收回默认长度，别让上一个关系的展开状态跟过来
  renderTalkSetup();
}

/** 场景列表里的一张卡。练过几次、是不是 AI 造的，都写在这一行里——
 *  「练过」让轮换看得见，「AI 造」是老实标一下来源（列表仍然是混着排的）。 */
function sceneCardBtn(x) {
  const n = sceneDoneN(x.id);
  const gen = /^gen-/.test(String(x.id));
  return `<button class="seed preset" onclick="startSession('${esc(x.id)}')">
    <b>${esc(x.title)}</b><span class="seed-meta">${esc(x.stage || '')} · 难度 ${
    esc(String(x.difficulty || ''))}${n ? ` · 练过 ${n} 次` : ''}${gen ? ' · AI 造' : ''}</span></button>`;
}

/** 默认那几张（"全部"且没展开时）：**练得最少的优先，而且每个关系最多一张**。
 *  为什么不是简单地取列表前几个：`allSceneList()` 里现成的 14 个排在前面，直接取前 6 个
 *  会是一屏恋爱场景（现成的前几个全是恋爱）。这样取，一屏至少能覆盖到 5 类关系。
 *  同分时保持原顺序（JS 的 sort 是稳定的），所以同一份数据每次结果一样。
 *
 *  **注意 AI 造的那些不会因此自动挤进这几张**：它和没练过的现成场景计数都是 0，
 *  同分时现成的在前（稳定排序）。所以刚造出来的要在库里找，得按它自己的关系筛一下、
 *  或者点「看全部」——刚造完那一下则是上面那几张批卡直接点「练这个」。
 *  （这条我原先注释里写反了，实测才发现——"新造的一定排得进来"是错的。） */
function sceneSample(n) {
  const done = state.scenes || {};
  const sorted = allSceneList().slice().sort((a, b) => (done[a.id] || 0) - (done[b.id] || 0));
  const out = [], used = {};
  sorted.forEach((x) => {
    if (out.length >= n) return;
    const d = sceneDomain(x);
    if (used[d]) return;
    used[d] = 1;
    out.push(x);
  });
  sorted.forEach((x) => { if (out.length < n && out.indexOf(x) < 0) out.push(x); });
  return out;
}

/* 场景库：现成 14 个 + AI 造进库的，**混在一起按关系分组**（用户拍板的排法）。
   为什么不分成"打磨过的"和"AI 造的"两段：他要按「我要练哪类关系」找，不是按
   「谁写的」找。所以同一个关系下面既有现成的也有现造的，AI 造的只在卡上标个小记号。
   默认只摊开前几个——库会长到几十个，全摊开这一页就看不到「自己出一个题」了。 */
function sceneLibCard() {
  const all = allSceneList();
  const presetN = (CONTENT.scenarios.scenarios || []).length;
  const counts = {};
  all.forEach((x) => { const d = sceneDomain(x); counts[d] = (counts[d] || 0) + 1; });
  const used = ['全部'].concat(DOMAINS.slice(1).filter((d) => counts[d]));
  const cur = used.indexOf(sceneFilter) >= 0 ? sceneFilter : '全部';
  const flat = cur === '全部' ? all : all.filter((x) => sceneDomain(x) === cur);
  const groups = [];
  if (cur === '全部' && scenesExpanded) {
    // 展开时按关系分组，每组一个小标题
    DOMAINS.slice(1).forEach((d) => {
      const list = flat.filter((x) => sceneDomain(x) === d);
      if (list.length) groups.push({ d, list });
    });
  } else {
    groups.push({ d: '', list: cur === '全部' && !scenesExpanded ? sceneSample(SCENES_PAGE) : flat });
  }
  return `<div class="card">
    <div class="label" style="margin-bottom:4px">场景库，点开就练</div>
    <p class="hint" style="margin-bottom:10px">
      共 ${all.length} 个：${presetN} 个是我逐个写过的，${genScenes().length} 个是 AI 按缺口现造的。
      <b>按关系混在一起排</b>，想练哪一类点下面的筛子；AI 造的会标出来。
      ${all.length > SCENES_PAGE && cur === '全部' && !scenesExpanded
        ? '下面这几张是<b>练得最少的、每个关系各一张</b>，展开能看到全部。' : ''}
    </p>
    <div class="chips">${used.map((d) => `
      <button class="chip-btn ${d === cur ? 'on' : ''}" onclick="setSceneFilter('${d}')">
        ${d}${d === '全部' ? '' : ` <em>${counts[d]}</em>`}
      </button>`).join('')}</div>
    <div class="seed-list" style="margin-top:10px">
      ${groups.map((g) => (g.d ? `<div class="seed-group">${esc(g.d)}</div>` : '')
        + g.list.map(sceneCardBtn).join('')).join('')}
    </div>
    ${cur === '全部' && flat.length > SCENES_PAGE ? `<div class="row row-2" style="margin-top:10px">
      <button class="ghost" onclick="toggleAllScenes()">${
        scenesExpanded ? '收起，只看前几个' : `看全部 ${flat.length} 个（按关系分组）`}</button>
    </div>` : ''}
  </div>`;
}

/** 练得最少的优先；同分时难度低的优先（别一上来就给最难的，那样容易劝退）。
 *  候选是**全部**场景：AI 造进库的也在里面，所以"今天就练这个"会轮到它们。 */
function dailySceneCandidates() {
  const list = allSceneList().slice();
  const done = (state.scenes || {});
  return list.sort((a, b) => {
    const da = done[a.id] || 0, db = done[b.id] || 0;
    if (da !== db) return da - db;
    const fa = Number(a.difficulty) || 2, fb = Number(b.difficulty) || 2;
    if (fa !== fb) return fa - fb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function pickDailyScene() {
  const cands = dailySceneCandidates();
  if (!cands.length) return null;
  if (dailySceneId && cands.some((x) => x.id === dailySceneId)) {
    return cands.find((x) => x.id === dailySceneId);
  }
  dailySceneId = cands[0].id;
  return cands[0];
}

/** 换一个：在候选里往后挪一位。本地操作，不发请求、不花钱。 */
function nextDailyScene() {
  const cands = dailySceneCandidates();
  if (cands.length < 2) { toast('只有这一个现成情景，下面可以自己写一个'); return; }
  const i = Math.max(0, cands.findIndex((x) => x.id === dailySceneId));
  dailySceneId = cands[(i + 1) % cands.length].id;
  renderTalkSetup();
}

/** 这个情景练过几次。用来做轮换，也让用户看见「这个练过了」。 */
function sceneDoneN(id) { return ((state.scenes || {})[id]) || 0; }

function dailySceneCard() {
  const sc = pickDailyScene();
  if (!sc) return '';
  const n = sceneDoneN(sc.id);
  return `<div class="card daily-scene">
    <div class="label" style="margin-bottom:8px">今天就练这个</div>
    <h2 style="margin-bottom:6px">${esc(sc.title)}</h2>
    <div class="daily-meta">
      <span class="tag">${esc(sc.stage || '')}</span>
      <span class="tag">难度 ${esc(String(sc.difficulty || ''))}</span>
      ${n ? `<span class="tag">练过 ${n} 次</span>` : '<span class="tag tag-good">没练过</span>'}
    </div>
    <p class="hint" style="margin:10px 0 0">${esc(sc.her || '')}</p>
    <p class="hint" style="margin:8px 0 0">对方会先开口：「${esc(sc.opening || '')}」</p>
    <div class="row row-1" style="margin-top:12px">
      <button class="primary" onclick="startSession('${esc(sc.id)}')">开始这一局</button>
    </div>
    <div class="row row-2">
      <button class="ghost" onclick="nextDailyScene()">换一个情景</button>
      <button class="ghost" onclick="randomStart()">按缺口现造一个</button>
    </div>
  </div>`;
}

/** 这一局你回过几次。
 *  「轮」按**你的回合**数，不按她的发言数：她多一句开场白，按她的算那时候就显示
 *  "聊了 1 轮"，而你其实一个字都还没说。原来五处显示都是拿 sess.turn（含开场白），
 *  所以回过两次会显示"聊了 3 轮"——加"上次没聊完"那张卡时发现的，顺手统一。 */
function talkRounds(t) { return (((t && t.log) || []).length); }

/** 最近一局没聊完的。
 *
 * 用户的原话：「认知训练中AI模块上下文很容易丢失。」
 * 实测下来丢在哪一步很清楚：**在 App 里切页不丢**（V.sess 在内存里，回来照原样重画），
 * 丢的是"离开 App 再回来"——手机上被系统杀掉、划掉、或者放置太久重建 WebView，
 * 内存里的会话就没了。逐轮记录其实一直在存（每聊完一轮就存），所以**内容没丢**，
 * 丢的是"他知道还能接着聊"这件事：回来看到的是一个干干净净的选场景页，
 * 那条没聊完的记录静静躺在「历史」里，要自己翻进去点。看着就像对话没了。
 *
 * 所以这里把它顶到最上面：一进 AI 就能看见、一步接上。
 * 取 updatedAt 最新的一条（不是 at，因为老记录接着聊过之后 at 不变）。 */
function unfinishedTalk() {
  const list = talks().filter((t) => t && !t.done && t.log && t.log.length);
  if (!list.length) return null;
  return list.slice().sort(
    (a, b) => ((b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0)))[0];
}

/** 顶部那张「上次没聊完」的卡。没有没聊完的局时什么都不画。 */
function unfinishedCard() {
  const t = unfinishedTalk();
  if (!t) return '';
  const sc = t.sc || {};
  const ta_ = sc.ta || '她';
  return `<div class="card resume-card">
    <div class="label" style="margin-bottom:6px">上次没聊完</div>
    <h2 style="margin-bottom:6px">${esc(sc.title || '（没有标题）')}</h2>
    <p class="hint" style="margin:0 0 12px">
      ${esc(fmtTalkTime(t.updatedAt || t.at))} · 聊了 ${talkRounds(t)} 轮 ·
      ${esc(ta_)}的温度 ${esc(String(t.temp))}。
      ${esc(ta_)}还停在那儿等你回话——接着聊，从上一句往下走。
    </p>
    <div class="row row-1">
      <button class="primary" onclick="resumeTalk('${esc(t.id)}')">接着聊这一局</button>
    </div>
  </div>`;
}

function renderTalkSetup() {
  ensureCaps();      // 这一页要按真实能力显示警告，别拿载入时那份可能过期的值
  const s = settings();
  const noKey = V.native && !s.apiKey;
  /* 场景库现在会长到几十个（AI 造的会攒起来），一次全摊开会把这一页拉得很长
     （下面「自己想练什么」都看不到了）。默认只显示前几个，剩下的收在「看全部」
     后面；选了某个关系就把那一类全列出来。 */
  const allScenes = allSceneList();
  const genN = genScenes().length;
  $('#view').innerHTML = `
    ${unfinishedCard()}
    ${dailySceneCard()}
    <div class="card">
      <h2>自己出一个题</h2>
      <p class="hint" style="margin-top:8px">
        AI 演对方，你开口说话。<b>先给一句提示词说明你想练什么</b>，
        它会把这个提示词造成一个具体的场景——包括对方是谁、此刻在发生什么、
        以及对方嘴上没说但心里在意的东西。每一轮答完，都会告诉你
        <b>对方心里其实在想什么</b>：这是这个 App 里唯一让你「当场回应」，
        而不是从四个选项里挑一个的练习。
      </p>
      ${!V.native ? `<p class="warnbox" style="margin:12px 0">
        你现在是在电脑浏览器里打开，没有手机的原生语音桥：<b>直接打字</b>，
        对方的声音用浏览器语音。装到手机上她的声音是手机自己的中文语音。
      </p>` : ''}
      ${noKey ? `<p class="warnbox" style="margin:12px 0">
        还没填 API 密钥，建不了场景也对话不了。
        <button class="plain" style="margin-left:6px" onclick="openSettings()">去填</button>
      </p>` : ''}
      <label class="field" style="margin-top:12px"><span>你想练什么</span>
        <textarea id="scenePrompt" class="free-input" rows="3"
          placeholder="例：同事在群里否了我的方案，我想练一句不软不硬的回应"></textarea></label>
      <div class="row row-1">
        <button class="primary" id="buildBtn" onclick="buildAndStart()">建造这个场景</button>
      </div>
      <div class="row row-2">
        <button class="ghost" id="batchBtn" onclick="buildSceneBatch()">让 AI 按缺口造 ${BATCH_N} 个（各不一样，我挑一个）</button>
      </div>
      <div class="row row-2">
        <button class="ghost" id="randBtn" onclick="randomStart()">按缺口直接造一个（补现在最少的那类关系）</button>
      </div>
      <div id="sceneMsg" class="hint" style="margin-top:8px"></div>
      <div id="sceneBatch"></div>
    </div>

    ${sceneLibCard()}

    <div class="card">
      <div class="label" style="margin-bottom:4px">没有想法？点一条填进上面再改</div>
      <div class="seed-list">
        ${SCENE_SEEDS.map((x, i) => `<button class="seed" onclick="useSeed(${i})">${esc(x)}</button>`).join('')}
      </div>
    </div>

    <div class="row"><button class="ghost" onclick="openSettings()">⚙ 设置（API 密钥 / 语速）</button></div>`;
}

/* ------------------------------------------------------- AI 造的场景库
 *
 * 用户的原话：「ai 里面的情景数量太少了，你都用 AI 了，应该可以生成许多，
 * 但是也不能随机生成，只要有环境，你得给一些比较好的提示词让 AI 生成。」
 *
 * 三件事是他拍板的（我先给了分析和证据）：
 *   1. **攒成库**。以前 sceneBatch 只放内存、「换一批」把上一批直接扔掉，等于每次
 *      现出卷子、考完把卷子烧了；而学习研究里恰恰是「同一个题目隔几天换个情境再练
 *      一遍」记得最牢。所以造过的留着，能回头练。
 *   2. **一次造 6 个**（BATCH_N）。实测 9.5 秒出 6 个（造 3 个测到过 20 秒）——
 *      等待主要花在一次往返上，不随个数线性涨。反过来，反复点「换一批」等于拿同一个
 *      提示词反复要，出来的东西会越来越像（同一个模型反复抽样的两两相似度能到 0.8）。
 *   3. **只按缺口铺开**。这是"不能随机生成"的落点：造之前先数一遍现有场景，
 *      哪个关系最少、哪个难度最少，把这个缺口写成 brief 交给模型。原来那条
 *      「五轴随机」（谁/在哪/练什么/难在哪/最容易错 各抽一个拼起来）已经删掉——
 *      它会拼出「健身房的熟人 + 深夜发消息 + 必须当场答复」这种生活里不存在的
 *      组合，模型只能硬编，编出来的练了也没用。
 *
 * 关系轴用固定枚举（SCENE_STAGES），不让模型自己编：列表要「按关系混在一起」排，
 * 关系名一旦发散（今天"同事"明天"职场平级"），分组和缺口统计就全废了。
 */
const GEN_KEEP = 100;      // 库里最多留多少个（超了先淘汰没练过的，再淘汰最旧的）
const STAGE_DOMAIN = {
  '认识试探': '恋爱', '在一起磨合': '恋爱', '降温期': '恋爱',
  '职场上下': '职场', '职场平级': '职场',
  '家人日常': '家人', '朋友之间': '朋友',
  '泛社交': '泛社交', '陌生初见': '泛社交',
};
const SCENE_STAGES = Object.keys(STAGE_DOMAIN);
/* 同一次生成里同一个关系最多几个。实测里我点名要「关系分散」，6 个里 4 个还是
   同一个关系——所以这条得机械地查，不能只写在提示词里求它。 */
const PER_STAGE_MAX = 2;

function genScenes() { return Array.isArray(state.genScenes) ? state.genScenes : []; }

/** 能练的全部场景 = 打磨过的现成 + AI 造进库的（现成排在前面）。 */
function allSceneList() { return (CONTENT.scenarios.scenarios || []).concat(genScenes()); }

/** 这个场景属于哪一类关系（列表按它分组和筛选）。 */
function sceneDomain(s) { return STAGE_DOMAIN[(s && s.stage) || ''] || '泛社交'; }

/* 标题/主题的归一化写法，用来去重：空格和标点不参与比较
   （「同事在群里否了我」和「同事在群里否了我。」应当算同一个）。 */
const SCENE_KEY_STRIP = /[\s·、，。！？；：!?,.;:「」『』【】（）()《》/／—－-]/g;
function sceneKey(s) { return String((s && s.title) || '').replace(SCENE_KEY_STRIP, ''); }
function sceneTheme(s) { return String((s && s.theme) || '').replace(SCENE_KEY_STRIP, ''); }

/** 现有的标题和主题，造新的之前拿它去重。keyT/keyH 是归一化过的。 */
function sceneTaken() {
  const all = allSceneList();
  return {
    titles: all.map((x) => String(x.title || '')).filter(Boolean),
    themes: genScenes().map((x) => String(x.theme || '')).filter(Boolean),
    keyT: all.map(sceneKey).filter(Boolean),
    keyH: genScenes().map(sceneTheme).filter(Boolean),
  };
}

/** 关系/难度的缺口表。造什么由它决定，不由骰子决定。
 *  同数量时按枚举顺序排，是为了**稳定**——同一份数据每次算出来必须是同一个名单，
 *  否则测试和肉眼核对都做不了。 */
function sceneGap() {
  const count = {}, diff = { 1: 0, 2: 0, 3: 0 };
  SCENE_STAGES.forEach((k) => { count[k] = 0; });
  allSceneList().forEach((s) => {
    const st = SCENE_STAGES.indexOf(s.stage) >= 0 ? s.stage : '泛社交';
    count[st]++;
    const d = Math.min(3, Math.max(1, parseInt(s.difficulty, 10) || 2));
    diff[d]++;
  });
  const order = SCENE_STAGES.slice().sort(
    (a, b) => (count[a] - count[b]) || (SCENE_STAGES.indexOf(a) - SCENE_STAGES.indexOf(b)));
  const thinnest = Object.keys(diff).sort((a, b) => (diff[a] - diff[b]) || (a - b))[0];
  return { count, diff, order, thinnest };
}

/** 造场景的 brief：count 个场景 → 点名 count 个最缺的关系，一个关系一个。
 *  avoid 是"这一轮已经造出来的"，补造时贴上去，免得补的又跟刚造的撞。 */
function sceneBrief(count, avoid) {
  const gap = sceneGap();
  const want = gap.order.slice(0, Math.max(1, count));
  const taken = sceneTaken();
  const parts = [
    `一次给我 ${count} 个互不相同的对话练习场景。`,
    '关系按下面点名的来，一个关系一个——这几个是现在最少的：'
      + want.map((k) => `${k}（现在 ${gap.count[k]} 个）`).join('、') + '。',
    `stage 只能从这几个里挑，一个字都不要改：${SCENE_STAGES.join('、')}。`,
    `难度：现在最少的是 ${gap.thinnest} 级，至少给一个这一级的；其余按标准给。`,
    `**同一个关系最多出现 ${PER_STAGE_MAX} 次**，场合也别都挤在"当面一对一"。`,
  ];
  if (taken.titles.length) {
    parts.push('不许与下面这些重复，也不许换汤不换药（同一个主题换个说法也算重复）：'
      + taken.titles.join('、') + '。');
  }
  if (taken.themes.length) {
    parts.push('已经用过的主题（换皮也算重复）：' + taken.themes.join('、') + '。');
  }
  if (avoid && avoid.length) {
    parts.push('刚刚已经造出这几个了，别重复它们：'
      + avoid.map((x) => `${x.title}（${x.stage}）`).join('、') + '。');
  }
  return parts.join('\n');
}

/** 生成之后的机械检查。为什么不能只靠提示词：实测里点名要「关系分散」，6 个里
 *  4 个是同一个关系；写了「不要重复」，标题确实没重，但 6 个里 5 个都是"同事之间
 *  的事"。**模型答应 ≠ 做到**，所以逐条查，不合格的扔掉，缺的由调用方补造一轮。 */
function screenScenes(list, taken) {
  const out = [], dropped = [];
  const perStage = {};
  const keyT = taken.keyT.slice(), keyH = taken.keyH.slice();
  list.forEach((sc) => {
    const kt = sceneKey(sc), kh = sceneTheme(sc);
    let why = '';
    if (kt && keyT.includes(kt)) why = '标题跟已有的重复';
    else if (kh && keyH.includes(kh)) why = '主题跟已有的重复';
    else if ((perStage[sc.stage] || 0) >= PER_STAGE_MAX) why = `一次里「${sc.stage}」超过 ${PER_STAGE_MAX} 个`;
    if (why) { dropped.push({ title: sc.title, why }); return; }
    perStage[sc.stage] = (perStage[sc.stage] || 0) + 1;
    if (kt) keyT.push(kt);
    if (kh) keyH.push(kh);
    out.push(sc);
  });
  return { out, dropped };
}

/** 进库。超上限时**先淘汰一次都没练过的、最旧的**，都练过才淘汰最旧的——
 *  练过的说明对他有用，能留就留。返回淘汰了几个，好让界面说实话。 */
function addGenScenes(list) {
  const keep = genScenes().slice();
  list.forEach((sc) => {
    /* 没 id 的两条会被当成"同一条"而丢掉一条——按 id 去重的前提是 id 真的在。
       正常路径上 normalizeScenario 一定会给 id，这里是兜底：宁可补一个 id，
       也不要静默地少入一条。 */
    if (!sc.id) sc.id = 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    if (!keep.some((x) => x.id === sc.id)) keep.push(sc);
  });
  if (keep.length <= GEN_KEEP) { state.genScenes = keep; return { kept: keep.length, dropped: 0 }; }
  const done = state.scenes || {};
  const byOld = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const unpracticed = keep.filter((x) => !(done[x.id] > 0)).sort(byOld);
  const practiced = keep.filter((x) => done[x.id] > 0).sort(byOld);
  const drop = new Set();
  let over = keep.length - GEN_KEEP;
  for (const x of unpracticed.concat(practiced)) {
    if (!over) break;
    drop.add(x.id);
    over--;
  }
  state.genScenes = keep.filter((x) => !drop.has(x.id));
  return { kept: state.genScenes.length, dropped: drop.size };
}

/* --------------------------------------------------- 让 AI 一次现造几个
 *
 * 用户的原话：「ai 里面的情景数量太少了，你都用 AI 了，应该可以生成许多，
 * 但是也不能随机生成，只要有环境，你得给一些比较好的提示词让 AI 生成。」
 *
 * 所以这条路的形状是：**缺口表 → brief → 生成 → 机械检查 → 进库**。
 *   · 造之前 sceneBrief() 先数一遍现有场景（现成 14 个 + 库里），点名最缺的几个关系；
 *   · 生成之后 screenScenes() 逐条查（标题/主题是否跟已有的撞、同一次里同一个关系
 *     是否超过 PER_STAGE_MAX 个）；
 *   · 查完不够数就**只补缺的那些**（最多补一轮），然后如实告诉用户造出了几个；
 *   · 最后 addGenScenes() 进库，跟现成场景混在一起按关系排。
 *
 * 额度：按个数给（6 个场景的正文 1200-1800 token，还要留出推理的量）。这个模型的
 * 推理很凶，额度被推理吃光时的表现是"少给一两个"——用户看到的是六个变四个，
 * 看不出为什么，所以宁可给宽。
 *
 * 结果只要 JSON，外面套一层 {"scenarios":[...]}：解析器认对象里带 opening 的字段，
 * 所以模型多套一层、或者用数字当键（{"1":{...}}）都还能救回来。
 */
const BATCH_N = 6;
let sceneBatch = null;      // 最近一次造出来的（摆出来让他挑；同时也已经进库了）

/** 把模型给的东西变成能用的场景列表。宽容一点：数组、{"scenarios":[]}、
 *  数字键的对象都认，只要那个对象里有 opening。 */
function parseScenarioList(out, cap) {
  let arr = [];
  if (Array.isArray(out)) arr = out;
  else if (out && Array.isArray(out.scenarios)) arr = out.scenarios;
  else if (out && Array.isArray(out.list)) arr = out.list;
  else if (out && typeof out === 'object') {
    arr = Object.values(out).filter((v) => v && typeof v === 'object' && (v.opening || v.her));
  }
  return arr.filter((v) => v && v.opening).slice(0, cap).map((v, i) => normalizeScenario(v, i));
}

/** 造一批（count 个），带机械检查和一轮补造。返回 {got, dropped, tried}。
 *  avoid 是"这一轮已经造出来的"，补造时贴上，免得补的又跟刚造的撞。 */
async function generateScenes(count, avoid) {
  const out = await llmCall([
    { role: 'system', content: SCENE_SYS },
    { role: 'user', content: sceneBrief(count, avoid) },
  ], { temperature: 0.95, maxTokens: 4000 + count * 900 });
  return parseScenarioList(out, count);
}

async function buildSceneBatch() {
  const btn = document.getElementById('batchBtn');
  const msg = document.getElementById('sceneMsg');
  const box = document.getElementById('sceneBatch');
  if (btn) { btn.disabled = true; btn.textContent = '正在造…'; }
  if (msg) msg.textContent = `正在按缺口造 ${BATCH_N} 个不一样的场景…`
    + '一次模型调用，要等十几秒，别退出去。';
  if (box) box.innerHTML = '';
  try {
    const taken = sceneTaken();
    let got = [], dropped = [];
    let retryErr = '';
    let r = screenScenes(await generateScenes(BATCH_N, null), taken);
    got = r.out; dropped = r.dropped;
    /* 只补缺的那些，最多补一轮。为什么补：模型经常少给（被推理吃掉额度）或者
       给的里面有一两个跟已有的撞——直接认了的话，用户点一次只拿到三四个。
       补造失败**不算**整次失败（手里已经有的照常进库），但失败的原因要留下来，
       并在下面如实说一句——吞掉异常的话，症状会变成"点了一次只多三个，不知道为什么"。 */
    if (got.length < BATCH_N) {
      if (msg) msg.textContent = `造出 ${got.length} 个合格的，补造 ${
        BATCH_N - got.length} 个…还要再等十几秒。`;
      try {
        const again = await generateScenes(BATCH_N - got.length, got);
        const r2 = screenScenes(again, sceneTaken());
        // 补的那一轮也要跟这一轮已经拿到的比一遍
        const merged = screenScenes(got.concat(r2.out), { keyT: taken.keyT.slice(), keyH: taken.keyH.slice() });
        got = merged.out;
        dropped = dropped.concat(r2.dropped, merged.dropped);
      } catch (e) { retryErr = String((e && e.message) || e); }
    }
    if (!got.length) throw new Error('模型没给出可用的场景，再试一次');
    const res = addGenScenes(got);
    save();
    sceneBatch = got;
    renderSceneBatch();
    if (msg) {
      /* 说实话：造了几个、为什么少了几个。这两个数字用户看不到的话，
         "点一次只多两个"会被当成坏了。 */
      const miss = BATCH_N - got.length;
      msg.innerHTML = `造好了 <b>${got.length}</b> 个，已经进下面的库了，能回头再练。`
        + (miss > 0 ? `（少了 ${miss} 个：${dropped.slice(0, 3).map((d) => d.why).join('，')
            || (retryErr ? '补造那一步失败了：' + esc(retryErr) : '模型没给够')}）` : '')
        + (res.dropped ? ` 库满了，淘汰了最旧的 ${res.dropped} 个。` : '');
    }
  } catch (e) {
    if (msg) msg.innerHTML = '<b>没造成：</b>' + esc(e.message || String(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `让 AI 按缺口造 ${BATCH_N} 个（各不一样，我挑一个）`; }
  }
}

/** 把现造的这几个摆出来。每张卡都写清楚：对方是谁、要练什么、最容易怎么错——
 *  **选之前就能看见**，这才叫"挑"，而不是"抽"。 */
function renderSceneBatch() {
  const box = document.getElementById('sceneBatch');
  if (!box) return;
  if (!sceneBatch || !sceneBatch.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="batch-wrap">
      <div class="batch-head">刚造的 ${sceneBatch.length} 个（已经进下面的库了，回头能再练）</div>
      ${sceneBatch.map((sc, i) => `
        <div class="batch-card">
          <div class="batch-top">
            <b>${esc(sc.title)}</b>
            <span class="seed-meta">${esc(sc.stage)} · 难度 ${esc(String(sc.difficulty))}</span>
          </div>
          <div class="hint">${esc(sc.her)}</div>
          <div class="hint" style="margin-top:6px">你要练的：${esc(sc.goal)}</div>
          <div class="hint" style="margin-top:6px">最容易错在：${esc(sc.trap)}</div>
          <button class="ghost batch-go" onclick="startBatchScene(${i})">练这个</button>
        </div>`).join('')}
      <div class="row row-2">
        <button class="ghost" onclick="buildSceneBatch()">再按缺口造 ${BATCH_N} 个</button>
        <button class="ghost" onclick="sceneBatch=null;renderSceneBatch()">收起</button>
      </div>
    </div>`;
}

function startBatchScene(i) {
  const sc = sceneBatch && sceneBatch[i];
  if (!sc) return;
  startSession(sc);
}

function toggleAllScenes() {
  scenesExpanded = !scenesExpanded;
  renderTalkSetup();
}

/** 造一个。走的还是缺口表：点名现在最少的那一个关系。
 *  原来这里是"五轴随机"（谁/在哪/练什么/难在哪/最容易错 各抽一个拼起来），
 *  用户拍板改成"只按缺口铺开"之后删掉了——那种拼法会造出生活里不存在的组合。
 *  名字保留 randomPrompt 是因为调用点多，但"随机"这件事已经不在这里了。 */
function randomPrompt() {
  return sceneBrief(1, null);
}

/** AI 造出来的场景都进库（自己写提示词造的那个也一样）：造过的留着，回头能再练。
 *  去重没过也照样开局——用户明确要练这一个，不该被去重挡在门外。 */
function libraryScene(sc) {
  try {
    const r = screenScenes([sc], sceneTaken());
    if (r.out.length) { addGenScenes(r.out); save(); }
  } catch (e) { /* 进库失败不影响开局 */ }
  return sc;
}

async function randomStart() {
  const btn = document.getElementById('randBtn');
  const msg = document.getElementById('sceneMsg');
  const current = beginSceneRequest(msg);
  if (btn) { btn.disabled = true; btn.textContent = '正在造…'; }
  if (msg) msg.textContent = '正在按缺口造一个场景（补现在最少的那类关系）…';
  try {
    const sc = await buildScenario(randomPrompt(), current);
    if (!current()) return;
    libraryScene(sc);
    if (btn) { btn.disabled = false; btn.textContent = '按缺口造一个'; }
    await startSession(sc);
  } catch (e) {
    if (!current()) return;
    if (btn) { btn.disabled = false; btn.textContent = '按缺口造一个'; }
    if (msg) msg.innerHTML = '<b>没建成：</b>' + esc(e.message || String(e));
  }
}

function useSeed(i) {
  const el = document.getElementById('scenePrompt');
  if (el) { el.value = SCENE_SEEDS[i] || ''; el.focus(); }
}

/** 造场景也会异步切换会话：只让最后一次、仍在原页面上的选择生效。 */
function beginSceneRequest(msg) {
  const sess = V.sess, epoch = V.sessionEpoch, request = {};
  const view = document.getElementById('view');
  const page = view && view.firstElementChild;
  V.sceneRequest = request;
  return () => sessionIsCurrent(sess, epoch) && V.sceneRequest === request
    && (msg ? document.getElementById('sceneMsg') === msg
      : view && page && document.getElementById('view') === view && view.firstElementChild === page);
}

async function buildAndStart() {
  const el = document.getElementById('scenePrompt');
  const btn = document.getElementById('buildBtn');
  const msg = document.getElementById('sceneMsg');
  const current = beginSceneRequest(msg);
  const prompt = el ? el.value : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在建造…'; }
  if (msg) msg.textContent = '正在把这个提示词变成场景…';
  try {
    const sc = await buildScenario(prompt, current);
    if (!current()) return;
    libraryScene(sc);       // 自己写提示词造的也进库，回头能在列表里再练一遍
    if (btn) { btn.disabled = false; btn.textContent = '建造这个场景'; }
    await startSession(sc);
  } catch (e) {
    if (!current()) return;
    if (btn) { btn.disabled = false; btn.textContent = '建造这个场景'; }
    if (msg) msg.innerHTML = '<b>没建成：</b>' + esc(e.message || String(e));
  }
}

function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }

  const sc = V.sess.sc;
  $('#view').innerHTML = `
    <div class="card v-head">
      <div>
        <div class="mk" style="font-size:.72rem;color:#b98ce8;font-weight:600">${esc(sc.title)}</div>
        <div class="vh-temp">
          <span>${ta()}的温度</span>
          <div class="tbar"><i id="tbar" style="width:${V.sess.temp}%"></i></div>
          <b id="tnum">${V.sess.temp}</b>
        </div>
      </div>
      <button class="ghost" onclick="endSession()">结束</button>
    </div>
    <div id="herSlot"></div>
    <div class="card v-talk" id="talkCard">
      <div class="type-row">
        <button class="ghost hint-btn" id="hintBtn" onclick="toggleTalkHint()" title="不知道怎么接的时候点这里">提示</button>
        <input type="text" id="typeIn" placeholder="打字回她（回车也能发）" onkeydown="if(event.key==='Enter')sendTyped()">
        <button class="primary" style="width:auto;padding:10px 16px" onclick="sendTyped()">发出</button>
      </div>
      <div id="talkHint" class="hint-panel"></div>
      <div class="hint" id="turnHint" style="margin-top:8px"></div>
      <div class="ask-meter" id="askMeter"></div>
    </div>`;
  updateAskMeter();

  /* 把已经聊过的几轮重新画出来。
   *
   * 这里原来什么都没有——于是**切走再切回来，屏幕上的对话就空了**（V.sess 还在，
   * 但 herSlot 是新建的空壳），从历史里「接着聊」也一样看不到前面聊过什么。
   * 用户看到的是「刚才那一局没了」，而 App 其实什么都没丢：这类"状态在、
   * 显示没了"最容易让人以为东西丢了。
   * 现在渲染完统一重放一遍：记录就是那个 record 的 log，重放是幂等的。 */
  replayTurns();
}

/** 把这一局已经发生过的对话重新画进 #herSlot。
 *  quiet=true 传下去是为了不要在重放时一轮一轮地平滑滚动（那会看着像抽搐）。 */
function replayTurns() {
  const s = V.sess;
  if (!s) return;
  const slot = document.getElementById('herSlot');
  if (!slot) return;
  if (!s.log || !s.log.length) return;
  /* 她的开场白不在 log 里：log 只记"你来我往"的轮次（复盘时开场白是单独作为
     「第 0 轮」送进提示词的，写进 log 会重复一次）。所以这里补画出来。 */
  showHerTurn({
    reply: (s.sc && s.sc.opening) || '',
    tone: '平淡',
    inner: (s.sc && s.sc.her_state) || '',
    signal: '（开局）',
    rating: '平',
    rating_why: '先听她说，别急着回',
    temp: (s.sc && s.sc.temp0) || 50,
  }, true);
  s.log.forEach((o) => {
    if (o.userText) pushBubble('me', o.userText);
    showHerTurn(o, true);
  });
  slot.scrollIntoView({ behavior: 'auto', block: 'end' });
}

function showHerTurn(o, quiet) {
  const slot = document.getElementById('herSlot');
  if (!slot) return;
  const rs = RATING_STYLE[o.rating] || RATING_STYLE['平'];
  /* 白话回来那种：她只说了一句话，没有内心独白也没有打分。
     这时不摆四个空框（那看起来像坏了），只把话说清楚：
     话是有效的，为什么没有那几项，然后你接着回就行。 */
  const plainNote = o.__plain ? `
      <p class="hint" style="margin:10px 0 0">
        这一句她没有按格式输出，所以没有语气、内心和打分——<b>话本身是有效的</b>，
        你照样可以接着回。要是这一局后面一直这样，多半是模型没在按提示词走，
        换一个模型或者在设置里换个说法都行。
      </p>` : '';
  slot.insertAdjacentHTML('beforeend', `
    <div class="card her-card t-${slug(o.tone)}">
      <div class="her-line">「${esc(o.reply)}」</div>
      <div class="her-tone">${ta()}的语气：${esc(o.tone || '—')}</div>
      ${o.__plain ? plainNote : `
      <div class="mono">
        <div class="mono-h">${ta()}的内心</div>
        <div>${rich(o.inner || '')}</div>
      </div>
      <div class="rate-line">
        <span class="rate ${rs.cls}">${esc(o.rating || '平')}</span>
        <span>${rich(o.rating_why || '')}</span>
      </div>
      <div class="sig">你刚才发出的信号：${esc(o.signal || '—')}</div>`}
    </div>`);
  const bar = document.getElementById('tbar');
  const num = document.getElementById('tnum');
  if (bar) bar.style.width = (o.temp == null ? V.sess.temp : o.temp) + '%';
  if (num) num.textContent = (o.temp == null ? V.sess.temp : o.temp);
  // 她说话了 = 该你回了 → 上一次的提示作废（过期的建议比没有更误导）
  closeTalkHint();
  if (!quiet) slot.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function pushBubble(who, text) {
  const slot = document.getElementById('herSlot');
  if (!slot) return;
  slot.insertAdjacentHTML('beforeend',
    `<div class="bub ${who}">${esc(text)}</div>`);
  slot.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/* ------------------------------------------------------------ 接话提示
 *
 * 用户的原话：「我对话的时候，有时候完全不知道怎么回，能不能给提示呢？
 * 就在旁边，点击可以查看提示。我感觉我完全不会说话了。」
 *
 * 所以这一块要解决的是**卡住**，不是提供答案。分两层：
 *   第一层（本地规则，点一下就有）：挑一个方向 + 一个句式骨架。
 *     为什么必须是本地：他卡住的那一刻最需要帮助，那时候如果要等模型三秒、
 *     或者因为没网/没填密钥而不可用，这个功能就等于不存在。
 *     本地规则按她那句话的**形状**猜（有没有情绪词、是不是问句、有多长），
 *     界面上会如实说这是猜的，不是标准答案。
 *   第二层（点「给我一句能照着说的」才走）：调一次模型给一句示范。
 *     明确标成"示范"，并提醒先自己说一句——不然就成了照着念，练不到东西。
 *
 * 提示面板在她说下一句时自动收起（见 showHerTurn 里的 closeTalkHint）：
 * 过期的建议比没有建议更误导。
 */
const HINT = { open: false, forLine: '', demo: '', demoLine: '', request: null };

function talkHintCfg() { return CONTENT.talkhints || {}; }
function talkMoves() { return talkHintCfg().moves || []; }
function talkMove(id) { return talkMoves().find((m) => m.id === id) || talkMoves()[0] || null; }

/** 她最后说的那句（开局那句也算：它在 history 里，只是没进 log） */
function lastHerLine() {
  if (!V.sess) return '';
  const h = [...(V.sess.history || [])].reverse().find((x) => x.role === 'assistant');
  return h ? String(h.content || '') : '';
}

/* 情绪词。挑方向用的，不要它精确——判错了也只是建议换一个方向，
   而且界面上写明了这是按形状猜的。 */
const TALK_EMO = /累|烦|气|难受|委屈|怕|慌|焦虑|崩|郁闷|不开心|难过|开心|高兴|爽|紧张|压力|没劲|无语|服了/;
/* 问句的判据分强弱两档，因为中文里同一个词在做陈述时也会出现：
     「你有什么想法吗」是问句；「我投了几份简历也没什么回音」是陈述。
   如果只按"出现过疑问词"判断，第二种就会被当成"她在问你"，方向直接指错
   （第一版就是这样：一段没有情绪的长话被判成了问句）。
   所以：**句末的问号/吗/呢 是强信号**（多长都算问句）；
   疑问词只是弱信号，只在话比较短的时候才算。 */
const TALK_ASK_STRONG = /[?？]\s*$|吗\s*[。！]?$|呢\s*[。！]?$/;
const TALK_ASK_WEAK = /什么|怎么|为什么|哪|多少|几点|几号|干嘛|干什么|如何|怎样/;
const TALK_PLAY = /哈+|笑|开玩笑|自嘲|居然|竟然|逗|梗/;

/** 按她那句话的形状，挑一个接话方向。纯本地，不调模型。
 *  顺序是有意的：情绪 > 极短 > 玩笑 > 强问句 > 长段 > 弱问句 > 有细节 > 兜底。
 *  · 情绪排在问句前面：「你是不是觉得我很烦？」这种既是问句又带情绪，
 *    而先接情绪永远是对的（也是这个 App 课程里 p30 那条）。
 *  · 强问句排在长段前面：「你觉得我这样算不算失败呢」不管多长都该先答。 */
function pickTalkMove(line) {
  const t = String(line || '').trim();
  if (!t) return { id: 'share', why: '还没听到她说什么，先说一件你自己的具体小事。' };
  if (TALK_EMO.test(t)) {
    return { id: 'feel', why: `她那句里有情绪（「${(t.match(TALK_EMO) || [''])[0]}」），先接情绪。` };
  }
  if (t.length <= 6 && !TALK_ASK_STRONG.test(t)) {
    return { id: 'pass_back', why: `她只回了「${t}」。这么短通常是没力气接，该你多给一点。` };
  }
  if (TALK_PLAY.test(t)) {
    return { id: 'play', why: '她这句像在开玩笑或自嘲，顺着语气接下来。' };
  }
  if (TALK_ASK_STRONG.test(t)) {
    return { id: 'answer_ask', why: '她在问你——先正面答具体一点，再递回去一句。' };
  }
  if (t.length >= 60) {
    return { id: 'summarize', why: '她说了一大段——先把她最在意的那个点说出来。' };
  }
  if (TALK_ASK_WEAK.test(t) && t.length < 40) {
    return { id: 'answer_ask', why: '她这句像在问——先正面答具体一点，再递回去一句。' };
  }
  if (/[，。；！]/.test(t) && t.length >= 16) {
    return { id: 'dig', why: '她说了件具体的事，顺着那个细节问下去。' };
  }
  return { id: 'share', why: '没有明显可接的点，就给一件你自己的具体小事。' };
}

function toggleTalkHint() {
  if (HINT.open) { closeTalkHint(); return; }
  openTalkHint();
}

function closeTalkHint() {
  HINT.request = null;
  const p = document.getElementById('talkHint');
  if (p) p.innerHTML = '';
  HINT.open = false;
  HINT.demo = '';
  const b = document.getElementById('hintBtn');
  if (b) b.textContent = '提示';
}

function openTalkHint() {
  HINT.request = null;
  const panel = document.getElementById('talkHint');
  if (!panel) return;
  const line = lastHerLine();
  const pick = pickTalkMove(line);
  const m = talkMove(pick.id);
  if (!m) return;
  HINT.open = true;
  HINT.forLine = line;
  HINT.demo = '';
  const b = document.getElementById('hintBtn');
  if (b) b.textContent = '收起';
  panel.innerHTML = `
    <div class="hint-head">
      <b>${esc(m.name)}</b>
      <span class="hint-why">${esc(pick.why)}</span>
    </div>
    <p class="hint" style="margin:6px 0 0">${esc(m.how)}</p>
    <p class="hint" style="margin:6px 0 0">可以照着说的句式：<b>${esc(m.skeleton)}</b></p>
    <p class="hint" style="margin:6px 0 0">容易犯：${esc(m.trap)}</p>
    <div class="row row-2" style="margin-top:10px">
      <button class="ghost" id="hintDemoBtn" onclick="talkHintDemo()">给我一句能照着说的</button>
      <button class="plain" onclick="closeTalkHint()">先不用</button>
    </div>
    <div id="hintDemo" class="hint-demo"></div>
    <p class="hint" style="margin:6px 0 0">
      点「给我一句」会调一次模型（这一局本来就在用模型，多这一次）；<b>先自己说一句</b>，
      说不出再点它——照着念练不到东西。
    </p>
    <p class="hint" style="margin:6px 0 0">
      这个方向是按她那句话的形状猜的，不是标准答案：她真是个反问、或者你想换个方向聊，
      都完全可以。
    </p>`;
}

/** 要一句示范。走 textOk：给白话就行，不必是 JSON。 */
async function talkHintDemo() {
  const panel = document.getElementById('talkHint');
  const btn = document.getElementById('hintDemoBtn');
  const cfg = talkHintCfg();
  const dp = cfg.demo_prompt || {};
  if (!V.sess || V.ended || !HINT.open || !panel) return;
  if (V.busy) { toast('她还在说，等她说完再要'); return; }
  const s = settings();
  if (V.native && !s.apiKey) {
    toast('没填 API 密钥，用不了示范——上面的句式骨架照着说就行');
    return;
  }
  const sess = V.sess, epoch = V.sessionEpoch, historyLength = sess.history.length;
  const request = {};
  HINT.request = request;
  const current = () => sessionIsCurrent(sess, epoch) && !V.ended
    && HINT.open && HINT.request === request && sess.history.length === historyLength
    && document.getElementById('talkHint') === panel;
  if (btn) { btn.disabled = true; btn.textContent = '正在想…'; }
  try {
    const line = lastHerLine();
    const last = sess.log[sess.log.length - 1];
    const user = [
      `对方刚说的是：「${line}」`,
      last && last.inner ? `她心里其实在想：${last.inner}` : '',
      sess.sc ? `场景：${sess.sc.title || ''}` : '',
      '给我一句我能直接说出口的回应。',
    ].filter(Boolean).join('\n');
    const o = await llmCall([
      { role: 'system', content: [dp.role || '你是口语教练。', ...(dp.rules || [])].join('\n') },
      { role: 'user', content: user },
    ], {
      temperature: 0.8,
      /* 额度给到 1600：这个模型的推理很凶（实测一次要写几百到两千多字推理），
         600 的时候推理直接把额度吃光，正文一个 token 都不剩——真机实测过。
         而且它和"一句不超过 30 字"的输出要求没关系，额度是给推理留的。 */
      maxTokens: 1600,
      textOk: true,
      noFormat: true,      // 这一步要的是**白话一句**，不能带 response_format
      isCurrent: current,
    });
    if (!current()) return;
    /* 万一它还是回了个 JSON（模型偶尔会），也尽量把里面那句人话捞出来，
       而不是显示成空白。实测见过 {"suggestion":"…"} 这种形状。 */
    const demo = String(o.reply || (o.__plain ? '' : firstStringValue(o)) || '').trim();
    if (!demo) throw new Error('模型没给出示范——用上面的句式骨架照着说就行');
    HINT.demo = demo;
    HINT.demoLine = line;
    const box = document.getElementById('hintDemo');
    if (box) {
      box.innerHTML = `<div class="demo-line">「${esc(demo)}」</div>
        <div class="row row-2" style="margin-top:8px">
          <button class="plain" onclick="useDemo()">填进输入框，我改一改</button>
          <button class="plain" onclick="talkHintDemo()">再给我一句</button>
        </div>`;
    }
  } catch (e) {
    if (current()) toast(e.message || '要不到示范');
  } finally {
    if (current() && btn) { btn.disabled = false; btn.textContent = '给我一句能照着说的'; }
  }
}

/** 把示范填进输入框——但要让他改。直接发出去等于替他说话。 */
function useDemo() {
  const el = document.getElementById('typeIn');
  if (!el) return;
  el.value = HINT.demo || '';
  el.focus();
  toast('填进去了。改一改再说出口——改过的才是你的');
}

/** 对象里第一个字符串值。用于"模型还是回了 JSON"时把那句话捞出来。
 *  只取第一层、只取字符串：够用，而且不会把嵌套结构拼成乱码。 */
function firstStringValue(o) {
  if (!o || typeof o !== 'object') return '';
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function setHerThinking(on) {
  const h = document.getElementById('turnHint');
  if (h) h.textContent = on ? (ta() + '在想怎么回你…') : '';
}

function renderTurnHint(t) {
  const h = document.getElementById('turnHint');
  if (h) h.textContent = t;
}

function cutWithEllipsis(t, n) {
  const str = String(t == null ? '' : t).trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function slug(s) { return String(s || '').replace(/[^\u4e00-\u9fa5a-z]/gi, '') || 'mid'; }

/* 对方的人称。中文没有中性的第三人称，所以由场景自己带一个 `ta`。
   6 个老场景都是女性、不带这个字段，默认「她」，行为完全不变；
   随机造的场景可能是个男同事或男上级，那时界面上如果是「她的内心」就对不上了。
   界面文案只从这里取人称——**一处定义**，避免又出现「有的地方改了她有的没改」。 */
function ta() { return (V.sess && V.sess.sc && V.sess.sc.ta) || '她'; }

function sendTyped() {
  const el = document.getElementById('typeIn');
  if (!el) return;
  const t = el.value.trim();
  if (!t) return;
  el.value = '';
  userSaid(t);
}

/* ---------------------------------------------------------------- 复盘 */

function endSession() {
  const s = V.sess;
  if (!s) return;
  invalidateSessionWork();
  /* 练完一局给这个情景记一笔。用途只有「今天就练这个」的轮换——
     没有它，那个推荐会一直推同一个，用户点两次就再也不看推荐了。
     只记现成情景：现造的场景每次 id 都不同，记下来就是一堆只出现一次的垃圾数据。
     V.ended 同时也是幂等开关：结束页会被反复渲染，但 endSession 只该记账一次。 */
  if (!V.ended && s.sc && !/^gen-/.test(s.sc.id)) {
    state.scenes = state.scenes || {};
    state.scenes[s.sc.id] = (state.scenes[s.sc.id] || 0) + 1;
    save();
  }
  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;
  // 先存结束状态，切到下一局时无需等复盘请求完成。
  storeTalkRecord(s, V.lastDebrief, true);
  const log = s.log;
  const avg = log.length ? Math.round(log.reduce((a, b) => a + (RATING_STYLE[b.rating] ? 1 : 0), 0) / log.length * 100) : 0;
  const goods = log.filter((x) => x.rating === '妙' || x.rating === '好').length;
  const bads = log.filter((x) => x.rating === '失误' || x.rating === '漏着').length;
  const worst = log.filter((x) => x.rating === '漏着' || x.rating === '失误')
    .sort((a, b) => (RATING_STYLE[a.rating].delta) - (RATING_STYLE[b.rating].delta))[0];

  $('#view').innerHTML = `
    <div class="card">
      <h2>这一局结束</h2>
      <p class="hint" style="margin-top:8px">${esc(s.sc.title)} · 聊了 ${talkRounds(s)} 轮</p>
      <div class="score-row">
        <div><b>${goods}</b><span>接住了</span></div>
        <div><b>${bads}</b><span>没接住</span></div>
        <div><b>${s.temp}</b><span>对方的温度</span></div>
      </div>
    </div>

    ${askReport(s)}

    <div class="card">
      <h3>这一局的复盘</h3>
      <div id="debriefBody" class="hint" style="margin-top:8px">正在生成…</div>
    </div>

    ${worst ? `<div class="card">
      <h3>最该回头看的一句</h3>
      <div class="her-line" style="margin-top:8px">「${esc((log.find(x=>x===worst)||{}).reply || '')}」</div>
      <div class="mono"><div class="mono-h">${ta()}那句的内心</div><div>${rich(worst.inner || '')}</div></div>
      <div class="rate-line"><span class="rate ${(RATING_STYLE[worst.rating]||{}).cls}">${esc(worst.rating)}</span>
        <span>${rich(worst.rating_why || '')}</span></div>
    </div>` : ''}
    <div class="card">
      <h3>逐轮记录</h3>
      ${log.length === 0 ? '<p class="hint">这一局没聊几句。</p>' : log.map((o, i) => `
        <div class="round">
          <div class="round-h"><span class="rate ${(RATING_STYLE[o.rating]||{}).cls}">${esc(o.rating||'平')}</span>
            <span class="hint">第 ${i + 1} 轮 · 温度 ${o.temp}</span></div>
          <div class="her-line">「${esc(o.reply)}」</div>
          <div class="hint">${rich(o.rating_why || '')}</div>
        </div>`).join('')}
    </div>
    <div class="row row-1"><button class="primary" onclick="replaySession()">再来一局</button></div>
    <div class="row row-2">
      <button class="ghost" onclick="randomStart()">随机换一个</button>
      <button class="ghost" onclick="V.sess=null;renderTalkSetup()">自己挑一个</button>
    </div>
`;
  window.scrollTo({ top: 0 });
  fillDebrief();
}

/** 再来一局。必须用场景对象而不是 id：随机生成的场景 id 是 gen-…，
 *  按 id 查不到，原来的写法会让这个按钮点了没反应、也不报错。 */
function replaySession() {
  const sc = V.sess && V.sess.sc;
  if (sc) startSession(sc);
}

/* ---------------------------------------------------------------- 复盘 */

async function makeDebrief(sess, isCurrent) {
  if (!sess.log.length) throw new Error('这一局没聊几句，没什么可复盘的');
  const sc0 = sess.sc || {};
  /* 开场白单独放在最前面。log 里没有它（forcedReply 那条路直接 return 了），
     但复盘的第一个判断就是「他的第一句有没有接上她说的」——
     缺了开场白，那句话是在回应什么就无从得知，模型只能夸他「回应及时」这种空话。 */
  const head = [
    '第 0 轮（开局，还没轮到他说）',
    `${taOf(sc0)}开口：「${sc0.opening || ''}」`,
  ].join('\n');

  const lines = sess.log.map((o, i) => {
    const r = [
      `第 ${i + 1} 轮`,
      `他说：「${o.userText || '（没说话）'}」`,
      `${taOf(sc0)}回：「${o.reply || ''}」`,
      `${taOf(sc0)}心里的想法：${o.inner || '（没给）'}`,
      `给他的分：${o.rating || '平'}${o.rating_why ? '——' + o.rating_why : ''}`,
    ];
    return r.join('\n');
  }).join('\n\n');

  const sys = [
    '你在给一次「对话练习」做复盘。用户是成年男性，在练怎么把话说对。',
    '他要的是**能用的东西**，不是鼓励。把他当成一个请你帮忙看录像的熟人。',
    '',
    '硬性要求：',
    '1. **必须基于记录里他真正说过的话**，并引用原话（加引号）。',
    '   引用原话比抽象评价有用得多，也不容易显得像套话。',
    '2. **不要恭维。** 如果整体不好就直接说不好；如果只有一处做得好，',
    '   就只说那一处，不要为了让他舒服而凑出三条优点。',
    '3. 每条改进必须是**一个具体动作**，并给出「下一次可以这么说」的原话示例。',
    '   不许写「多倾听」「要有同理心」「注意分寸」这类正确但没法执行的话。',
    '4. 不要编造记录里没有的内容。不要评价对方这个人——对方是模型演的，不是真人，',
    '   评价他等于在评价题目。',
    '5. 中文口语。不要鸡汤腔，不要排比句，不要小标题。',
    '',
    '只输出 JSON：',
    '{',
    '  "verdict": "整体评价，2-3 句，像教练不像鼓励师",',
    '  "pattern": "他这一局反复出现的一个模式，一句话点破（也可以是好的）",',
    '  "keeps": ["下一局要保持的，0-3 条，每条 30 字以内"],',
    '  "fixes": [{"act":"要改的动作，20 字以内",',
    '             "say":"下一次可以这么说（给一句原话）",',
    '             "why":"为什么这样更好，40 字以内"}],',
    '  "one": "下一局只盯这一件事，一句话"',
    '}',
  ].join('\n');

  const sc = sess.sc;
  const user = [
    `场景：${sc.title}`,
    `对方是谁：${sc.her || ''}`,
    `对方嘴上没说的：${sc.her_state || ''}`,
    `他这一局的目标：${sc.goal || ''}`,
    `这个场景最常见的错法：${sc.trap || ''}`,
    '',
    '对话记录：',
    head,
    '',
    lines,
    '',
    `最后对方的温度：${sess.temp}（起点 50，越低越疏远）`,
    `他这一局提了 ${sess.asked || 0} 个问题，其中 ${sess.followUps || 0} 个是追问。`,
  ].join('\n');

  return await llmCall([{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.7, isCurrent });
}

async function fillDebrief() {
  const box = document.getElementById('debriefBody');
  if (!box || !V.sess || !V.ended) return;
  const sess = V.sess, epoch = V.sessionEpoch;
  const request = {};
  V.debriefRequest = request;
  const current = () => sessionIsCurrent(sess, epoch) && V.ended && V.debriefRequest === request;
  box.innerHTML = '正在按你说过的原话生成复盘…（会多花一次模型调用）';
  try {
    const d = await makeDebrief(sess, current);
    if (!current()) return;
    V.lastDebrief = d;
    storeTalkRecord(sess, d, true);
    if (document.getElementById('debriefBody') === box) {
      box.innerHTML = renderDebrief(d) + talkSavedLine(sess);
    }
  } catch (e) {
    if (!current()) return;
    /* 分析没生成出来，但这一局是真实发生过的：先把它存进历史（不带分析），
       之后再从历史详情里点「现在生成分析」补上。丢掉整条才是真的可惜。 */
    const rec = storeTalkRecord(sess, null, true);
    if (document.getElementById('debriefBody') !== box) return;
    box.innerHTML = `<b>复盘没生成出来：</b>${esc(e.message || String(e))}
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="fillDebrief()">再试一次</button>
      </div>
      ${rec ? `<p class="hint" style="margin-top:8px">
        这一局本身已经存进历史记录了，分析可以之后在历史里补。</p>` : ''}`;
  }
}

/** 分析生成好之后那一行小字：告诉用户记录在哪、怎么进去看。 */
function talkSavedLine(sess) {
  if (!sess || !sess.sid || !(sess.log || []).length) return '';
  return `<p class="hint" style="margin-top:10px">
    这一局已经存进<button class="link-btn" onclick="openTalkHistory()">对话历史</button>了（逐轮记录 + 这份分析）。</p>`;
}

function renderDebrief(d) {
  const keeps = (d.keeps || []).filter(Boolean);
  const fixes = (d.fixes || []).filter((f) => f && f.act);
  return `
    ${d.verdict ? `<p class="deb-verdict">${rich(d.verdict)}</p>` : ''}
    ${d.pattern ? `<div class="deb-pattern"><b>反复出现的模式 · </b>${rich(d.pattern)}</div>` : ''}
    ${keeps.length ? `<div class="deb-block">
      <div class="deb-h">做对了，下一局保持</div>
      <ul class="deb-list">${keeps.map((k) => `<li>${rich(k)}</li>`).join('')}</ul>
    </div>` : ''}
    ${fixes.length ? `<div class="deb-block">
      <div class="deb-h">要改的地方</div>
      ${fixes.map((f) => `<div class="deb-fix">
        <div class="deb-act">${esc(f.act || '')}</div>
        ${f.say ? `<div class="deb-say">下一次可以这么说：「${esc(f.say)}」</div>` : ''}
        ${f.why ? `<div class="hint" style="margin-top:6px">${rich(f.why)}</div>` : ''}
      </div>`).join('')}
    </div>` : ''}
    ${d.one ? `<div class="deb-one">下一局只盯这一件事：<b>${rich(d.one)}</b></div>` : ''}`;
}

/* 追问报告。刻意把它放在「温度」「接住了几次」旁边，因为它是这一局里
   唯一一个**可数的行为指标**——语气和分寸不好量化，但「你问了几个问题」
   是数得出来的，而且它和「被喜欢」之间的关系有实验支持（见 noteQuestion）。 */
function askReport(s) {
  const a = s.asked || 0;
  const f = s.followUps || 0;
  const turns = Math.max(s.turn, 1);
  const rate = Math.round(f / turns * 100);
  return `<div class="card">
    <h3>你提了多少问题</h3>
    <div class="score-row" style="margin-top:10px">
      <div><b>${a}</b><span>提问</span></div>
      <div><b>${f}</b><span>追问</span></div>
      <div><b>${rate}%</b><span>轮次占比</span></div>
    </div>
    <div class="diag-why" style="margin-top:12px">
      ${f === 0
        ? '这一局你一个追问都没有。追问是少数几个有实验支持、而人们又普遍预料不到的加分动作——提问多的人被对方更喜欢，追问尤其有效（Huang 等 2017），而且收益会累积（Yeomans 等 2019）。它管用的原因是「被感知到的回应性」：你追问，说明上一句你真听进去了，而不是在等自己开口。'
        : `追问了 ${f} 次。这是这一局里最扎实的一个信号——追问会让人觉得被听进去了，而且每多一次都还有用（Yeomans 等 2019）。`}
    </div>
    <div class="diag-fix" style="margin-top:10px">
      <b>怎么做到：</b>把她刚说的那句话里挑一个具体的东西接着问——一个时间、一个人、一件事的结果。
      别问「然后呢」，那是催她继续讲；要问「那你当时怎么说的」，那才是你听进去了。
    </div>
    <div class="hint" style="margin-top:8px">
      判定是自动的、近似的：带疑问词算提问，问题里出现她上一句的片段算追问。会有误差，看趋势就行。
    </div>
  </div>`;
}

/* ------------------------------------------------------------ 对话历史
 *
 * 用户的原话：「ai对话，可以给出一个结束功能，点击结束之后，然后对于整段对话
 * 进行一个综合分析，以及提出建议，之后保存到历史记录，有一个小图标，可以点进去查看。
 * 以及不用的可以删除。」
 *
 * 三件事：存、看、删。分述几个不那么显然的决定：
 *
 * 1. **存的是整局，不只是那段分析。** 分析是模型的话，逐轮记录才是他自己的话。
 *    隔一个月再看，「我那天到底怎么说的」比「模型说我怎样」有用得多。
 * 2. **分析失败也要存。** 没填密钥、没网、模型抽风——这些都会让分析生成不出来，
 *    但那一局本身是真实发生过的，不能因为分析失败就一起丢掉。所以记录先落盘、
 *    分析后补，历史上留一个「生成分析」的按钮可以随时再补一次。
 * 3. **存在 state 里**（localStorage + 备份 JSON 都是同一个 state），
 *    所以它跟着备份走，卸载重装能捞回来。这也是他要求的那条：
 *    外部存储只留一个纯文本 .json，没有额外进程和脚本。
 *
 * 只留最近 40 局：localStorage 有配额，一局一二十轮、每轮几百字，
 * 40 局大约几百 KB，安全；再多就该往上加了。超出的从最旧的开始丢，
 * 并且这件事在界面上明说，不偷偷丢。
 */
const TALK_KEEP = 40;

function talks() {
  if (!Array.isArray(state.talks)) state.talks = [];
  return state.talks;
}

/** 场景的「对方」人称。ta() 只认当前会话，从历史里重看时当前会话是空的，
 *  所以这里允许显式传一个场景对象——不传就还是老行为。 */
function taOf(sc) { return (sc && sc.ta) || '她'; }

function trimText(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从一局会话里取出要长期保存的东西。**故意只挑字段**：
 *  直接把 sess 塞进去会带上 history（给模型的完整消息）等重复内容，
 *  体积翻倍而没有任何用处。 */
function talkRecordFromSess(sess, debrief, done) {
  const sc = sess.sc || {};
  const log = (sess.log || []).map((o) => ({
    userText: trimText(o.userText, 600),
    reply: trimText(o.reply, 600),
    tone: trimText(o.tone, 20),
    inner: trimText(o.inner, 600),
    signal: trimText(o.signal, 200),
    rating: o.rating || '平',
    rating_why: trimText(o.rating_why, 400),
    temp: o.temp,
  }));
  const goods = log.filter((x) => x.rating === '妙' || x.rating === '好').length;
  return {
    id: sess.sid,
    at: Date.now(),
    /* done = 这一局点过「结束」。
       用户的原话：「历史记录并不是结束之后才保存，而是只要有过一轮对话，
       即便中途没结束，也可以继续续上。」所以每聊完一轮就落一次盘（done=false），
       点过结束才置 true。没结束的那些在列表上标「没聊完」，点一下能接着聊。 */
    done: !!done,
    // 记录里也留一份场景（而不是只留 id）：现造的场景只存在这一局里，
    // 只存 id 的话，历史详情页会显示不出标题、也没法重新生成分析。
    sc: {
      id: sc.id, title: trimText(sc.title, 80), ta: sc.ta,
      her: trimText(sc.her, 200), her_state: trimText(sc.her_state, 300),
      goal: trimText(sc.goal, 200), trap: trimText(sc.trap, 300),
      opening: trimText(sc.opening, 400),
      difficulty: sc.difficulty, stage: trimText(sc.stage, 20),
    },
    gen: /^gen-/.test(String(sc.id || '')),
    turn: sess.turn || 0,
    temp: sess.temp,
    asked: sess.asked || 0,
    followUps: sess.followUps || 0,
    goods,
    bads: log.filter((x) => x.rating === '失误' || x.rating === '漏着').length,
    log,
    debrief: debrief || null,
  };
}

/** 存一局。按 id 覆盖：分析可以反复重生成、中途每轮也在存，
 *  那都不该在历史里堆出好几条。 */
function storeTalkRecord(sess, debrief, done) {
  if (!sess || !sess.sid) return null;
  if (!sess.log || !sess.log.length) return null;   // 一句都没聊的，不占地方
  const rec = talkRecordFromSess(sess, debrief, done);
  const list = talks();
  const i = list.findIndex((t) => t && t.id === sess.sid);
  if (i >= 0) {
    // 创建时间保留最早那一次，另外记一个"最后动过"的时间
    rec.at = list[i].at || rec.at;
    rec.updatedAt = Date.now();
    // 只有逐轮内容没变时才能沿用分析；续聊后旧分析不再覆盖整局。
    if (!rec.debrief && list[i].debrief && JSON.stringify(list[i].log) === JSON.stringify(rec.log)) {
      rec.debrief = list[i].debrief;
    }
    list[i] = rec;
  } else {
    rec.updatedAt = rec.at;
    list.unshift(rec);
  }
  if (list.length > TALK_KEEP) list.length = TALK_KEEP;
  save();
  return rec;
}

function fmtTalkTime(ts) {
  const d = new Date(ts || 0);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 从历史里把一局接着聊下去。
 *
 * 为什么这能成立：逐轮记录（他说了什么、她回了什么、语气、内心、打分、温度）
 * 都存下来了，而给模型的上下文就是这些内容的线性组合，所以能原样重建——
 * 不需要把对话"重放"给模型听，也不需要在后台维持一个会话进程。
 * 这里刻意**不重放、不重新调模型**：接着聊的第一句就是新的一句，不花钱。
 *
 * 三条必须一起做的：
 *   · sc 要还原（她的开场白、内心、人称都在里面，缺了界面上就会显示成空）；
 *   · history 要按原来的形状重建（第一条是那句「对话开始」的元消息，
 *     和 startSession 里推的一致，否则模型的上下文和当时不一样）；
 *   · sid 要用原来那条记录的 id，这样接着聊的内容会**写回同一局**，
 *     而不是在历史里另开一条。 */
function rebuildTalkHistory(t) {
  const sc = t.sc || {};
  const hist = [
    { role: 'user', content: '（对话开始，你刚说完第一句话）' },
    { role: 'assistant', content: sc.opening || '' },
  ];
  (t.log || []).forEach((o) => {
    if (o.userText) hist.push({ role: 'user', content: o.userText });
    hist.push({ role: 'assistant', content: o.reply });
  });
  return hist;
}

function resumeTalk(id) {
  dropSheets();
  const t = talks().find((x) => x && x.id === id);
  if (!t) { renderTalkHistory(); return; }
  if (t.done) { toast('这一局已经结束了，用「再来一局」重开一局'); return; }
  if (!t.log || !t.log.length) { toast('这一局没聊过，重开一局吧'); return; }
  V.historyAnalysisRequests.delete(id);
  invalidateSessionWork();
  const sc = Object.assign({}, t.sc, {
    // 人称和难度这两个字段要带回会话里：界面文案靠 ta，随机/轮换靠 difficulty
    ta: (t.sc && t.sc.ta) || '她',
  });
  V.sess = {
    sc, sid: t.id, turn: t.turn || t.log.length,
    temp: typeof t.temp === 'number' ? t.temp : 50,
    history: rebuildTalkHistory(t),
    log: (t.log || []).map((o) => ({
      userText: o.userText, reply: o.reply, tone: o.tone, inner: o.inner,
      signal: o.signal, rating: o.rating, rating_why: o.rating_why, temp: o.temp,
    })),
    lastTone: (t.log[t.log.length - 1] || {}).tone || null,
    asked: t.asked || 0,
    followUps: t.followUps || 0,
  };
  V.ended = false;
  V.lastDebrief = null;      // 接着聊，之前那份分析作废，结束时重新生成
  renderPractice();
  toast('接着聊。前面聊过的在上边。');
}

/** 历史页的「返回」该回哪儿：正在聊的一局就回对话，否则回选场景页。
 *  这条是必须的——从对话中途点进历史，再返回时如果落到选场景页，
 *  他会以为「刚才那局没了」（V.sess 其实还在，但屏幕上看着就是没了）。 */
function backFromHistory() {
  dropSheets();
  if (V.sess && !V.ended) renderPractice();
  else renderTalkSetup();
}

/* 历史列表。删除做**两步确认**（点删除 → 这一行变成"确定 / 取消"），
   而不是 window.confirm：确认框在 WebView 里是模态的、样式也没法控制，
   而这里删掉就真没了（记录只在本地和备份里各一份）。 */
function openTalkHistory() {
  dropSheets();      // 历史是一个整页，浮层不拆的话它会被盖在下面（看着像点了没反应）
  closeTalkHint();
  renderTalkHistory();
}

function renderTalkHistory() {
  const list = talks();
  const live = list.filter((t) => t && !t.done).length;
  $('#view').innerHTML = `
    <div class="card">
      <div class="his-head">
        <h2>对话历史</h2>
        <button class="ghost" onclick="backFromHistory()">返回</button>
      </div>
      <p class="hint" style="margin-top:8px">
        每聊完一轮就会自动存一次，所以<b>没聊完的也在</b>——点「接着聊」能接着说。
        点过「结束」的会有那一局的分析和建议。存在本机，也会跟着备份写进那个 json 文件里。
        ${list.length ? `现在存了 ${list.length} 局${live ? `（其中 ${live} 局没聊完）` : ''}，最多留最近 ${TALK_KEEP} 局（超出的丢最旧的）。` : ''}
      </p>
      ${list.length === 0 ? `<p class="hint" style="margin-top:12px">
        还没有记录。去上面开一局，说上一轮就会出现在这里。
      </p>` : `
      <div class="his-list">
        ${list.map((t) => `
          <div class="his-item" id="his-${esc(t.id)}">
            <div class="his-row">
              <button class="his-main" onclick="renderTalkRecord('${esc(t.id)}')">
                <b>${esc(t.sc && t.sc.title || '（没有标题）')}</b>
                <span class="his-meta">${esc(fmtTalkTime(t.at))} · ${talkRounds(t)} 轮 ·
                  接住 ${t.goods}／没接住 ${t.bads} · 温度 ${t.temp}</span>
                <span class="his-tag ${t.done ? '' : 'his-live'}">${
                  t.done
                    ? (t.debrief ? '已结束 · 有分析' : '已结束 · 还没生成分析')
                    : '没聊完 · 可以接着聊'}</span>
              </button>
              <button class="his-del" id="del-${esc(t.id)}"
                onclick="askDeleteTalk('${esc(t.id)}')">删除</button>
            </div>
            ${t.done ? '' : `<button class="his-go" onclick="resumeTalk('${esc(t.id)}')">
              接着聊这一局（已经聊了 ${talkRounds(t)} 轮）</button>`}
          </div>`).join('')}
      </div>
      <div class="row row-2" style="margin-top:12px">
        <button class="ghost" id="clearTalks" onclick="askClearTalks()">清空全部</button>
      </div>`}
    </div>`;
  window.scrollTo({ top: 0 });
}

/** 第一步：把那一行换成「确定 / 取消」。 */
function askDeleteTalk(id) {
  const row = document.getElementById('his-' + id);
  if (!row) return;
  row.innerHTML = `
    <div class="his-confirm">
      <span>删掉这一局？（本地和备份里都会没有）</span>
      <div class="row row-2" style="margin:0">
        <button class="ghost" onclick="deleteTalk('${esc(id)}')">确定删除</button>
        <button class="plain" onclick="renderTalkHistory()">取消</button>
      </div>
    </div>`;
}

function deleteTalk(id) {
  const list = talks();
  const i = list.findIndex((t) => t && t.id === id);
  if (i >= 0) list.splice(i, 1);
  save();
  toast('删掉了');
  renderTalkHistory();
}

function askClearTalks() {
  const btn = document.getElementById('clearTalks');
  if (!btn) return;
  btn.outerHTML = `<div class="his-confirm">
    <span>清空全部 ${talks().length} 局？这个不能撤销。</span>
    <div class="row row-2" style="margin:0">
      <button class="ghost" onclick="clearTalks()">确定清空</button>
      <button class="plain" onclick="renderTalkHistory()">取消</button>
    </div></div>`;
}

function clearTalks() {
  state.talks = [];
  save();
  toast('历史记录清空了');
  renderTalkHistory();
}

/** 一局的详情：那一局的分析 + 原话逐轮。 */
function renderTalkRecord(id) {
  dropSheets();
  const t = talks().find((x) => x && x.id === id);
  if (!t) { renderTalkHistory(); return; }
  const sc = t.sc || {};
  const name = taOf(sc);
  $('#view').innerHTML = `
    <div class="card">
      <div class="his-head">
        <h2>${esc(sc.title || '（没有标题）')}</h2>
        <button class="ghost" onclick="renderTalkHistory()">返回列表</button>
      </div>
      <p class="hint" style="margin-top:8px">${esc(fmtTalkTime(t.at))}
        ${t.gen ? ' · 自己出的题' : ' · 现成场景'} · 聊了 ${talkRounds(t)} 轮
        ${t.done ? '' : ' · <b>没聊完</b>'}</p>
      <div class="score-row">
        <div><b>${t.goods}</b><span>接住了</span></div>
        <div><b>${t.bads}</b><span>没接住</span></div>
        <div><b>${t.temp}</b><span>${esc(name)}的温度</span></div>
      </div>
      ${t.done ? '' : `<div class="row row-1" style="margin-top:12px">
        <button class="primary" onclick="resumeTalk('${esc(t.id)}')">接着聊这一局</button>
      </div>`}
    </div>

    <div class="card">
      <h3>这一局的分析和建议</h3>
      <div id="debriefBody" class="hint" style="margin-top:8px">${
        t.debrief ? renderDebrief(t.debrief)
          : (t.done
            ? '这一局结束的时候没能生成分析（多半是当时没网、没填密钥，或者模型抽风）。'
            : '这一局还没结束，所以还没有整段的分析和建议。'
              + '你可以点上面的「接着聊」把它聊完，也可以就当现在这一段生成一份。')}</div>
      ${t.debrief ? '' : `<div class="row row-2" style="margin-top:10px">
        <button class="ghost" onclick="reanalyzeTalk('${esc(t.id)}')">就现在这段生成分析</button>
      </div>`}
    </div>

    <div class="card">
      <h3>当时对方的开场</h3>
      <div class="her-line" style="margin-top:8px">「${esc(sc.opening || '')}」</div>
      ${sc.goal ? `<div class="hint" style="margin-top:8px">你当时的目标：${esc(sc.goal)}</div>` : ''}
    </div>

    <div class="card">
      <h3>逐轮记录</h3>
      ${(t.log || []).length === 0 ? '<p class="hint">这一局没聊几句。</p>'
        : (t.log || []).map((o, i) => `
        <div class="round">
          <div class="round-h"><span class="rate ${(RATING_STYLE[o.rating] || {}).cls}">${esc(o.rating || '平')}</span>
            <span class="hint">第 ${i + 1} 轮 · 温度 ${o.temp}</span></div>
          ${o.userText ? `<div class="hint">你说：「${esc(o.userText)}」</div>` : ''}
          <div class="her-line">「${esc(o.reply)}」</div>
          <div class="hint">${rich(o.rating_why || '')}</div>
        </div>`).join('')}
    </div>

    <div class="row row-2">
      <button class="ghost" onclick="renderTalkHistory()">返回列表</button>
      ${t.done ? '' : `<button class="ghost" onclick="resumeTalk('${esc(t.id)}')">接着聊</button>`}
      <button class="ghost" onclick="askDeleteTalk('${esc(t.id)}');window.scrollTo({top:0})">删掉这一局</button>
    </div>`;
  window.scrollTo({ top: 0 });
}

/** 给一条老记录补生成分析。走的是和当时同一套 makeDebrief，
 *  所以它读的也是他自己的原话，不是另一套更客气的说法。 */
async function reanalyzeTalk(id) {
  const t = talks().find((x) => x && x.id === id);
  const box = document.getElementById('debriefBody');
  if (!t || !box) return;
  if (!t.log || !t.log.length) { box.textContent = '这一局没有对话内容，生成不了。'; return; }
  const request = {};
  box.debriefRequest = request;
  V.historyAnalysisRequests.set(id, request);
  // 续聊保存会替换记录对象；旧分析不能覆盖新增轮次后的记录。
  const current = () => talks().find((x) => x && x.id === id) === t
    && box.debriefRequest === request && V.historyAnalysisRequests.get(id) === request;
  box.innerHTML = '正在按当时说过的话生成分析…（一次模型调用）';
  try {
    const d = await makeDebrief(t, current);
    if (!current()) return;
    const i = talks().findIndex((x) => x && x.id === id);
    if (i >= 0) talks()[i].debrief = d;
    save();
    if (document.getElementById('debriefBody') !== box) return;
    box.innerHTML = renderDebrief(d);
    toast('分析存进这一条记录了');
  } catch (e) {
    if (!current() || document.getElementById('debriefBody') !== box) return;
    box.innerHTML = `<b>还是没生成出来：</b>${esc(e.message || String(e))}
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="reanalyzeTalk('${esc(id)}')">再试一次</button>
      </div>`;
  }
}

/** 结束页和选场景页上那个小图标旁边的数字。 */
function talkCountLabel() {
  const n = talks().length;
  return n ? `历史 ${n}` : '历史';
}

/* ---------------------------------------------------------------- 设置
 *
 * 用户的原话：「可以把部分的功能全部归在一个设置里面，然后就跟大部分软件一样。」
 *
 * 之前设置是**一个长条**：AI 配置、音色、语速、识别全堆在一起，而「每日计划」
 * 「闸门挑应用」「备份」各自还有独立入口散在别的页面。现在收成一个设置页，
 * 左边六个分区。
 *
 * 一个刻意的做法：每日计划 / 闸门 / 数据这三块的**内容没有搬进来**，
 * 而是从设置里点开它们原来的面板。理由是那些面板已经能用、也有测试盯着，
 * 为了"看起来像设置页"把它们拆开重写，是把风险换成整洁——不划算。
 * 设置页在这里的职责是**唯一入口**，不是把所有东西都复述一遍。
 */
const SET_SECTIONS = [
  ['sound', '声音'], ['ai', 'AI 陪练'], ['daily', '计划与提醒'],
  ['gate', '闸门'], ['data', '数据'], ['update', '内容更新'], ['about', '关于'],
];
let setSection = 'sound';

function openSettings(section) {
  if (section) setSection = section;
  if (!SET_SECTIONS.some(([k]) => k === setSection)) setSection = 'sound';
  /* 用 sheetHost() 而不是自己新建一个浮层：从「每日计划」返回设置时，写的是
     **同一个浮层**（见 app.js 里 sheetHost/sheetPanel 那段说明）。
     分区导航也从"两列六格大按钮"改成一行可以横向滑的小胶囊——
     那个大格子占掉了浮层顶部三分之一，而里面往往只有两三行内容；
     一行胶囊和 App 里其它的二级导航（practice/ai/growth）是同一个视觉家族，
     用户不用再学一套新的。资料里对设置页的通行建议也是：导航要能一眼扫完，
     内容才是主角（"task-first"）。 */
  const inner = sheetHost();
  sheetPanel = 'settings';
  inner.innerHTML = `
    <button class="ghost" style="float:right" onclick="closeSheet()">关闭</button>
    <h2 style="margin:10px 0 14px">设置</h2>
    <div class="chips set-nav">
      ${SET_SECTIONS.map(([k, label]) => `<button class="chip-btn ${setSection === k ? 'on' : ''}"
        onclick="setSettingSection('${k}')">${label}</button>`).join('')}
    </div>
    <div id="setBody">${setSectionHtml()}</div>
    <div id="setOut" class="hint" style="margin-top:12px;white-space:pre-line"></div>`;
  setSectionMounted();
}

function setSettingSection(k) {
  setSection = k;
  const body = document.getElementById('setBody');
  if (!body) return openSettings(k);
  body.innerHTML = setSectionHtml();
  document.querySelectorAll('.set-nav button').forEach((b) => {
    b.classList.toggle('on', b.textContent.trim() === (SET_SECTIONS.find(([x]) => x === k) || [])[1]);
  });
  const out = document.getElementById('setOut');
  if (out) out.textContent = '';
  setSectionMounted();
}

/** 每个分区挂载之后要做的事（读音色列表、预览地址、刷新提示文案…）。 */
function setSectionMounted() {
  const out = document.getElementById('setOut');
  if (out) out.textContent = '';
  if (setSection === 'ai') { previewEndpoint(); modelHint(); }
  if (setSection === 'sound') { loadVoices(); showCurrentVoice(); renderAudioNow(); }
  if (setSection === 'update') { renderUpdateStatus(); }
}

function setSectionHtml() {
  const s = settings();
  if (setSection === 'sound') return soundSectionHtml(s);
  if (setSection === 'ai') return aiSectionHtml(s);
  if (setSection === 'daily') return `
    <div class="set-h">计划与提醒</div>
    <p class="set-note">每天几张卡片、几条微课算达标，以及提醒的时间，都在这里面。
    量刻意设得小——它是"每天都做一点"，不是"每天做很多"。</p>
    <div class="row"><button class="primary" onclick="openDailySettings()">打开每日计划设置</button></div>
    <p class="set-note" style="margin-top:12px">当前：
      ${state.dailyCfg ? `每天 ${state.dailyCfg.cards || 4} 张卡片 + ${state.dailyCfg.lessons || 1} 条微课` : '默认每天 4 张卡片 + 1 条微课'}
      ；提醒 ${(state.reminder && state.reminder.enabled !== false)
        ? `已开（${String((state.reminder || {}).hour ?? 20).padStart(2, '0')}:${String((state.reminder || {}).minute ?? 0).padStart(2, '0')}）`
        : '已关'}。
    </p>`;
  if (setSection === 'gate') return `
    <div class="set-h">闸门</div>
    <p class="set-note">没达标的时候拦一下你选的那几个应用。这是这份东西里唯一"防着你自己"的部分，
    所以它里面写的出口必须永远是真的——卸载就没了，不留任何系统级的东西。</p>
    <div class="row"><button class="primary" onclick="closeSheet();openAppPicker()">挑要拦的应用</button></div>
    <p class="set-note" style="margin-top:12px">当前拦了
      ${((state.gate || {}).packages || []).length} 个应用；
      闸门本身${(state.gate || {}).enabled ? '已开' : '未开'}。
    </p>`;
  if (setSection === 'update') return `
    <div class="set-h">在线内容更新</div>
    <p class="set-note">只更新题库、微课和五维题的 JSON。下载前会检查 HTTPS、版本和内容结构；失败会保留当前离线内容。</p>
    <label class="field"><span>更新清单地址（可选）</span><input id="updateUrl" type="url" value="${esc(settings().contentUpdateUrl || '')}" placeholder="https://你的域名/update-manifest.json"></label>
    <div class="row"><button class="primary" onclick="checkContentUpdate()">检查更新</button><button class="ghost" onclick="saveContentUpdateUrl()">保存地址</button></div>
    <p class="set-note" id="updateStatus">尚未检查。</p><div id="apkUpdate" class="row"></div>`;
  if (setSection === 'data') return `
    <div class="set-h">数据</div>
    <p class="set-note">进度存在这台手机上，同时会自动写一份纯文本备份到「下载」目录——
    卸载不会删掉外部存储，所以重装回来还能捞回去。备份只有文本，没有脚本、没有别的文件。</p>
    <div class="row" style="flex-direction:column;gap:8px">
      <button class="ghost" onclick="backupNowClick()">现在备份一次</button>
      <button class="ghost" onclick="restoreBackup()">从备份恢复</button>
      <button class="ghost" onclick="closeSheet();openFog('回顾')">看脑雾记录</button>
    </div>
    <p class="set-note" style="margin-top:12px">${backupStatusText()}</p>`;
  if (setSection === 'about') return `
    <div class="set-h">关于</div>
    <p class="set-note">版本 2.47（versionCode 49）· 离线可用 · 权限 6 个
    （网络、通知、开机自启、悬浮窗，加两个只对 Android 8 及以下生效的存储权限）。
    <b>没有录音权限</b>：这一版起 App 不录音了，你打字，她出声。安装包约 0.5 MB。</p>
    <p class="set-note">密钥只存在这台手机的本地存储里，不会上传到任何地方，
    也不会写进这个 App 的安装包。卸载之后，这个 App 不留任何系统级的设置。</p>
    <p class="set-note">AI 现造的场景、对话历史都只存在本机，也会跟着那个备份 json 走，
    所以卸载重装能捞回来。它们不写进安装包——安装包里只有 14 个我逐个写过的场景。</p>
    <div class="row" style="flex-direction:column;gap:8px">
      <button class="ghost" onclick="closeSheet();showBoundary()">这个工具的天花板</button>
      <button class="ghost" onclick="closeSheet();go('growth')">看我的进度</button>
    </div>
    <p class="set-note" style="margin-top:12px">
      这个 App 帮你练判断，但它测不到最难的那几件事——那些只能由跟你在一起的人来打分。
      「这个工具的天花板」那一段值得看一遍。
    </p>`;
  return '';
}

function backupStatusText() {
  const b = state.backup || {};
  if (!b.at) return '还没备份过。';
  const t = new Date(b.at);
  const when = `${t.getMonth() + 1} 月 ${t.getDate()} 日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return b.ok ? `上次备份：${when}，写在 ${b.where || '下载目录'}。`
    : `上次备份没写成（${when}）。${b.where ? '' : '多半是没给存储权限——点「现在备份一次」会再问一次。'}`;
}

function aiSectionHtml(s) {
  return `
    <div class="set-h">AI 陪练</div>
    <label class="field"><span>API 密钥（只存在这台手机里，不会上传到任何地方）</span>
      <input type="text" id="setKey" placeholder="sk-..." value="${esc(s.apiKey)}"></label>
    <div class="field"><span>模型</span>
      <div class="chips" style="margin-bottom:8px">
        ${MODEL_CHOICES.map((m) => `<button class="chip-btn ${s.model === m.id ? 'on' : ''}"
          onclick="chooseModel('${m.id}')">${esc(m.name)}</button>`).join('')}
      </div>
      <input type="text" id="setModel" value="${esc(s.model)}" oninput="modelHint()">
      <p class="hint" id="modelHint" style="margin:6px 0 0"></p>
    </div>
    ${modelSwitchedNotice()}
    <label class="field"><span>接口地址</span>
      <input type="text" id="setUrl" value="${esc(s.baseUrl)}" oninput="previewEndpoint()"></label>
    <p class="hint" id="urlHint" style="margin:-4px 0 12px"></p>
    ${urlFallbackNotice()}
    <p class="hint" style="margin-bottom:12px">
      密钥在哪拿：登录 platform.deepseek.com → API keys → 新建。填一次就行。
      不填也能用，只是 AI 陪练和另外两个 AI 模块用不了。
    </p>
    <p class="hint" style="margin-bottom:12px">
      接口地址要填<b>完整端点</b>，也就是到 <span class="mono-line">/chat/completions</span> 为止。
      只填域名、或者填成 <span class="mono-line">/anthropic</span> 那种基础地址，都会得到 404。
    </p>
    <div class="row" style="flex-direction:column;gap:8px">
      <button class="primary" onclick="saveSettingsFromUI()">保存</button>
      <button class="ghost" onclick="testLlm()">测一下能不能连上模型</button>
    </div>`;
}

function soundSectionHtml(s) {
  const cfg = CONTENT.audio || {};
  const cur = allTracks().find((t) => t.id === (s.audioTrack || cfg.default_track))
    || audioTrack(cfg.default_track);
  const ev = cfg.evidence || {};
  /* 证据说明默认**折起来**。理由是舒服：这一段一千多字，摊开之后会把
     「音轨」「音量」「每次问不问」全挤到下面，而那几个才是天天要碰的。
     折起来之后上面一眼就是能操作的东西，想看依据再点开。

     折起来不等于藏起来：<details> 里的文字仍然进 textContent，所以
     check_audio 那几条「证据文字必须在」的断言依然有效——这是刻意的，
     这段说明是安全相关的，不能靠折叠把它变成不存在。

     两条踩过的坑，都留在这里免得再犯：
     · 这段文字以前是写在模板字符串**里面**的块注释。模板字符串里的注释
       不是注释，它会被原样渲染成页面上的字——我的实现说明曾经显示给用户看。
       所以注释一律放在 return 之前，别放在反引号里。
     · 反引号也不能出现在模板字符串的注释文字里：它会把字符串当场截断，
       于是标签从文字变成表达式。语法检查照样通过（那是合法的 JS），
       只在运行时抛 "details is not defined"。语法过了不等于跑得起来。 */
  return `
    <div class="set-h">背景声</div>
    <p class="set-note">
      你说过容易紧张、容易焦虑，所以这里放了几段能一直响下去的声音。
      合成的那几条是这台手机<b>现场算出来的</b>，不联网、也几乎不占体积；
      想听自己的歌，用下面「我自己的音乐」从手机里挑一个文件。
    </p>
    <div class="row row-2">
      <button class="${AUDIO.playing ? 'ghost' : 'primary'}" onclick="audioToggle();setSettingSection('sound')">
        ${AUDIO.playing ? '关掉背景声' : '放起来'}</button>
      <button class="ghost" onclick="previewVoice()">试听一下音色</button>
    </div>
    <p class="hint" id="audioNow" style="margin:10px 0 14px"></p>
    <label class="field"><span>音量 <input type="range" id="setVol" min="0" max="0.6" step="0.01"
      value="${Number(s.audioVolume)}" oninput="setAudioVolume(this.value)"></span></label>
    <p class="hint" style="margin:-4px 0 14px">
      上限只到 0.6。背景声的任务是"有个底"，不是盖过她说话——她开口的时候它会自动再压低。
    </p>

    <div class="field"><span>音轨（点一下直接换）</span>
      <div id="trackList" class="track-list">
        ${allTracks().map((t) => `
          <button class="track-item ${cur && t.id === cur.id ? 'on' : ''}" onclick="chooseTrack('${t.id}')">
            <span class="track-name">${esc(t.name)}</span>
            <span class="track-mark">${cur && t.id === cur.id ? (AUDIO.playing ? '正在放' : '已选') : ''}</span>
            <span class="track-desc">${esc(t.desc)}</span>
            ${t.headphone ? '<span class="track-flag">要戴耳机才成立</span>' : ''}
          </button>`).join('')}
      </div>
    </div>

    <div class="set-h" style="margin-top:22px">我自己的音乐</div>
    <div id="musicBox">${musicBoxHtml()}</div>

    <label class="field" style="margin-top:14px"><span>每次进来都问我</span>
      <div class="chips">
        <button class="chip-btn ${s.audioAsk ? 'on' : ''}" onclick="setAudioAsk(true);setSettingSection('sound')">问</button>
        <button class="chip-btn ${s.audioAsk ? '' : 'on'}" onclick="setAudioAsk(false);setSettingSection('sound')">别问</button>
      </div>
    </label>

    <details class="set-details">
      <summary>这些声音到底有没有用（点开看依据）</summary>      <div class="block" style="margin-top:12px">
        <div class="set-note" style="margin:0">
          <b>${esc(ev.headline || '')}</b><br>
          ${rich(ev.sound || '')}
        </div>
      </div>
      <div class="block">
        <div class="label">双耳节拍那部分，为什么说得这么保守</div>
        <div class="set-note" style="margin:0">${rich(ev.binaural || '')}<br>${rich(ev.confound || '')}</div>
      </div>
      <div class="block">
        <div class="label">怎么用</div>
        <div class="set-note" style="margin:0">${rich(ev.practical || '')}</div>
      </div>
      <div class="warnbox" style="margin-top:12px">${rich(ev.safe || '')}</div>
    </details>

    ${musicCopyrightNote()}

    <div class="set-h" style="margin-top:22px">她说话的声音</div>
    ${V.native ? `<div class="field"><span>音色</span>
      <div id="voiceBox" class="voice-box"><p class="hint">正在读取这台手机上的中文音色…</p></div>
      <div class="row row-2">
        <button class="ghost" onclick="loadVoices(true)">重新读取</button>
        <button class="ghost" onclick="downloadVoices()">去系统里下载音色</button>
      </div>
      <div class="row row-2">
        <button class="ghost" onclick="openSystemTts()">打开系统语音设置</button>
      </div>
      <p class="hint" id="voiceNow" style="margin:8px 0 0"></p>
      <p class="hint" style="margin:8px 0 0">
        音色来自这台手机自己的语音合成引擎（不同手机差别很大，有的带好几个音色）。
        「像不像真人」几乎全靠它，所以都值得试听一遍再定。
      </p>
    </div>` : '<p class="set-note">音色只在 Android App 里能选。</p>'}
    <label class="field"><span>语速 <input type="range" id="setRate" min="0.7" max="1.4" step="0.05" value="${s.rate}"></span></label>
    <label class="field"><span>音调 <input type="range" id="setPitch" min="0.7" max="1.4" step="0.05" value="${s.pitch}"></span></label>
    <div class="row" style="margin-top:12px">
      <button class="primary" onclick="saveSettingsFromUI()">保存</button>
    </div>`;
}

function setAudioVolume(v) {
  saveSettings({ audioVolume: Math.max(0, Math.min(0.6, Number(v) || 0)) });
  if (AUDIO.playing) audioApplyGain(0.25);
  // 自己那条音乐是原生在放的，音量也得转过去，否则这个滑块对它不起作用
  if (musicSupported()) {
    try { V.native.musicSetVolume(Number(settings().audioVolume) || 0.22); } catch (e) { }
  }
}

/* 设置页里「我自己的音乐」那一块。三种状态都如实说：
   · 在电脑上打开（没有原生桥）→ 这条路根本不存在，不要给一个点了没用的按钮
   · 装到手机上、还没选 → 给「从手机里挑一个」
   · 选过了 → 文件名 + 放/停 + 忘掉
   最后那件事要说清楚：「忘掉」只是取消 App 的访问权，**不会删他手机里的音乐**。 */
function musicBoxHtml() {
  if (!musicSupported()) {
    return `<p class="set-note" style="margin:0">
      这一条要装到手机上才有：浏览器里读不到你手机里的文件。
      上面那些合成音轨在电脑上也能放。</p>`;
  }
  const m = V.music || {};
  if (!m.has) {
    return `<p class="set-note" style="margin:0 0 10px">
      想听自己的音乐，就从手机里挑一个文件。选过之后它会作为一条音轨出现在上面，
      和那些合成的声音一样能一直循环放着。</p>
      <div class="row row-2">
        <button class="primary" onclick="pickMyMusic()">从手机里挑一个</button>
      </div>`;
  }
  return `<p class="set-note" style="margin:0 0 10px">
    现在选的是：<b>${esc(m.name || '（没有名字）')}</b>
    ${m.persist ? '' : '<br><span style="color:var(--warn)">这个文件只拿到了「这一次」的授权，重启 App 之后可能要重选一遍。</span>'}
    </p>
    <div class="row row-2" style="gap:8px">
      <button class="${m.playing ? 'ghost' : 'primary'}" onclick="toggleMyMusic()">
        ${m.playing ? '停下' : '放这个'}</button>
      <button class="ghost" onclick="pickMyMusic()">换一个</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="plain" onclick="forgetMyMusic()">忘掉这个文件</button>
    </div>
    <p class="hint" style="margin:8px 0 0">
      「忘掉」只是取消 App 对这个文件的访问权，<b>不会删你手机里的音乐</b>。
      把这个 App 卸载掉也是同样的效果——它自己不留任何一份拷贝。
    </p>`;
}

function pickMyMusic() {
  if (!musicSupported()) return;
  try { V.native.musicPick(); } catch (e) { toast('打不开文件选择器'); }
}

function toggleMyMusic() {
  if (!musicSupported()) return;
  if ((V.music || {}).playing) { try { V.native.musicStop(); } catch (e) { } }
  else musicStart();
}

function forgetMyMusic() {
  if (!musicSupported()) return;
  try { V.native.musicForget(); } catch (e) { }
}

/* 关于「为什么不内置几首歌」，App 里也要有说法——不能只是"没做"。
   用户说过自用、不商用，版权上可以放松。那个判断管的是**他自己听**这件事；
   而"内置"是另一件事：等于把别人的唱片打进这个 App，而每一首的来源我并不知道，
   它还会变成他手机里清理不掉的残留——正好撞上他自己定的「卸载必须干净」。
   所以我不替他下这个决定，而是给出两条他随时能走的路（见下面那段）。 */
function musicCopyrightNote() {
  return `<details class="set-details">
    <summary>为什么这里没有内置几首歌（点开看我的理由）</summary>
    <div class="block" style="margin-top:12px">
      <div class="set-note" style="margin:0">
        你说过是自己用、不商用，版权上可以放松——这个判断我照做，但它管的是
        <b>你自己听</b>这件事。<b>内置</b>是另一件事：那等于把别人的唱片打进这个 App，
        而每一首的来源我并不知道；它还会变成你手机里一块清理不掉的残留，
        正好撞上你定的那条底线（卸载必须干净）。所以我没有替你下这个决定，
        而是做了上面那条路——放你自己手机里的音乐，选一次就记住，卸载不留痕迹。
        <br><br>
        你要是确实想让它内置，站得住的只有两种做法：一是你自己买的音乐文件，
        放进手机用上面那条路选它；二是从<b>明确允许免费使用与再分发</b>的曲库里拿
        （比如 CC0／公有领域的录音），把文件给我，我可以打进 APK 当默认音轨。
        这两条我都能做，缺的只是那个文件本身。
      </div>
    </div>
  </details>`;
}

function chooseTrack(id) {
  const t = allTracks().find((x) => x.id === id);
  if (!t) return;
  if (id === MY_TRACK) {
    if (!(V.music || {}).has) { pickMyMusic(); return; }
    saveSettings({ audioTrack: id });
    musicStart();
    setSettingSection('sound');
    toast('换成「' + t.name + '」');
    return;
  }
  saveSettings({ audioTrack: id });
  if (AUDIO.track === MY_TRACK) musicStop();     // 从自己的音乐切回合成音轨
  if (AUDIO.playing) audioStart(id);
  // 重画整段就够了：列表上的勾和「正在放」会跟着状态走。
  // （原来这里还else调了个 renderTrackList，而那个函数是把列表元素删掉——
  //   一旦没在播放，点一下就再也看不到列表了。多余的刷新函数不如没有。）
  setSettingSection('sound');
  toast('换成「' + t.name + '」' + (t.headphone && !AUDIO.playing ? '（这条要戴耳机）' : ''));
}

function renderAudioNow() {
  const el = document.getElementById('audioNow');
  if (!el) return;
  const s = settings();
  const cur = audioTrack(s.audioTrack || (CONTENT.audio || {}).default_track);
  if (!audioSupported()) { el.textContent = '这台手机的浏览器不支持实时合成音频。'; return; }
  el.textContent = AUDIO.playing
    ? `正在放：${cur ? cur.name : '—'}${cur && cur.headphone ? '（戴耳机才有那个效果）' : ''}`
    : '现在没放。点上面那个按钮就开始。';
}

/** 去系统里下载音色。有的引擎没有这个入口，那就退回系统语音设置。 */
function downloadVoices() {
  if (V.native && V.native.installVoiceData) { V.native.installVoiceData(); return; }
  openSystemTts();
}

/** 打开系统的文字转语音设置。换引擎、管理语音包都在那里——
 *  音色列表为空、或者想要列表里没有的嗓子，这条路是唯一出口。 */
function openSystemTts() {
  if (V.native && V.native.openTtsSettings) { V.native.openTtsSettings(); return; }
  toast('这个功能只在 Android App 里可用');
}

/** 显示**实际生效**的音色。
 *
 * 为什么需要：用户选了音色之后，如果引擎没有这个音色、或者选中的还没下载，
 * 声音会静默退回默认——界面上「已选」打着勾，听起来却是另一个嗓子。
 * 把原生当前真实用的那个名字显示出来，这种不一致就看得见了。
 * 这也是「原生有能力但界面碰不到」那一类问题的解药：让状态可见。 */
function showCurrentVoice() {
  const el = document.getElementById('voiceNow');
  if (!el) return;
  if (!V.native || !V.native.currentVoice) { el.textContent = ''; return; }
  let real = '';
  try { real = V.native.currentVoice() || ''; } catch (e) { real = ''; }
  const want = settings().voice || '';
  if (!real) { el.textContent = '这台手机没有报告正在使用的音色。'; return; }
  if (want && want !== real) {
    el.innerHTML = `<b>注意：设置里选的是 ${esc(want)}，实际生效的是 ${esc(real)}</b>`
      + '——多半是这个音色没下载、或者被引擎忽略了。可以先试听一下确认。';
  } else {
    el.textContent = '当前实际生效的音色：' + real + '（自动 = 系统默认那个）';
  }
}

/* ---------------------------------------------------------- 音色（语音包）
 *
 * 用户问：「他是不是应该会有语音包那种的？发出类似真人的声音。」
 *
 * 在 Android 上这就是系统合成引擎自带的音色列表：Google、讯飞、华为、小米
 * 各不一样，有的引擎一个中文音色都没有、有的有十几个，质量差别很大。
 * 而且很多音色是**可下载的数据包**——装完之后列表里会多出来，那就是「语音包」。
 *
 * 所以这里不做音色包（那等于往安装包里塞几十 MB，质量还不如系统自带的），
 * 而是把系统里的音色列出来、能试听、能引导去下载。
 */
let VOICE_LIST = null;

/* 从音色名里抽一个能区分彼此的短标签。
 *
 * 为什么需要：从截图里发现两行都显示「中文（中国大陆）· 可离线 · 音质高」——
 * 而这**恰恰是一个用来「挑一个」的列表**，两项长得一模一样等于没得挑，
 * 用户只能去看底下那行他不认识的英文。
 * 这几段编号（ccc / fff）在引擎里就是不同的 speaker，确实是两个嗓子。
 *
 * 抽不出来就不加：各引擎命名规则差别很大，硬猜一个错的标签比不加更糟。 */
function voiceTag(name) {
  const parts = String(name || '').toLowerCase().split('-').filter(Boolean);
  if (parts.length < 4) return '';
  const mid = parts[3];
  // 只接受短的、字母数字的段（ccc / fff / a 之类）；长了多半是别的含义
  if (!/^[a-z0-9]{1,5}$/.test(mid)) return '';
  return mid;
}

function voiceLabel(v) {
  // 音色名（zh-cn-x-ccc-local）对用户没有意义，翻成人能判断的东西
  const loc = /CN|Hans/i.test(v.locale || '') ? '中文（中国大陆）'
    : /TW|Hant/i.test(v.locale || '') ? '中文（台湾）'
      : /HK/i.test(v.locale || '') ? '中文（香港）' : (v.locale || '中文');
  const bits = [loc];
  if (v.network) bits.push('需联网');
  else bits.push('可离线');
  if (v.quality >= 500) bits.push('音质很高');
  else if (v.quality >= 400) bits.push('音质高');
  else if (v.quality >= 300) bits.push('音质中');
  // 加可辨识段：否则同参数的音色在界面上完全一样，没法挑
  const tag = voiceTag(v.name);
  if (tag) bits.push(tag);
  return bits.join(' · ');
}

async function loadVoices(force) {
  const box = document.getElementById('voiceBox');
  if (!box) return;
  if (!V.native || !V.native.voices) {
    box.innerHTML = '<p class="hint">这个功能只在 Android App 里可用。</p>';
    return;
  }
  if (!VOICE_LIST || force) {
    box.innerHTML = '<p class="hint">正在读取…</p>';
    try {
      const raw = V.native.voices();
      VOICE_LIST = JSON.parse(raw || '[]');
      if (!Array.isArray(VOICE_LIST)) VOICE_LIST = [];
    } catch (e) {
      VOICE_LIST = [];
    }
  }
  renderVoices();
}

function renderVoices() {
  const box = document.getElementById('voiceBox');
  if (!box) return;
  const cur = settings().voice || '';
  /* 这里**再过滤一次**非中文音色。
   *
   * 原生的 voices() 已经按 locale 滤过一遍了，但显示层不该依赖平台层滤干净：
   * 不同引擎给的 locale 千奇百怪（有的给 zh-Hans-CN，有的给 zh_CN，
   * 个别甚至给空字符串），漏一个就会在「中文音色」列表里出现一个英文嗓子，
   * 而用户选了它只会觉得「怎么冒出个说英文的」。
   * 两道过滤的成本是零，漏网的代价是一次莫名其妙的体验。 */
  const list = (VOICE_LIST || [])
    .filter((v) => /^zh([-_]|$)/i.test(String(v.locale || '')))
    .sort((a, b) => {
    if (!!a.installed !== !!b.installed) return a.installed ? -1 : 1;
    if (!!a.network !== !!b.network) return a.network ? 1 : -1;
    return (b.quality || 0) - (a.quality || 0);
  });
  if (!list.length) {
    box.innerHTML = `<p class="hint">这台手机的语音引擎没有中文音色。
      点下面的「去系统里下载音色」，或者在系统的「文字转语音」设置里换一个引擎
      （Google 语音服务、讯飞语记之类都带中文音色）。</p>`;
    return;
  }
  const rows = [`<button class="voice-item ${cur === '' ? 'on' : ''}" onclick="chooseVoice('')">
      <span class="voice-name">自动（推荐）</span>
      <span class="voice-meta">用系统默认的中文音色</span>
    </button>`];
  list.forEach((v) => {
    const mark = cur === v.name ? '已选' : (v.installed ? '' : '未下载');
    rows.push(`<button class="voice-item ${cur === v.name ? 'on' : ''}"
        onclick="chooseVoice('${esc(v.name)}')">
        <span class="voice-name">${esc(voiceLabel(v))}</span>
        <span class="voice-mark">${esc(mark)}</span>
        <span class="voice-meta">${esc(v.name)}</span>
      </button>`);
  });
  box.innerHTML = `<div class="voice-list">${rows.join('')}</div>
    <div class="row"><button class="ghost" onclick="previewVoice()">试听一下（用当前选的音色）</button></div>`;
}

/** 选音色。点一下立刻存 + 立刻应用，这样「试听」听到的就是刚点的那个。 */
function chooseVoice(name) {
  saveSettings({ voice: name || '' });
  applyVoiceSetting();
  VOICE_LIST = VOICE_LIST || [];
  renderVoices();
  // 切过去是异步的，稍等一下再读「实际生效」，否则读到的还是切换前的值
  setTimeout(showCurrentVoice, 300);
  const v = (VOICE_LIST || []).find((x) => x.name === name);
  if (v && !v.installed) {
    toast('这个音色还没下载，多半发不出声。点「去系统里下载音色」装上再用。');
  }
}

/* 试听。
 *
 * 必须**先把当前选的音色转发过去**再出声：用户点「试听」时可能刚改了选择
 * 但还没点保存，试听要听到的是他刚选的那个，否则这个按钮等于没用。
 * 这里不额外做「试完还原」——因为 chooseVoice 已经把选择存下来了，
 * 试听用的就是正式生效的音色，不存在「试听污染」。
 */
function previewVoice() {
  applyVoiceSetting();
  const st = settings();
  speak('你好，我是今天的练习对象。你现在听到的就是这个音色的声音。');
  setTimeout(() => { try { st; } catch (e) { } }, 0);
}

/** 选模型。点了名字就填进输入框，并把这个模型的实测速度写在下面——
 *  用户唯一需要知道的事就是「这个一轮要等多久」。 */
function chooseModel(id) {
  const el = document.getElementById('setModel');
  if (el) el.value = id;
  document.querySelectorAll('.chips .chip-btn').forEach((b) => {
    b.classList.toggle('on', b.textContent.trim() === id);
  });
  modelHint();
}

function modelHint() {
  const el = document.getElementById('setModel');
  const out = document.getElementById('modelHint');
  if (!out) return;
  const v = (el && el.value || '').trim();
  const hit = MODEL_CHOICES.find((m) => m.id === v);
  if (hit) { out.textContent = hit.note; return; }
  out.textContent = v
    ? '这个名字不在实测列表里。如果一轮要等很久，多半是带推理的模型——换成 '
      + MODEL_FAST + ' 会快很多。'
    : '';
}

function saveSettingsFromUI() {
  const g = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  const norm = normalizeEndpoint(g('setUrl'));
  // 把规范化后的地址**写回输入框**。用户下次打开设置看到的就是真正生效的那个，
  // 而不是他自己填的那个——这两个不一致，是这类配置最难查的一类问题。
  const el = document.getElementById('setUrl');
  if (el) el.value = norm.url;
  saveSettings({
    apiKey: g('setKey'), model: g('setModel') || MODEL_FAST,
    baseUrl: norm.url,
    rate: parseFloat(document.getElementById('setRate').value) || 1,
    pitch: parseFloat(document.getElementById('setPitch').value) || 1,
  });
  applyVoiceSetting();     // 音色可能刚改过，存完立刻生效
  if (norm.bad) toast(norm.bad);
  else if (norm.note) toast('已保存（' + norm.note + '）');
  else toast('已保存');
  previewEndpoint();
}

/* 把「老默认模型被换掉」这件事说明白。
 *
 * 用户手上那台手机存的是 deepseek-v4-pro，一轮要等三十秒。
 * 我们替他换成了快的——**换了就必须说**：不讲的话他下次看设置页会发现
 * 跟自己记忆里不一样（或者更可能：他根本不知道慢是因为模型）。
 * 说清楚原因和数字，他才能自己判断要不要换回去。 */
function modelSwitchedNotice() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(MIGRATED_KEY) || 'null'); } catch (e) { }
  if (!o || !o.from) return '';
  return `<p class="warnbox" style="margin:0 0 12px">
    模型已经从 <span class="mono-line">${esc(o.from)}</span> 换成了
    <span class="mono-line">${esc(MODEL_FAST)}</span>：前者带推理，实测<b>一轮要等约 30 秒</b>，
    拿来做语音对话太慢了（而且推理 token 和正文共用 max_tokens，长一点还会被截断）。
    想要换回去，点下面那个名字就行。
  </p>`;
}

/* 上次用 404 自动回退过的话，在这里说明白。
 * 回退是「让你不被卡住」的兜底，不是「悄悄替你改配置」——改了必须让人知道，
 * 否则他下次看设置页会发现跟自己记忆里不一样，更糊涂。 */
function urlFallbackNotice() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem('eq-url-fallback') || 'null'); } catch (e) { r = null; }
  if (!r || !r.from) return '';
  return `<div class="block diag-read" style="margin-bottom:12px">
    <div class="label">上次自动改过地址</div>
    <div class="diag-why">你填的 <span class="mono-line">${esc(r.from)}</span> 返回了 404
    （那个地址上没有东西），应用自动改用正式端点 <span class="mono-line">${esc(r.to)}</span>，
    所以那一次是成功的。<b>但设置里存着的还是原来那个</b>，建议你点一下下面的保存，
    把它换成上面显示的地址。</div>
  </div>`;
}

/** 边填边显示「实际会发到哪个地址」，把 404 在填的时候就挡掉 */
function previewEndpoint() {
  const el = document.getElementById('setUrl');
  const out = document.getElementById('urlHint');
  if (!el || !out) return;
  const n = normalizeEndpoint(el.value);
  if (n.bad) {
    out.style.color = '#E8C07A';
    out.innerHTML = esc(n.bad);
    return;
  }
  out.style.color = '';
  out.innerHTML = `实际会 POST 到 <span class="mono-line">${esc(n.url)}</span>`
    + (n.note ? `<br>${rich(n.note)}` : '');
}

async function testLlm() {
  const out = document.getElementById('setOut');
  if (out) out.textContent = '正在连…';
  try {
    const t = await llmCall([
      { role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '返回 {"ok":1}' },
    ], 0.2);
    if (out) out.textContent = '连上了：' + JSON.stringify(t).slice(0, 60);
  } catch (e) {
    if (out) out.textContent = '失败：' + e.message;
  }
}

/* ================================================== 聊天截图 → 文字（OCR）
 *
 * 用户的要求：「复盘那一栏加上一个上传聊天截图的功能。一般来说只需要图片识别成
 * 文字就行，不需要真正的识图。」
 *
 * 为什么走模型而不是本机 OCR：
 *   安卓没有内置的文字识别 API。ML Kit 要么依赖 Google 服务、要么得塞原生库，
 *   而这个项目的构建**明确断言 APK 里一个 native 库都没有**（见 build_apk.py
 *   里那段 stray 检查，2.31 撤掉离线识别之后才做到 0.5MB）。
 *   为了 OCR 把几十 MB 的原生库背回来，代价远大于收益。
 *   而 DeepSeek 已经上线了视觉模型，用的还是同一个 key、同一个端点、
 *   同一套 OpenAI 兼容格式——那就用现成的路。
 *
 * 两个容易踩的坑，都在这里处理掉：
 *   1. 长截图会被压糊。官方说图片会自动缩放到「总像素约相当于 800×800」。
 *      聊天的长截图（1080×2400）按这个缩放完，正文只剩 7px 上下，字就糊了。
 *      所以这里**先把长图竖着切成几段**，每段单独作为一张图送进去——
 *      多图请求里每张图的 token 是独立算的（每张上限 384），所以切开不额外贵多少，
 *      但每段的字都保住了清晰度。
 *   2. 静默失败。如果模型不支持图片，接口可能**不报错**，只是把图忽略掉，
 *      然后回一段通顺但跟你的截图毫无关系的话。那种最难查。所以下面把「回的内容
 *      里有没有聊天的痕迹」也验一遍，不像就明说。 */

/* 视觉模型的名字。官方目前是 deepseek-v4-flash-vision-exp（实验性），
   带 Exp 后缀说明它可能改名——所以允许在设置里覆盖，而不是写死。 */
const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
/* 一张图最长的一边缩到多少。1400 是个折中：手机截图的文字在这个尺寸下还很清楚，
   而 base64 之后通常只有一两百 KB，过 JS 桥和上传都不费劲。 */
/* 这三个值**必须和原生那边一致**（MainActivity 里的 SHOT_WIDTH_CAP / SHOT_PX_BUDGET /
   SHOT_MAX_PARTS）。手机上切段是原生做的，这里是电脑上直接喂文件时走的同一条规则——
   两边一旦不一致，就会出现「电脑上看着好好的、手机上糊成一片」，
   而这个项目已经在「只有真机才炸」这类问题上吃过好几次亏。 */
/* 宽度基本不动：字的清晰度由宽度决定，把宽度压掉就是压掉字。 */
const SHOT_WIDTH_CAP = 1600;
/* 一段的像素预算：官方会把图缩到「约 800×800」的量级，一段不超过它就不会被再缩。 */
const SHOT_PX_BUDGET = 640000;
/* 段数上限。一段一张图，太多会让请求又慢又贵，手机上原生 HTTP 还会 150 秒超时。 */
const SHOT_MAX_PARTS = 13;
/* 总 base64 的硬上限。超过就如实拒绝，而不是发一个几 MB 的请求去赌。 */
const SHOT_TOTAL_LIMIT = 3.5 * 1024 * 1024;

function visionModelName() {
  const s = settings();
  return (s.visionModel || '').trim() || VISION_MODEL;
}


/**
 * 一张图 → 若干张（长图竖切）。
 *
 * 为什么不重叠：重叠会让同一行字在两段里各出现一次，于是抄出来的记录里有重复，
 * 而"重复一句"比"少半句"更难发现——用户会以为是自己看错了。
 * 不重叠的代价是**可能从一行字中间切断**，那一行可能漏掉。两害相权取了后者，
 * 并且把这件事写在这里：真要彻底解决，得做行边界检测，那是另一个量级的事。
 */
function sliceTall(img) {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  /* 2.43 改掉了原来那套「按最长边缩到 1400、最多 3 段」的规则。
     它是这个 bug 的另一半：长截图的最长边是**高**，按最长边缩会把宽度压到 100px 上下
     （1080×14572 → 104×1400，34px 的字剩 3.3px），字就彻底没了。
     现在按「宽度基本不动 + 每段不超过像素预算 + 段数有上限」来切。 */
  const outW = Math.min(w0, SHOT_WIDTH_CAP);
  let bandH = Math.max(1, Math.floor(SHOT_PX_BUDGET / Math.max(1, outW)));
  let parts = Math.ceil(h0 / bandH);
  if (parts > SHOT_MAX_PARTS) parts = SHOT_MAX_PARTS;
  if (parts < 1) parts = 1;
  bandH = Math.ceil(h0 / parts);   // 均分，避免最后一段只剩一条缝
  const k = Math.min(1, outW / w0);
  const w = Math.round(w0 * k);
  const out = [];
  const whole = document.createElement('canvas');
  whole.width = w; whole.height = Math.round(h0 * k);
  const wg = whole.getContext('2d');
  wg.fillStyle = '#fff'; wg.fillRect(0, 0, whole.width, whole.height);
  wg.drawImage(img, 0, 0, whole.width, whole.height);
  const each = bandH;
  for (let i = 0; i < parts; i++) {
    const y = i * each;
    const hh = Math.min(each, whole.height - y);
    if (hh <= 8) continue;
    const c = document.createElement('canvas');
    c.width = whole.width; c.height = hh;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(whole, 0, y, whole.width, hh, 0, 0, whole.width, hh);
    out.push({ dataUrl: c.toDataURL('image/jpeg', 0.82), w: whole.width, h: hh, part: i + 1, parts });
  }
  return out;
}

const OCR_SYS = `你在把聊天截图转成文字，供后续分析使用。只做转录，不做解读、不评价、不补全。

规则：
1. 逐条抄下图里出现的每一句，**保持原有顺序**。
2. 每句前面标出说话人。截图里通常是左右分布的两方：如果气泡在右侧、或明显是机主自己发的，标「我：」；
   另一侧标「对方：」。如果图里已经写了名字（微信昵称等），就用那个名字。
3. 同一句话因为换行被拆成多行时，合成一行，不要插入额外空格。
4. 表情、图片、语音、转账等非文字内容，用 [表情] [图片] [语音] [转账] 这样标注。
5. **看不清的字用 ？ 代替，不要猜**。整条看不清就写 [这条看不清]。
6. 截图顶部/底部的时间、电量、输入框里的字不要抄。
7. 如果两张图之间有重复的内容，只保留一次。
8. 不输出任何解释、标题或代码块，直接输出转录结果。`;

/**
 * 截图 → 文字。images 是 [{dataUrl, w, h, part, parts}]。
 * 返回 { text, parts }——text 是转录结果，parts 是实际送了几张图。
 */
async function ocrChatShots(images) {
  const total = images.reduce((n, x) => n + x.dataUrl.length, 0);
  if (total > SHOT_TOTAL_LIMIT) {
    throw new Error(`图太大了（${(total / 1024 / 1024).toFixed(1)} MB），传不动。`
      + '先在相册里裁掉不需要的部分，或者少传一张。');
  }
  const blocks = [{
    type: 'text',
    text: images.length > 1
      ? `这是同一段聊天记录的 ${images.length} 张截图，按顺序拼起来就是完整记录。请转录。`
      : '请转录这张聊天截图。',
  }];
  images.forEach((im) => {
    blocks.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  });
  const r = await llmCall(
    [{ role: 'system', content: OCR_SYS }, { role: 'user', content: blocks }],
    { temperature: 0, maxTokens: 4000, noFormat: true, textOk: true, model: visionModelName() });
  const text = String((r && (r.reply || r.text)) || '').trim();
  if (!text) throw new Error('模型没返回文字');
  /* 「静默忽略图片」的兜底：模型会回一段通顺的话，但里面没有任何转录的样子
     （没有「我：」「对方：」这类标记，也没有换行）。那种结果必须说出来，
     而不是让用户拿着一堆二手分析去复盘一段不存在的对话。 */
  const looksLikeTranscript = /[:：]/.test(text) || text.split('\n').length >= 2;
  if (!looksLikeTranscript) {
    throw new Error('模型回了内容，但看不出是聊天记录（可能是它没读图，只顺着话答了）。'
      + `原样返回是：${text.slice(0, 80)}`);
  }
  return { text, parts: images.length };
}

/** 读一个 File/Blob 成 dataURL（电脑上走这条路，手机上不经过它）。 */
function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('读不了这个文件'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('这张图打不开（可能不是常见格式）'));
    im.src = src;
  });
}

/**
 * 让用户选聊天截图。
 *
 * 两条路：手机上走原生（ACTION_OPEN_DOCUMENT，跟选音乐同一套，WebView 里
 * <input type=file> 因为没设 WebChromeClient 是打不开的）；电脑上走隐藏的
 * file input——**这条不只是为了电脑能用，它让这个功能可以在自动化里被真的测到**
 * （Playwright 的 setInputFiles 能喂图进去）。
 */
function pickChatShots() {
  if (V.native && V.caps && V.caps.shot) {
    try { V.native.shotPick(); } catch (e) { toast('打不开图片选择器'); }
    return;
  }
  let inp = document.getElementById('shotInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'shotInput';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.style.display = 'none';
    inp.addEventListener('change', () => { onShotsPicked(inp.files); inp.value = ''; });
    document.body.appendChild(inp);
  }
  inp.click();
}

/** 原生选完图 → 这里。payload 是 {ok, dataUrl, name} 或 {ok:false, why}。 */
/** 原生选完图 → 这里。payload 是 {ok, dataUrl, name} 或 {ok:false, why}。
 *  注意到手的是 **JSON 字符串**（见 bridgeObj 的说明），要先归一化。 */
window.__onShot = function (payload) {
  payload = bridgeObj(payload);
  if (!payload || !payload.ok) {
    if (typeof shotDone === 'function') shotDone(null, (payload && payload.why) || '没选到图片');
    return;
  }
  /* 手机上原生已经把图**切好段**了（见 MainActivity.shotToDataUrls：它按宽度保清晰度、
     按段数上限切横段，并逐段解码以免 OOM）。所以这里**不要再切一次**——
     再切一遍只会把已经切好的小段又切开，白白多几张图。
     兼容单张的老形状（dataUrl 字符串），那条路只有旧代码/测试会走。 */
  const parts = Array.isArray(payload.dataUrls)
    ? payload.dataUrls.filter(Boolean).map((du, i, arr) => ({ dataUrl: du, part: i + 1, parts: arr.length }))
    : null;
  const chain = parts && parts.length
    ? Promise.resolve(parts)
    : loadImage(payload.dataUrl).then((im) => sliceTall(im));
  chain
    .then((ps) => ocrChatShots(ps))
    .then((r) => { if (typeof shotDone === 'function') shotDone(r, null); })
    .catch((e) => { if (typeof shotDone === 'function') shotDone(null, e.message); });
};

/** 电脑上从 input 拿到的文件 → 同样的处理链。 */
async function onShotsPicked(files) {
  if (!files || !files.length) return;
  if (typeof shotDownloading === 'function') shotDownloading();
  try {
    const imgs = [];
    for (const f of Array.from(files).slice(0, SHOT_MAX_PARTS)) {
      const url = await readAsDataUrl(f);
      const im = await loadImage(url);
      sliceTall(im).forEach((p) => { if (imgs.length < SHOT_MAX_PARTS) imgs.push(p); });
    }
    if (!imgs.length) throw new Error('没有可用的图片');
    const r = await ocrChatShots(imgs);
    if (typeof shotDone === 'function') shotDone(r, null);
  } catch (e) {
    if (typeof shotDone === 'function') shotDone(null, e.message);
  }
}
