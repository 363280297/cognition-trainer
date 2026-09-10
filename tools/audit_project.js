/* 项目自检：找**这个项目真的栽过的**那几类问题，不是通用 lint。
 *
 * 每一次都是实际发生过的：
 *   · 写了一个状态，但没有任何一处读它（hit 过 4 次：CONTENT.stages 白名单、
 *     卡片页 cardsView、原生桥 voices()、以及若干）
 *   · 定义了函数但没接上（voices() 那次的结果是「功能根本不存在」）
 *   · 版本号在 manifest / README / PLAN 三处各写一遍，改漏一处没人发现
 *   · 权限数量、密钥有没有混进包里（用户的硬约束）
 *
 * 这个脚本只报告，不修改。零退出码 = 没发现问题。
 *
 *   node tools/audit_project.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('public/app.js');
const voice = read('public/voice.js');
const html = read('认知训练-离线版.html');
const index = read('public/index.html');

const findings = [];
const note = (level, what, detail) => findings.push({ level, what, detail });

// ---------------------------------------------------------------- 1 状态写入但不读
console.log('\n[1 状态：写了但没有任何一处读它]');
{
  const m = app.match(/const DEFAULT_STATE = \{([\s\S]*?)\n\};/);
  if (!m) note('ERR', '读不到 DEFAULT_STATE', '正则会随格式变化失效，这里要跟着改');
  const body = m ? m[1] : '';
  // 顶层键：行首两个空格 + 标识符 + 冒号
  const keys = [...body.matchAll(/^  ([A-Za-z_$][\w$]*):/gm)].map((x) => x[1]);
  /* 读的位置要扫**全部**用到状态的源码，不能只看 app.js。
     第一版只扫 app.js，于是 voice.js 里读的 state.scenes 被报成死状态——
     一次误报就足够让人不再相信这个检查。 */
  const all = app + '\n' + voice;
  const dead = [];
  for (const k of keys) {
    const reads = [...all.matchAll(new RegExp(`state\\.${k}\\b(?!\\s*=(?!=))`, 'g'))].length;
    if (reads === 0) dead.push(k);
  }
  if (dead.length) {
    // 这一条从 WARN 提到 ERR：它抓到过两次真事。最近一次是 probeNative()——
    // 能力探测函数写好了却没人调用，于是 V.caps 一直是全 false，界面上
    // 一律说「这台手机没有可用的语音识别引擎」，而用户手机其实是好的。
    note('ERR', '这些状态只有写入、没有任何读取', dead.join(', '));
    console.log(`  !! 只有写入没有读取：${dead.join(', ')}`);
  } else {
    console.log(`  ok ${keys.length} 个状态键都有被读`);
  }
}

