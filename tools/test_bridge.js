/* 桥的静态交叉检查：网页调用的每一个 EQNative.X，都必须在 Java 的 Bridge 类里
 * 真的有对应的方法，而且必须带 @JavascriptInterface。
 *
 * 为什么要有这个测试：
 * 「httpPost is not a function」这个 bug 的真实成因是——httpPost 和 httpGet 写在了
 * MainActivity 上而不是 Bridge 内部类里，于是 WebView 看不到它们，一调用就抛错。
 * 它能编译、能打包、能安装、能启动，**只在真机上用到 AI 功能时才炸**。
 * 而浏览器里走的是 /api/proxy 那条路，正好绕开原生桥，所以本地怎么测都是好的。
 *
 * 也就是说：这一类 bug 靠「在浏览器里跑一遍」永远发现不了，而它一炸就是
 * 语音陪练 + 表达体检 + 真实复盘 三个模块全废。所以必须做静态检查，
 * 而且必须在构建之前跑。
 *
 * node tools/test_bridge.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 默认读**仓库里**那份（它是唯一来源；构建时由 android/build_apk.py 同步到
// E:\android-build\app）。以前这里默认读 E: 那份，于是「改了仓库、测的是别处」
// 完全可能发生——同一个坑在 index.html 上已经踩过一次了。
const SRC = process.env.EQ_ANDROID_SRC || path.join(ROOT, 'android', 'src', 'com', 'local', 'cognitiontrainer');
const MAIN = path.join(SRC, 'MainActivity.java');

let pass = 0;
let fail = 0;
function t(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  → ' + extra : ''}`); }
}

if (!fs.existsSync(MAIN)) {
  console.log(`  跳过：找不到 ${MAIN}`);
  console.log('  （设 EQ_ANDROID_SRC 指向源码目录，或确认 Android 源码还在）');
  process.exit(0);
}

// 先把注释剥掉再扫。否则「注释里提到 @JavascriptInterface」会被当成真的注解——
// 这个误报我自己就踩了一次（那个外层方法的说明注释里正好写了这个词）。
const java = fs.readFileSync(MAIN, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');
const lines = java.split(/\r?\n/);

/* ---------- 1) 找出 Bridge 类的范围（靠大括号配平，不靠缩进猜） ---------- */
const bridgeStart = lines.findIndex((l) => /class\s+Bridge\s*\{/.test(l));
if (bridgeStart < 0) {
  console.error('找不到 Bridge 类，MainActivity.java 结构变了？');
  process.exit(1);
}
let depth = 0;
let bridgeEnd = -1;
for (let i = bridgeStart; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { bridgeEnd = i; break; }
    }
  }
  if (bridgeEnd >= 0) break;
}
const bridgeLines = lines.slice(bridgeStart, bridgeEnd + 1);
const bridgeSrc = bridgeLines.join('\n');

