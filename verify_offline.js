/**
 * 离线单文件版的验证脚本。
 *
 * 离线版相对已在浏览器里验证过的正常版，只多了三件事：适配层 shim、内联的数据、内联的 css/icon。
 * 所以这里集中验证：
 *   1) shim 真的拦住了所有 /api/* 请求，并返回内嵌内容
 *   2) AI 端点返回可读的提示（而不是静默失败或暴露密钥）
 *   3) localStorage 被禁用时会退化成内存存储，App 不会崩
 *   4) 内联的数据与源 JSON 完全一致
 *   5) shim 的执行顺序在 app.js 之前
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const OUT = path.join(ROOT, '认知训练-离线版.html');
const html = fs.readFileSync(OUT, 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------- 新鲜度：这份 HTML 是不是由现在这批源码生成的 ----------
// 这一段是补上的一个真实漏洞。原来整条链上只有「APK == 离线版.html」被校验过
// （build_apk.py 逐字节比对），而**离线版.html 是不是等于现在的源码**没人管。
// 实际发生过：app.js 和 curriculum.json 改过之后忘了重建，HTML 停在旧内容，
// 而 APK 照常构建、字节比对通过、日志一切正常——因为 APK 确实等于那份旧的 HTML。
// 所以这里重算 build_offline.py 写下的那个输入指纹，对不上就失败。
console.log('\n[新鲜度]');
{
  const crypto = require('crypto');
  const stampPath = path.join(ROOT, '认知训练-离线版.src.txt');
  if (!fs.existsSync(stampPath)) {
    check('有输入指纹文件（证明这份 HTML 与源码同步）', false,
      '缺 认知训练-离线版.src.txt，请重跑 py -3 build_offline.py');
  } else {
    // trim 掉行尾：这份指纹文件可能被任何编辑器或 git 存成 CRLF，
    // 而多出来的 \r 会让每个路径都不存在——那样这条校验会永远红，
    // 而原因和"源码变了"完全无关。
    const stamp = fs.readFileSync(stampPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const wantHash = stamp[0], wantOut = stamp[1], srcs = stamp.slice(2);
    check('指纹记的就是这个 HTML', wantOut === path.basename(OUT), wantOut);
    const h = crypto.createHash('sha256');
    const missing = [];
    for (const rel of srcs) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) { missing.push(rel); continue; }
      h.update(path.basename(rel));
      h.update(fs.readFileSync(p));
    }
    if (missing.length) {
      check('指纹里列的输入文件都在', false, missing.join(', '));
    } else {
      const got = h.digest('hex');
      check('**这份 HTML 与源码同步**（改了源码就必须重建，否则会打出一个旧版本的包）',
        got === wantHash,
        got === wantHash ? `指纹 ${got.slice(0, 16)}…`
          : `源码已变（${got.slice(0, 16)}… ≠ 记录的 ${wantHash.slice(0, 16)}…）→ 请重跑 py -3 build_offline.py`);
    }
  }
}

// ---------- 结构 ----------
console.log('\n[结构]');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('内联了 3 段脚本（shim + voice + app）', scripts.length === 3, `实得 ${scripts.length} 段`);
const shim = scripts[0], voice = scripts[1], app = scripts[2];
check('shim 在其余脚本之前', html.indexOf('__EQ_OFFLINE__') < html.indexOf('const SET_KEY'),
  'shim 必须先定义 fetch 拦截');
check('voice.js 在 app.js 之前', html.indexOf('const V = {') < html.indexOf('const LS_KEY'),
  'voice 的全局函数要先就位');
check('无残留外部资源引用',
  ['/style.css', 'src="/app.js"', 'manifest.webmanifest'].every((t) => !html.includes(t)));
check('css 已内联', html.includes('<style>') && html.includes('--accent'));
check('icon 已内联为 data URI', html.includes('data:image/svg+xml;base64,'));
check('app.js 被原样内联', app.length > 20000, `${app.length} 字符`);

// 内联的脚本必须真的是当前版本。曾经出现过打 APK 时用了 8 分钟前的旧 HTML，
// 版本号权限全都正常，只有内容是老的——所以这里断言几个关键函数确实在。
const allScripts = scripts.join('\n');
for (const [name, needle, where] of [
  ['偏差统计', 'function recordBias(', 'app.js'],
  ['偏差类型表', 'const BIAS_TYPES =', 'app.js'],
  ['预案表述校验', 'function planProblem(', 'app.js'],
  ['预案编辑器', 'function planEditor(', 'app.js'],
  ['偏差画像视图', 'function renderBias(', 'app.js'],
  ['追问计数', 'function noteQuestion(', 'voice.js'],
  ['追问报告', 'function askReport(', 'voice.js'],
  ['关卡判定', 'function evalGate(', 'app.js'],
  ['纵向比对', 'function biasSplit(', 'app.js'],
  ['判局准确率', 'genreAcc'],
  ['身份陈述', 'function saveIdentity(', 'app.js'],
  ['天花板声明', 'function showBoundary(', 'app.js'],
]) {
  check(`${name} 已内联（${where}）`, allScripts.includes(needle));
}
// 内容键是自动吸收的（不再逐个列白名单），所以这里守住那条机制本身：
// 一旦有人把 boot 改回白名单，加了新数据文件就会静默失效。
check('boot 自动吸收所有内容键（不是白名单）',
  /Object\.keys\(j \|\| \{\}\)\.forEach/.test(app));

// ---------- 数据一致性 ----------
console.log('\n[内联数据与源文件一致]');
const embedded = JSON.parse(shim.match(/var EMBEDDED = (\{[\s\S]*?\});\r?\n/)[1]);
for (const [name, key] of [['cards', 'cards'], ['calibration', 'phrases'],
                           ['curriculum', 'lessons'], ['recovery', 'modes'],
                           ['scenarios', 'scenarios'], ['stages', 'stages']]) {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));
  const same = JSON.stringify(src) === JSON.stringify(embedded[name]);
  check(`${name}.json 一致（${src[key].length} 条）`, same);
}

// 阶段评估：离线版里也要能跑到（关卡判定和现实任务都不依赖网络）
const stagesSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages.json'), 'utf8'));
check('阶段数据含天花板声明（不能只有进度条）',
  !!(stagesSrc.boundary && stagesSrc.boundary.measured && stagesSrc.boundary.not_measured));
check('阶段数据含身份陈述机制',
  !!(stagesSrc.identity && stagesSrc.identity.examples_bad && stagesSrc.identity.examples_good));

// ---------- 适配层行为 ----------
console.log('\n[适配层行为]');

function runShim({ storageBlocked }) {
  const win = {};
  win.localStorage = storageBlocked
    ? { setItem() { throw new Error('SecurityError: storage disabled'); },
        getItem() { throw new Error('blocked'); },
        removeItem() {} }
    : (() => { const m = {}; return {
        getItem: (k) => (k in m ? m[k] : null),
        setItem: (k, v) => { m[k] = String(v); },
        removeItem: (k) => { delete m[k]; } }; })();
  const sandbox = { window: win, Response, console, JSON, Object, Promise, Error, String };
  vm.createContext(sandbox);
  vm.runInContext(shim, sandbox);
  return win;
}

(async () => {
  // 1) localStorage 可用
  const w = runShim({ storageBlocked: false });
  check('shim 设置了离线标记', w.__EQ_OFFLINE__ === true);

  const content = await (await w.fetch('/api/content')).json();
  // 不写死张数——写死了每次加内容都会误报「失败」，而它其实没在测张数。
  // 真正要测的是「shim 返回的条数和源 JSON 一致」。
  const srcCards = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'cards.json'), 'utf8')).cards.length;
  check('/api/content 返回内嵌内容',
    content.ok === true && content.cards.cards.length === srcCards,
    `${content.cards.cards.length} 张卡（源文件 ${srcCards}）`);

  const health = await (await w.fetch('/api/health')).json();
  check('/api/health 报告无 key（不泄露也不谎报可用）', health.has_key === false);

  const save = await (await w.fetch('/api/progress', { method: 'POST' })).json();
  check('进度保存被接受（进度本来就存在浏览器本地）', save.ok === true);

  const bad = await w.fetch('/api/ai/checkup', { method: 'POST' });
  const badJson = await bad.json();
  check('AI 端点返回 503 且提示可读', bad.status === 503 && badJson.ok === false);
  check('提示里说明了怎么用 AI', /server\.py/.test(badJson.error), badJson.error.slice(0, 40) + '…');
  check('错误信息里不含密钥字样', !/sk-[A-Za-z0-9]/.test(JSON.stringify(badJson)));

  const external = w.fetch('https://example.com/x');
  const externalRejected = await external.then(() => false, () => true);
  check('非 /api/ 请求不会被伪造（离线版不发外部请求）', externalRejected);

  // 2) localStorage 被禁用时不能崩
  const w2 = runShim({ storageBlocked: true });
  let survived = true;
  try {
    w2.localStorage.setItem('a', '1');
    w2.localStorage.getItem('a');
    await w2.fetch('/api/progress', { method: 'POST' });
  } catch (e) { survived = false; }
  check('localStorage 被禁用时退化为内存存储，不抛异常', survived,
    typeof w2.localStorage.setItem === 'function' ? '已替换为内存实现' : '未替换');

  console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})();