// ---------------------------------------------------------------- 2 死函数
console.log('\n[2 定义了但没有任何调用的函数]');
{
  const src = app + '\n' + voice;
  const defs = [...src.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((x) => x[1]);
  const uniq = [...new Set(defs)];

  /* 判据是「有没有调用点」，不是「这个名字出现过几次」。
     差别是真实存在的：`window.__onCaps = probeNative;` 让 probeNative 出现了两次，
     于是旧判据认为它活着——而它其实**一次都没被调用**，害得 V.caps 一直是全 false，
     界面上对所有人一律说「这台手机没有可用的语音识别引擎」。
     「被提到」和「被调用」是两件事，这条检查必须能分开它们。 */
  const callsOf = (name) => {
    const pat = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let n = 0;
    for (const text of [src, html]) {
      for (const m of text.matchAll(pat)) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        if (/function\s*$/.test(before)) continue;      // 定义行不算调用
        n++;
      }
    }
    return n;
  };
  const dead = [];
  const valueOnly = [];
  for (const name of uniq) {
    const mentions = (src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    const calls = callsOf(name);
    if (calls === 0 && mentions <= 1) dead.push(name);      // 除了自己的定义，哪儿都没有
    else if (calls === 0) valueOnly.push(name);             // 只被当值引用过（.map / setTimeout / 派发表）
  }
  if (dead.length) {
    // 提到 ERR。这类错误「不报错、不崩溃，只是功能静默失效」，靠人眼扫 WARN 是靠不住的。
    note('ERR', '这些函数定义了但没人调用', dead.join(', '));
    console.log(`  !! 死函数（${dead.length} 个）：${dead.join(', ')}`);
  } else {
    console.log(`  ok ${uniq.length} 个函数都有调用点`);
  }
  /* 「只被当值引用」单独列出来，不算失败，但要让人看见。
     它是有用的：probeNative 那个坑当时就是这个形状——全项目只有一句
     `window.__onCaps = probeNative`，看起来"被引用了"，其实一次都没调用。
     光靠静态检查分不清"这是交给原生回调的入口"和"这是忘了调用"，
     所以这里只提示，真正的守门交给行为断言：
     tools/check_music_asr.js 里那条「网页真的问了原生能力、并且拿到了值」会在
     调用被去掉时当场变红（这个坑就是它抓出来的）。 */
  if (valueOnly.length) {
    console.log(`  ～ 只被当值引用（不是直接调用，人工确认一下）：${valueOnly.join(', ')}`);
  }
}

// ---------------------------------------------------------------- 3 版本号三处一致
console.log('\n[3 版本号：manifest / README / PLAN]');
{
  const mf = read('android/AndroidManifest.xml');
  const vc = (mf.match(/versionCode="(\d+)"/) || [])[1];
  const vn = (mf.match(/versionName="([\d.]+)"/) || [])[1];
  const readme = (read('README.md').match(/versionCode \/ versionName \| (\d+) \/ ([\d.]+)/) || []);
  const plan = read('PLAN.md');
  // PLAN 里的历史块是「越靠前越新」，但更稳的判据是按 versionCode 取最大值——
  // 用 pop() 会拿到文件最后一个（也就是最早的一条），第一版就这么错了。
  const planAll = [...plan.matchAll(/APK ([\d.]+)（versionCode (\d+)）/g)];
  const planLast = planAll.length
    ? planAll.reduce((a, b) => (Number(b[2]) > Number(a[2]) ? b : a)) : [];
  console.log(`  manifest ${vc}/${vn} · README ${readme[1]}/${readme[2]} · PLAN 最新 ${planLast[2]}/${planLast[1]}`);
  if (readme[1] !== vc || readme[2] !== vn) {
    note('ERR', 'README 的版本号和 manifest 不一致', `README ${readme[1]}/${readme[2]} vs manifest ${vc}/${vn}`);
  }
  if (planLast[2] !== vc) {
    note('WARN', 'PLAN 最新一条的 versionCode 和 manifest 不一致', `PLAN ${planLast[2]} vs manifest ${vc}`);
  }
  /* 「关于」那一页把版本号写在界面上（voice.js 的设置分区里）。
   * 这是我自己新加的一处版本号，也就是第四个会漂的地方——所以同样要盯。
   * 界面上写着一个和安装包不一致的版本号，用户报问题时会说错版本。 */
  const about = (voice.match(/版本 ([\d.]+)（versionCode (\d+)）/) || []);
  if (!about.length) {
    note('WARN', '设置页「关于」里找不到版本号（改了文案就要同步改这个检查）', '');
  } else if (about[1] !== vn || about[2] !== vc) {
    note('ERR', '设置页「关于」里的版本号和 manifest 不一致',
      `界面 ${about[1]}/${about[2]} vs manifest ${vn}/${vc}`);
  } else {
    console.log(`  ok 设置页「关于」写的也是 ${about[1]}（versionCode ${about[2]}）`);
  }
  // 构建工作区在 E:\android-build。**原生源码的唯一来源是仓库**：
  // android/build_apk.py 每次构建都会把 src/res/manifest 同步过去并逐字节核对，
  // 所以这里报「不一致」只说明一件事——有人直接改了构建树里那份。
  const BUILD_MF = 'E:/android-build/app/AndroidManifest.xml';
  if (fs.existsSync(BUILD_MF) && read('android/AndroidManifest.xml') !== fs.readFileSync(BUILD_MF, 'utf8')) {
    note('ERR', '仓库 android/ 的 manifest 与构建树的不一致',
      '构建时会用仓库那份覆盖过去，所以这个差异会消失——但说明有人直接改了构建树里的文件');
  } else if (fs.existsSync(BUILD_MF)) {
    console.log('  ok 仓库 android/ 的 manifest 与构建树一致');
  }
  // 六个 java 源文件也要一致
  const CM = 'com/local/cognitiontrainer/';
  const unsynced = ['BackupStore', 'GateService', 'MainActivity', 'Prefs', 'ReminderReceiver', 'RootGate']
    .filter((f) => fs.existsSync(`E:/android-build/app/src/${CM}${f}.java`)
      && read(`android/src/${CM}${f}.java`) !== fs.readFileSync(`E:/android-build/app/src/${CM}${f}.java`, 'utf8'));
  if (unsynced.length) note('ERR', '这些 java 源文件仓库和构建树不同步', unsynced.join(', '));
  else console.log('  ok 6 个 java 源文件两边一致');
}

// ---------------------------------------------------------------- 4 用户硬约束
console.log('\n[4 用户的硬约束]');
{
  // 4a 密钥绝不能进包
  const keyish = html.match(/sk-[A-Za-z0-9]{12,}/g);
  if (keyish) note('ERR', '离线版 HTML 里出现了像密钥的字符串', keyish.join(', '));
  else console.log('  ok 包里没有 sk- 形式的密钥');

  // 4b 不许有系统级状态（真正的守卫在 test_bridge，这里顺手再扫一遍产物）
  const banned = ['DevicePolicyManager', 'setPackagesSuspended', 'setApplicationEnabledSetting',
    'pm disable-user', 'setComponentEnabledSetting'];
  const hitBanned = banned.filter((b) => html.includes(b));
  if (hitBanned.length) note('ERR', '产物里出现了系统级状态的调用', hitBanned.join(', '));
  else console.log('  ok 产物里没有系统级状态的调用');

  // 4c 权限数量（数量变了要有人知道）
  const perms = [...mf2()];
  function mf2() {
    return (read('android/AndroidManifest.xml').match(/android:name="android\.permission\.[A-Z_]+"/g) || []);
  }
  console.log(`  ok 权限 ${perms.length} 个`);
  /* 2.31 起是 6 个（删掉了 RECORD_AUDIO）。这个数字和 README 的表格一一对应，
     所以两处必须一起改——写着 7 而实际 6，用户报问题时会说错权限。 */
  if (perms.length !== 6) note('WARN', '权限数量和 README 写的 6 个不一样', String(perms.length));

  // 4d 外部存储只许一个 json
  const java = ['BackupStore', 'GateService', 'MainActivity', 'Prefs', 'ReminderReceiver', 'RootGate']
    .map((f) => read(`android/src/com/local/cognitiontrainer/${f}.java`)).join('\n');
  const writes = [...java.matchAll(/getExternalStoragePublicDirectory|Environment\.getExternalStorageDirectory/g)];
  console.log(`  外部存储相关调用 ${writes.length} 处（真正的不变式在 test_bridge 里）`);
}

// ---------------------------------------------------------------- 5 产物新鲜度
console.log('\n[5 产物新鲜度]');
{
  if (!fs.existsSync(path.join(ROOT, '认知训练-离线版.src.txt'))) {
    note('ERR', '缺少输入指纹文件', '跑 py -3 build_offline.py');
  } else {
    const crypto = require('crypto');
    const stamp = read('认知训练-离线版.src.txt').split('\n').map((s) => s.trim()).filter(Boolean);
    const h = crypto.createHash('sha256');
    for (const rel of stamp.slice(2)) {
      h.update(path.basename(rel));
      h.update(fs.readFileSync(path.join(ROOT, rel)));
    }
    const got = h.digest('hex');
    if (got !== stamp[0]) note('ERR', '离线版 HTML 与源码不同步', '改了源码没重建 → 会打出旧版本的包');
    else console.log('  ok 离线版 HTML 与源码同步');
  }
  // APK 里的 HTML 是不是这一份
  const apk = 'E:/android-build/认知训练.apk';
  if (fs.existsSync(apk)) {
    const { execSync } = require('child_process');
    try {
      const tmp = path.join(require('os').tmpdir(), 'audit_apk.html');
      execSync(`unzip -p "${apk}" assets/index.html > "${tmp}"`, { shell: 'bash' });
      const a = fs.readFileSync(tmp), b = fs.readFileSync(path.join(ROOT, '认知训练-离线版.html'));
      if (!a.equals(b)) {
        note('ERR', 'APK 里的 HTML 不是现在这份', '要重新 build_apk.py');
      } else console.log('  ok APK 里就是现在这份 HTML');

      /* 反过来查：离线识别那套（库 + 42MB 模型）**不该**在包里。
         2.31 用户要求删掉"听你说话"，那套东西跟着撤了；这一条守的是"别哪天又背回去"
         （构建树里留着的旧文件会继续被打进包——这条被自己的断言抓到过一次，
         APK 从 0.5MB 变回 42MB，而构建日志一切正常）。
         为什么自检里也查一遍：build_apk.py 里已经查过了，但那只在"正在构建"时有效，
         磁盘上的包可能是别的时刻构建的。 */
      const ls = execSync(`unzip -l "${apk}"`, { shell: 'bash' }).toString();
      const stray = ['lib/', 'vosk', 'jna'].filter((n) => ls.toLowerCase().includes(n));
      if (stray.length) {
        note('ERR', 'APK 里有不该有的东西（离线识别的库或模型）',
          `命中：${stray.join('、')}；见 android/vendor/README.md`);
      } else console.log('  ok APK 里没有离线识别的残留（2.31 起语音输入已删除）');

      const xt = execSync(`"E:/android-build/sdk/build-tools/34.0.0/aapt2.exe" dump xmltree `
        + `--file AndroidManifest.xml "${apk}"`, { shell: 'bash' }).toString();
      if (/#\[RECORD_AUDIO\]|permission\.RECORD_AUDIO/.test(xt)) {
        note('ERR', 'APK 里还有 RECORD_AUDIO 权限', '2.31 起不再录音，这个权限应该已经删掉');
      } else console.log('  ok 没有 RECORD_AUDIO（不再录音）');
    } catch (e) {
      note('WARN', '读不出 APK 里的内容', String(e.message).slice(0, 80));
    }
  } else {
    console.log('  (没找到 APK，跳过)');
  }
}

// ---------------------------------------------------------------- 6 tools 里有没有跑不起来的
console.log('\n[6 tools/ 里的脚本能不能跑]');
{
  // 只做静态语法检查：真的执行每一个脚本会花很久、还会花钱调模型
  const files = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');
    try { new Function(s); } catch (e) { bad.push(`${f}: ${e.message.slice(0, 60)}`); }
  }
  if (bad.length) {
    note('ERR', '这些脚本语法就不对，跑不起来', bad.join(' | '));
    bad.forEach((b) => console.log('  !! ' + b));
  } else {
    console.log(`  ok ${files.length} 个 js 脚本语法都通过`);
  }
  const pys = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.py'));
  console.log(`  （${pys.length} 个 py 脚本，语法由 py_compile 单独查）`);
}

// ---------------------------------------------------------------- 7 文档里提到的脚本是否都存在
console.log('\n[7 README 里点名的脚本是否都存在]');
{
  const doc = read('README.md');
  const mentioned = [...doc.matchAll(/(?:node|py -3) (tools\/[\w.]+|verify_offline\.js)/g)]
    .map((x) => x[1]);
  const missing = [...new Set(mentioned)].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    note('WARN', 'README 里提到但文件不存在的脚本', missing.join(', '));
    console.log(`  !! ${missing.join(', ')}`);
  } else {
    console.log(`  ok README 点名的 ${new Set(mentioned).size} 个脚本都在`);
  }
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(64));
const errs = findings.filter((f) => f.level === 'ERR');
const warns = findings.filter((f) => f.level === 'WARN');
if (!findings.length) {
  console.log('自检：没有发现问题');
} else {
  errs.forEach((f) => console.log(`  ERR   ${f.what}  → ${f.detail}`));
  warns.forEach((f) => console.log(`  WARN  ${f.what}  → ${f.detail}`));
  console.log(`\n自检：${errs.length} 个错误 / ${warns.length} 个提示`);
}
process.exit(errs.length ? 1 : 0);