/* ---------- 2) Bridge 里被暴露的方法名 ---------- */
// 抓 @JavascriptInterface 后面紧邻的方法签名
const exposed = new Set();
for (let i = 0; i < bridgeLines.length; i++) {
  if (!/@JavascriptInterface/.test(bridgeLines[i])) continue;
  for (let j = i + 1; j < Math.min(i + 4, bridgeLines.length); j++) {
    const m = bridgeLines[j].match(/\b(?:public|private|protected)?\s*(?:final\s+)?[\w<>\[\], .]+\s+(\w+)\s*\(/);
    if (m) { exposed.add(m[1]); break; }
  }
}

/* ---------- 3) 网页侧调用的方法名 ---------- */
// 约定：调用原生桥一律写 EQNative.xxx（voice.js 里是 V.native.xxx）。
// 不用局部别名——第一版测试想支持别名，结果自己的正则没匹配上，
// 于是「未使用」是误报。与其写一个容易错的别名识别，不如把约定固定下来，
// 再用下面那条断言强制它。约定统一，检查才可能不漏。
const jsFiles = ['public/app.js', 'public/voice.js'];
const called = new Set();
for (const f of jsFiles) {
  const fp = path.join(ROOT, f);
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/EQNative\.(\w+)\s*\(/g)) called.add(m[1]);
  for (const m of src.matchAll(/V\.native\.(\w+)\s*\(/g)) called.add(m[1]);
  // 强制约定：不许出现其它指向 EQNative 的局部别名。
  // 结尾要求是 ; , 或行尾——否则 `hasAcc = window.EQNative && ...` 这种
  // 布尔表达式会被误判成别名（第一版就误报了）。
  const aliases = [...src.matchAll(/(\w+)\s*=\s*(?:window\.)?EQNative\s*(?:;|,|$)/gm)]
    .map((m) => m[1]);
  if (aliases.length) {
    console.log(`  FAIL  ${f} 里出现了 EQNative 的局部别名：${aliases.join(', ')}`);
    console.log('        这会让静态交叉检查漏掉调用。改成直接写 EQNative.xxx。');
    fail++;
  }
}
// capabilities 是通过 EQNative 常量取的，单独确认
if (/typeof EQNative/.test(fs.readFileSync(path.join(ROOT, 'public/voice.js'), 'utf8'))) {
  called.add('capabilities');
}

console.log('桥的交叉检查：');
console.log(`  Bridge 类在第 ${bridgeStart + 1}–${bridgeEnd + 1} 行，暴露了 ${exposed.size} 个方法`);
console.log(`    ${[...exposed].sort().join(', ')}`);
console.log(`  网页调用了 ${called.size} 个：${[...called].sort().join(', ')}\n`);

/* ---------- 4) 核心断言：调用的每个方法都必须被暴露 ---------- */
const missing = [...called].filter((m) => !exposed.has(m));
t('网页调用的每个方法都在 Bridge 里且带 @JavascriptInterface',
  missing.length === 0,
  missing.length ? `缺失：${missing.join(', ')}  ← 真机上会抛 "X is not a function"` : '全部对得上');

/* ---------- 5) 守住那个具体的 bug：网络方法必须在 Bridge 里面 ---------- */
for (const m of ['httpPost', 'httpGet']) {
  t(`${m} 在 Bridge 类内部（不是 MainActivity 上）`,
    new RegExp(`@JavascriptInterface[\\s\\S]{0,200}?\\b${m}\\s*\\(`).test(bridgeSrc),
    exposed.has(m) ? '已暴露' : `不在 Bridge 里  ← 这正是 "post is not a function" 的成因`);
}

/* ---------- 6) 反向检查：Bridge 里暴露了但网页从不调用的，判失败 ----------
 *
 * 这一条原来只是**软提示**，理由是「死方法不会导致功能坏掉」。
 * 那个理由被事实否掉了：用户问「是不是应该有语音包那种的」——
 * 查下来 Java 里的 voices() 早就写好了，**而网页侧一次都没调用过**，
 * 所以那功能一直等于不存在。死方法确实不会让功能坏掉，它会让功能不存在。
 *
 * 所以改成硬失败。白名单里每一条都写明「为什么保留」——
 * 读的人要能自己判断该不该删，而不是看到一堆名字就跳过。 */
const KNOWN_UNUSED = {
  httpGet: '和 httpPost 成对留着的取数入口，目前只有一个调用点用 POST。'
    + '删掉它会让「取数」这条路整个消失，而它已经过桥的静态检查、没有维护成本。',
  deepBlockStatus: '深度拦截的状态查询。现在设置页是靠 probeRoot + 存下来的开关自己算的，'
    + '所以这个查询没被用上；但它是「显示真实状态」的正式入口，'
    + '以后要让设置页显示原生侧真实状态时会用到（这一版的 currentVoice 正是同类补课）。',
  openAppSettings: '跳到本应用的系统设置页。目前没有入口调用它——'
    + '如果以后要引导用户去开权限，这是标准的落点。',
};
const unused = [...exposed].filter((m) => !called.has(m));
const unexpected = unused.filter((m) => !KNOWN_UNUSED[m]);
t('Bridge 里没有「网页永远碰不到」的方法（死能力等于功能不存在）',
  unexpected.length === 0,
  unexpected.length
    ? `没人调用：${unexpected.join(', ')}  ← 要么给它一个入口，要么写明为什么保留`
    : (unused.length ? `只有白名单里这几个：${unused.join(', ')}` : '全部有调用点'));
for (const m of unused) {
  if (KNOWN_UNUSED[m]) console.log(`    白名单  ${m}：${KNOWN_UNUSED[m].slice(0, 46)}…`);
}

/* ---------- 7) 越界检查：MainActivity 上的 @JavascriptInterface 是无效的 ---------- */
const outside = [];
{
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i >= bridgeStart && i <= bridgeEnd) {
      // 跳过 Bridge 内部
      for (const ch of lines[i]) { if (ch === '{') d++; else if (ch === '}') d--; }
      continue;
    }
    if (/@JavascriptInterface/.test(lines[i])) outside.push(i + 1);
  }
}
t('Bridge 类外面没有 @JavascriptInterface（写在那儿是无效的，只会误导人）',
  outside.length === 0, outside.length ? `第 ${outside.join(', ')} 行` : '无');

/* ---------- 8) 桥的回调名与网页的 window.__on* 对得上 ---------- */
const callbacks = new Set();
for (const m of java.matchAll(/window\.(__on\w+)/g)) callbacks.add(m[1]);
const handlers = new Set();
for (const f of jsFiles) {
  const fp = path.join(ROOT, f);
  if (!fs.existsSync(fp)) continue;
  for (const m of fs.readFileSync(fp, 'utf8').matchAll(/window\.(__on\w+)\s*=/g)) handlers.add(m[1]);
}
const noHandler = [...callbacks].filter((c) => !handlers.has(c));
t('原生回调的每个 window.__onX，网页都真的定义了处理函数',
  noHandler.length === 0,
  noHandler.length ? `没人接：${noHandler.join(', ')}` : `${[...callbacks].sort().join(', ')} 都对得上`);

/* ---------- 8.5) 带数据的回调：网页必须把 JSON 字符串解出来 ----------
 *
 * 原生是这样发的：js("window.__onX&&window.__onX(" + q(json) + ")")。
 * q() 是 JSONObject.quote，它把 JSON **包成 JS 字符串字面量**，
 * 所以网页收到的 typeof 是 'string'，不是对象。
 *
 * 漏了解 JSON 的后果是**静默的**：不抛异常、不打日志，处理函数读到
 * payload.ok === undefined，于是每次都走「不成立」的兜底分支。
 * 这个坑真的踩到了，而且一次踩出两处：
 *   · __onShot：真机上一按就提示「没识别成功：没选到图片」，而原生日志
 *     明明是 emit ok=true len=43195——图读出来了、base64 也送到了。
 *     在模拟器上排查了很久（怀疑权限、怀疑选择器、怀疑桥），
 *     最后是把 typeof payload 临时打到界面上才看见是 'string'。
 *   · __onMusic：处理函数开头就是 `typeof o !== 'object'` 直接 return，
 *     于是「选好了」的提示和播放状态更新从来没生效过。
 *
 * 所以这条静态断言盯住两类：
 *   a) 用 q() 发 JSON 的回调 → 处理函数里必须出现 bridgeObj( 或 JSON.parse(
 *   b) 反向：处理函数里如果写了 `typeof ... !== 'object'` 这种"只认对象"的
 *      守卫，也判失败——那正是漏解 JSON 的写法。
 * 动态那一半在 tools/check_replay_shot.js 第六节（按真实形状真调一遍）。
 */
const payloadCallbacks = new Set();
// 逐行找：原生的写法是 js("window.__onX&&window.__onX(" + q(json) + ")")，
// 中间隔着字符串拼接，所以不能用一条"紧邻"的正则——第一版就写成了
// window.__onX\(\s*q\(，结果一个都没扫到，检查变成空转（还打印了 PASS）。
for (const line of java.split(/\r?\n/)) {
  if (!/window\.__on\w+/.test(line) || !/q\(/.test(line)) continue;
  const m = line.match(/window\.(__on\w+)/);
  if (m) payloadCallbacks.add(m[1]);
}

/* 扫之前先剥注释。
 *
 * 这条在 Java 那边已经踩过三次（@JavascriptInterface、setPackagesSuspended、
 * 写脚本那三条都是"注释里正好写着这个坏写法"）。我这次又踩了第四次：
 * bridgeObj 的说明注释里引用了 `typeof o !== 'object'` 这个坏模式，
 * 于是下面第二条断言把自己的说明文字当成了违规代码。
 *
 * JS 的行注释不能像 Java 那样无脑删——`'https://api.deepseek.com'` 里的
 * `//` 会把整行截断。所以这里只删**整行注释**和块注释。 */
const stripJsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split(/\r?\n/)
  .map((l) => (/^\s*\/\//.test(l) ? '' : l))
  .join('\n');
const jsSrcAll = stripJsComments(
  jsFiles.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'));

/** 取一个回调整处理函数的源码：支持 `window.__onX = function (){}` 和
 *  `window.__onX = someName;` 两种写法（__onMusic 就是后者，
 *  第一版因此把它的 bridgeObj 判成"没解 JSON"）。 */
function handlerBody(name) {
  const at = jsSrcAll.indexOf(`window.${name} =`);
  if (at < 0) return null;
  const head = jsSrcAll.slice(at, at + 80);
  const alias = head.match(/window\.__on\w+\s*=\s*(\w+)\s*;/);
  if (alias) {
    const fnAt = jsSrcAll.search(new RegExp(`function\\s+${alias[1]}\\s*\\(`));
    if (fnAt >= 0) {
      const stop = jsSrcAll.indexOf('\n}', fnAt);
      return jsSrcAll.slice(fnAt, stop > 0 ? stop + 2 : fnAt + 1500);
    }
    return null;
  }
  const nextAt = jsSrcAll.indexOf('window.__on', at + 10);
  return jsSrcAll.slice(at, nextAt > 0 && nextAt - at < 1500 ? nextAt : at + 1500);
}

const notParsed = [];
const objectOnlyGuard = [];
for (const cb of payloadCallbacks) {
  const body = handlerBody(cb);
  if (!body) { notParsed.push(`${cb}(找不到处理函数)`); continue; }
  if (!/bridgeObj\(|JSON\.parse\(/.test(body)) notParsed.push(cb);
  if (/typeof\s+\w+\s*!==\s*'object'/.test(body)) objectOnlyGuard.push(cb);
}
t('用 q() 发 JSON 的回调，网页都把字符串解出来了（否则静默失效）',
  notParsed.length === 0,
  notParsed.length
    ? `${notParsed.join(', ')}  ← 加 bridgeObj(payload)，见 voice.js`
    : `已检查：${[...payloadCallbacks].sort().join(', ')}`);
t('没有「只认对象」的守卫（typeof x !== \'object\' 就是漏解 JSON 的写法）',
  objectOnlyGuard.length === 0,
  objectOnlyGuard.length ? `${objectOnlyGuard.join(', ')}  ← 改成 bridgeObj(x)` : '无');
if (payloadCallbacks.size === 0) console.log('  （没扫到用 q() 发 JSON 的回调，检查范围可能失效）');


/* ---------- 9) 不可残留：卸载之后必须什么都不剩 ----------
 *
 * 用户明确提过一个条件：「留一个退路，防止变成流氓软件，如果我完全放弃这个项目，
 * 我可以把软件直接卸载了，然后整个阻拦就消失。」
 *
 * 这条要求直接排除了一类做法，而且是有理由排除的：
 *   - DevicePolicyManager.setPackagesSuspended（系统挂起）——状态记在系统里，
 *     卸载发起方之后可能残留，得手动去设备管理员里恢复；
 *   - pm disable-user / setApplicationEnabledSetting——同上，禁用状态是系统级的；
 *   - 写任何会被系统记住的拦截状态。
 * 所以闸门全部跑在本应用自己的进程里（无障碍服务 + TYPE_APPLICATION_OVERLAY），
 * 卸载即消失。下面这条断言把这个约束固定下来，防止以后有人为了「拦得更死」
 * 把它改成系统级挂起——那正好会破坏用户唯一在意的那个安全条件。
 */
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.java'));
// 剥注释再扫。GateService 的注释里正好写着「我为什么**不**用
// DevicePolicyManager.setPackagesSuspended」——不剥注释就会把说明当成违规。
// 这个坑在检查 @JavascriptInterface 时已经踩过一次了。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');
const raw = srcFiles.map((f) => ({ f, s: fs.readFileSync(path.join(SRC, f), 'utf8') }));
const rawCode = raw.map((x) => ({ f: x.f, s: stripComments(x.s) }));

const FORBIDDEN = [
  [/DevicePolicyManager/, 'DevicePolicyManager（系统挂起会残留）'],
  [/setPackagesSuspended/, 'setPackagesSuspended（状态记在系统里）'],
  [/setApplicationEnabledSetting/, 'setApplicationEnabledSetting（系统级禁用）'],
  [/pm\s+disable-user/, 'pm disable-user（系统级禁用）'],
  [/WORLD_READABLE|WORLD_WRITEABLE/, '全局可读写的文件'],
];
const hits = [];
for (const { f, s } of rawCode) {   // 用剥过注释的源码
  for (const [re, label] of FORBIDDEN) {
    if (re.test(s)) hits.push(`${f}: ${label}`);
  }
}
t('没有任何写系统级拦截状态的调用（保证卸载即消失、零残留）',
  hits.length === 0, hits.length ? hits.join('; ') : `${srcFiles.length} 个源文件干净`);

// 反过来：拦截必须真的落在我们自己的进程里，否则这条保证是空的
const gateSrc = (raw.find((x) => x.f === 'GateService.java') || {}).s || '';
const scope = /AccessibilityService/.test(gateSrc);
const overlay = /TYPE_APPLICATION_OVERLAY/.test(gateSrc);
const homePush = /performGlobalAction/.test(gateSrc);
t('拦截实现在无障碍服务里（本应用进程内）', scope && overlay && homePush,
  [scope ? 'AccessibilityService' : '缺服务', overlay ? 'TYPE_APPLICATION_OVERLAY' : '缺浮层',
   homePush ? 'performGlobalAction' : '缺推走'].join(' · '));

// 第二次不能跳：跳过按钮的存在必须由 canSkip 决定，不能写死
t('跳过按钮由 canSkip 控制（第二次没有跳过按钮）',
  /if \(canSkip\)[\s\S]{0,400}?skip\.setText/.test(gateSrc.replace(/\s+/g, ' ').replace(/if \(canSkip\) /, 'if (canSkip) '))
  || /canSkip/.test(gateSrc) && /skip\.setText/.test(gateSrc),
  'GateService 里 canSkip 与跳过按钮关联');

/* 保留用户要求的卸载出口提示，代价如实区分应用内数据与外部备份。
 * 具体渲染文本由 check_native_gate.py 运行 GateService 验证。
 * root 深度拦截仍需自带可见状态，不能把启用意图冒充真实保护。
 */
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

t('浮层保留卸载出口和内部数据清除提示（实际显示由 native 测试验证）',
  /卸载/.test(gateSrc) && /应用内部的进度、预案和身份陈述/.test(gateSrc));

t('浮层不再把卸载说成全部副本归零',
  /不会删除已导出或保存在应用外的备份/.test(gateSrc)
  && !/代价是全部归零/.test(gateSrc));

t('root 深度拦截带可见状态（探测三态 + 不可用时自动关掉）',
  /RootGate\.forceStop/.test(gateSrc) && /Prefs\.deepBlock/.test(gateSrc)
  && /rootKnown/.test(appSrc) && /__onRootProbe/.test(appSrc)
  && /rootOk = false/.test(appSrc),
  'GateService 调用 · 设置页三态显示 · 启动时重置探测结果');

// 包名会拼进 shell 命令。没有白名单校验就是命令注入——来源是本地设置也一样，
// 没有任何理由留这个口子。
const rootSrc = stripComments(
  fs.readFileSync(path.join(SRC, 'RootGate.java'), 'utf8'));
t('拼进 su 命令的包名做了白名单校验（防命令注入）',
  /Pattern\.compile/.test(rootSrc) && /PKG\.matcher\(pkg\)\.matches\(\)/.test(rootSrc),
  'RootGate 里 PKG 正则先校验再拼命令');

/* 杀进程不能受冷却限制。
 *
 * 冷却（COOLDOWN_MS）是为了别把浮层刷爆。如果它同时也挡住了杀进程，
 * 就留下一条缝：杀掉之后 2.5 秒内重新打开，这一轮就整个被放过——
 * 而这恰恰是「强制」最该堵的那条缝。这是个很容易在重构时被带回去的
 * 顺序问题（把 return 挪到 kill 前面就破了），所以用位置断言钉住。
 */
const gateBody = stripComments(
  fs.readFileSync(path.join(SRC, 'GateService.java'), 'utf8'));
const killAt = gateBody.indexOf('RootGate.forceStop');
const coolReturnAt = gateBody.search(/if\s*\(!cooled\)\s*return/);
t('杀进程在冷却判断之前（两秒内重开也跑不掉）',
  killAt > 0 && coolReturnAt > killAt,
  killAt < 0 ? '找不到 forceStop 调用'
    : coolReturnAt < 0 ? '找不到 if (!cooled) return'
    : `forceStop@${killAt} < 冷却return@${coolReturnAt}`);

/* ---------- 10) 「卸载之后磁盘上不许剩下能跑的东西」 ----------
 *
 * 用户把约束放宽了一半，另一半没放宽，而且这另一半才是有安全含义的那个：
 *
 *   「卸载一些残留的文本数据是可以留下来的，除非我再用清理软件给它清掉。
 *     然后所有的进程，什么代码，脚本什么的那些都要删掉，只留下文本数据。」
 *
 * 也就是：**允许留数据，不许留可执行的东西**。判据是「卸载之后还剩什么」。
 *
 * ── 2.38 这里放宽了一次，要写清楚为什么 ──────────────────────────
 * 原来这一节写的是「不许往磁盘写脚本，root 必须是一次性的 ProcessBuilder 调用」，
 * 理由是「那样脚本就留下了」。2.38 加了「防掉线」——Android 在强行停止应用时会把
 * 无障碍服务一并撤销且不自愈（实测：force-stop 后 enabled_accessibility_services
 * 被清成 null，等 15 秒也不回来），而大多数 ROM 把「从最近任务划掉」就实现成
 * force-stop。要修它，就必须有一个 root 下的守夜循环，也就必须有脚本。
 *
 * 所以判据从**形式**（有没有 .sh）改成了**实质**（会不会留下）：
 *   · 脚本只允许写在应用私有目录（getFilesDir）——卸载时系统会连目录一起删；
 *   · 脚本自己每轮检查包还在不在，卸载后主动退出（这条也有断言）；
 *   · 外部存储那一条一个字没松：仍然只许写那一个 .json，而且不许是 .sh/.dex/.apk。
 * 「卸载后什么都没有留下」这个性质没变，变的只是它可以被实现了。
 * 这一条改动是**用户明确要求用 root 做功能**之后做的，不是自己松的。
 */
const EXT_BAD = [
  [/\.bash\b/, '写 .bash 脚本'],
  [/\.dex\b|\.apk\b|\.jar\b|\.so\b/, '写可执行/库文件'],
  [/\.js\b/, '写 .js 文件'],
];
const extHits = [];
for (const { f, s } of rawCode) {
  for (const [re, label] of EXT_BAD) {
    if (re.test(s)) extHits.push(`${f}: ${label}`);
  }
}
t('没有任何一处往磁盘写可执行/库文件', extHits.length === 0,
  extHits.length ? extHits.join('; ') : `${srcFiles.length} 个源文件干净`);

/* .sh 只允许出现在 GateWatch 里，而且必须落在私有目录（getFilesDir）。
   别的地方写 .sh 一律算违规——包括"顺手把命令写进外部存储"那种。 */
const shWriters = rawCode.filter(({ s }) => /\.sh\b/.test(s)).map((x) => x.f);
t('.sh 只由 GateWatch 写，且只写进私有目录',
  shWriters.every((f) => f === 'GateWatch.java')
  && /getFilesDir\(\)/.test((rawCode.find((x) => x.f === 'GateWatch.java') || {}).s || '')
  && /openRawResource\(R\.raw\.eq_gate\)/.test(
    (rawCode.find((x) => x.f === 'GateWatch.java') || {}).s || ''),
  shWriters.length ? `写 .sh 的文件：${shWriters.join(', ')}` : '没有任何文件提到 .sh');

/* 守夜脚本必须自己检查「包还在不在」——这是「卸载即退出」的唯一实现。
   没有它，卸载之后循环会继续跑，还会为一个不存在的包反复写系统设置。 */
const watchSh = fs.readFileSync(
  path.join(ROOT, 'android', 'res', 'raw', 'eq_gate.sh'), 'utf8');
t('守夜脚本卸载后会自己退出（每轮检查包还在不在）',
  /pm path/.test(watchSh) && /exit 0/.test(watchSh),
  '脚本里有 pm path 检查 + 退出');

/* 守夜脚本禁止覆盖别人的无障碍服务。
   enabled_accessibility_services 是一整份冒号分隔的列表，settings put 是整体覆盖；
   直接写自己那一个，会把用户其它无障碍服务全关掉。所以必须"先读、缺了才追加"。 */
t('守夜脚本只追加、不覆盖别人的无障碍服务',
  /\$cur:\$SVC/.test(watchSh) && /settings get secure enabled_accessibility_services/.test(watchSh),
  '先读列表，缺了才用 : 追加');

/* 守夜脚本只允许在用户自己开过它之后启动。
   两个原生入口（网页开关、无障碍服务连上）都必须先查那个开关——没开过就绝不碰 root。
   尤其是 GateService 那个入口：它是**开机自动触发**的，不加判断就等于给所有人
   默认开了一个 root 循环，那就成了流氓软件。 */
const startSites = rawCode.filter(({ s }) => /GateWatch\.start\(/.test(s));
const unguarded = startSites.filter(({ s }) => {
  // 看启动点前面 300 个字符里有没有那个开关：网页开关走 want，服务走 Prefs.gateWatch
  const before = s.slice(Math.max(0, s.indexOf('GateWatch.start(') - 300), s.indexOf('GateWatch.start('));
  return !/want|gateWatch|Prefs\.gateWatch/.test(before);
});
t('只有用户开过防掉线才会去启动它（每个入口都先查开关）',
  startSites.length > 0 && unguarded.length === 0,
  startSites.length === 0 ? '没有任何地方启动它（功能是死的）'
    : (unguarded.length ? `没查开关就启动：${unguarded.map((x) => x.f).join(', ')}`
      : `启动点：${startSites.map((x) => x.f).join(', ')}`));

/* 无障碍服务连上时顺手带起守夜循环——这条堵的是「重启之后又被划掉」那个缺口：
   无障碍服务是持久化的、开机系统会自己连上，而守夜循环故意不做开机自启，
   所以不在这里补一刀，重启后第一次划掉就又没人装回来了。 */
t('无障碍服务连上时会把守夜循环带起来（堵重启之后的缺口）',
  /onServiceConnected[\s\S]{0,900}GateWatch\.start\(/.test(gateBody)
  && /Prefs\.gateWatch\(this\)/.test(gateBody),
  'onServiceConnected 里先查 Prefs.gateWatch 再启动');

/* 外部存储只写一个纯文本 .json 备份 */
const backupSrc = (rawCode.find((x) => x.f === 'BackupStore.java') || {}).s || '';
t('外部存储只写一个纯文本 .json 备份',
  /\.json/.test(backupSrc)
  && !/\.sh|\.dex|\.apk/.test(backupSrc)
  && /openOutputStream|FileOutputStream/.test(backupSrc),
  'BackupStore 里只有 .json 一处落盘');


/* RootGate 只负责「执行一条命令」，自己不落盘。
   注意这条现在**只管** RootGate（深度拦截那条路）；唯一允许写脚本的是 GateWatch，
   规矩在上一节里单独钉住。别把这条的标题读成「全项目都不写脚本」——
   2.38 之后已经不是那样了。 */
t('RootGate 只执行命令、自己不落盘',
  /ProcessBuilder\("su", "-c", cmd\)/.test(rootSrc)
  && !/FileOutputStream|FileWriter|writeBytes/.test(rootSrc),
  'RootGate 只执行、不写文件');

// 备份功能不许在卸载路径上被误删——它是「卸载不等于归零」的唯一实现
t('进度备份功能在位（卸载不等于全部归零）',
  /backupNow/.test(java) && /backupNow/.test(appSrc)
  && /maybeOfferRestore/.test(appSrc),
  '原生写入 + 网页写入 + 重装后提示恢复');

console.log(`\n不可残留检查：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
