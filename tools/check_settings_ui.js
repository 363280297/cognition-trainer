/* 每日计划设置页的渲染检查。
 *
 * 为什么要跑真浏览器：设置页整个是模板字符串拼出来的，一个拼错的分支
 * （比如 g 上不存在的键、少一个反引号内的表达式）会让整个面板白掉——
 * 而 node --check 只查语法，查不出运行时取 undefined.xxx。
 *
 * 跑两遍：
 *   1) 浏览器环境（没有 EQNative）→ 深度拦截那块应该显示「只在 Android App 里可用」
 *   2) 注入 EQNative 桩 + 三种 root 状态 → 三种文案都要出得来
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const fs = require('fs');

const URL = 'http://127.0.0.1:8787/';
let fail = 0;
const chk = (label, cond, extra) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fail++;
};

(async () => {
  // 本机已下载的 chromium 是 1234，而 npx 缓存里这份 playwright 想要 1243。
  // 直接指到已存在的 exe，省掉一次几百兆的下载。
  const EXE = process.env.EQ_CHROME
    || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
  const launchOpts = fs.existsSync(EXE) ? { executablePath: EXE } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(URL, { waitUntil: 'networkidle' });

  // ---- 场景 1：浏览器环境，没有原生桥 ----
  console.log('\n[场景 1] 浏览器环境（没有 EQNative）');
  await page.evaluate(() => window.openDailySettings());
  await page.waitForSelector('.sheet.open', { timeout: 5000 });
  const t1 = await page.textContent('.sheet.open');
  chk('设置面板渲染出来了', t1.length > 200, `${t1.length} 字`);
  chk('深度拦截那一块在', t1.includes('深度拦截'));
  chk('说明了 root 不可用时不报错', t1.includes('不会报错'));
  chk('浏览器里显示成只在 App 可用', t1.includes('只在 Android App 里可用'), 
    t1.match(/当前状态：[^\n]{0,40}/)?.[0] || '');

  // ---- 场景 2：注入 EQNative 桩，跑三种 root 状态 ----
  console.log('\n[场景 2] 注入 EQNative 桩，三态文案');
  const states = [
    { name: '未检测', gate: { rootKnown: false, rootOk: false, deepBlock: false }, want: '还没检测过' },
    { name: '可用',   gate: { rootKnown: true,  rootOk: true,  deepBlock: true  }, want: '深度拦截已开启' },
    { name: '不可用', gate: { rootKnown: true,  rootOk: false, deepBlock: false }, want: 'root 不可用' },
  ];
  for (const s of states) {
    await page.evaluate((st) => {
      window.closeSheet && window.closeSheet();
      window.EQNative = window.EQNative || {};
      state.gate = Object.assign({ packages: [], enabled: false }, st.gate);
      window.openDailySettings();
    }, s);
    const t = await page.textContent('.sheet.open');
    chk(`状态「${s.name}」文案正确`, t.includes(s.want),
      (t.match(/当前状态：[^<]{0,36}/) || [''])[0].replace(/\s+/g, ' '));
    const hasToggle = t.includes('开启深度拦截') || t.includes('关掉深度拦截');
    const expectToggle = (s.gate.rootKnown && s.gate.rootOk) || s.gate.deepBlock;
    chk(`状态「${s.name}」开关可见性正确`, hasToggle === expectToggle,
      `可见=${hasToggle} 应为=${expectToggle}`);
  }

  // ---- 场景 3：探测回调把不可用状态落下来时要顺手关掉开关 ----
  console.log('\n[场景 3] 探测失败要顺手关掉开关');
  const after = await page.evaluate(() => {
    state.gate = { packages: [], enabled: false, rootKnown: false, rootOk: false, deepBlock: true };
    window.__onRootProbe(false);
    return { deepBlock: state.gate.deepBlock, rootOk: state.gate.rootOk, rootKnown: state.gate.rootKnown };
  });
  chk('探测失败后 deepBlock 被关掉', after.deepBlock === false, JSON.stringify(after));

  // ---- 场景 4：备份区的三种状态 ----
  console.log('\n[场景 4] 备份区三态');
  const bstates = [
    { name: '没有备份', st: { ok: false, msg: '还没有备份文件', name: 'x.json', where: '下载/认知训练/' }, want: '还没有备份文件' },
    { name: '有备份', st: { ok: true, bytes: 4096, name: 'x.json', where: '下载/认知训练/' }, want: '已有备份' },
    { name: '旧系统要权限', st: { ok: false, needsPerm: true, msg: '需要存储权限' }, want: '申请存储权限' },
  ];
  for (const s of bstates) {
    await page.evaluate((st) => {
      window.closeSheet && window.closeSheet();
      window.EQNative = window.EQNative || {};
      EQNative.backupStatus = () => JSON.stringify(st);
      EQNative.backupNow = () => '下载/认知训练/认知训练-进度备份.json';
      EQNative.backupRead = () => '';
      state.backup = { at: Date.now(), ok: st.ok, where: '' };
      window.openDailySettings();
    }, s.st);
    const t = await page.textContent('.sheet.open');
    chk(`备份状态「${s.name}」文案正确`, t.includes(s.want),
      (t.match(/还没有备份文件|已有备份[^（]*|申请存储权限/) || [''])[0]);
  }
  // 「写进去了但读不回来」要单独说——这是「看着像成功其实不是」
  await page.evaluate(() => {
    window.closeSheet && window.closeSheet();
    EQNative.backupStatus = () => JSON.stringify({ ok: false, msg: '读不回来' });
    state.backup = { at: Date.now(), ok: false, where: '' };
    window.openDailySettings();
  });
  const tWriteOnly = await page.textContent('.sheet.open');
  chk('「写进去了但读不回来」有单独说明', tWriteOnly.includes('写进去了，但读不回来'));
  chk('并说明文件本身没丢', tWriteOnly.includes('文件本身没丢'));

  console.log(`\n页面报错：${errs.length ? errs.join(' | ') : '无'}`);
  if (errs.length) fail++;
  await page.screenshot({ path: 'tools/_settings_check.png' });
  await browser.close();

  // ---- 场景 5：重装后要提示恢复备份 ----
  // 用「离线单文件版」而不是本地服务，有两个原因：
  //   1. 那正是 APK 里装的东西（assets/index.html 就是它），测的是真正发货的产物；
  //   2. 本地 server.py 有 progress.json，会把进度喂进来，于是「本地是不是空的」
  //      这个前提根本不成立——第一次写这个测试就是被这一点绊住的，
  //      体现出来的现象是「该弹的框没弹」，很容易误判成功能坏了。
  console.log('\n[场景 5] 重装后提示恢复备份（跑离线单文件版 = APK 里的那一份）');
  const { pathToFileURL } = require('url');
  const OFFLINE = pathToFileURL(
    require('path').join(__dirname, '..', '认知训练-离线版.html')).href;
  const b2 = await chromium.launch(launchOpts);
  const backupJson = JSON.stringify({
    srs: { c1: { n: 3 } }, answers: [{ a: 1 }, { a: 2 }], stats: { total: 2 },
  });

  const fresh = async (opts) => {
    const ctx = await b2.newContext({ viewport: { width: 420, height: 900 } });
    const pg = await ctx.newPage();
    const dialogs = [];
    const perrs = [];
    pg.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    pg.on('pageerror', (e) => perrs.push(String(e)));
    await pg.addInitScript((o) => {
      window.EQNative = {
        setGate() {}, scheduleReminder() {}, setDeepBlock() {}, probeRoot() {},
        hasAccessibility: () => false, hasOverlayPermission: () => false,
        hasNotifPermission: () => false, capabilities: () => '{}',
        backupNow: () => 'x', backupRead: () => o.body, backupStatus: () => '{}',
        requestBackupPermission: () => 1,
      };
      if (o.seedLocal) localStorage.setItem('eq-state-v2', JSON.stringify({ srs: { old: 1 } }));
    }, opts);
    await pg.goto(OFFLINE, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(1600);   // maybeOfferRestore 里有 600ms 延时
    await ctx.close();
    return { dialogs, perrs };
  };

  const r1 = await fresh({ body: backupJson, seedLocal: false });
  chk('本地是空的时候会提示恢复', r1.dialogs.some((m) => m.includes('发现上次卸载前的备份')),
    r1.dialogs.length ? `弹了 ${r1.dialogs.length} 个框` : '没弹框');
  chk('提示里写明了备份的规模',
    r1.dialogs.some((m) => m.includes('1 张卡片记录') && m.includes('2 条作答')));
  chk('提示写明是「替换」而不是合并', r1.dialogs.some((m) => m.includes('替换当前进度')));
  chk('场景 5 页面无脚本报错', r1.perrs.length === 0, r1.perrs.join(' | ') || '无');

  const r2 = await fresh({ body: backupJson, seedLocal: true });
  chk('本地已有进度时不弹恢复框（不诱导用旧备份覆盖新的）',
    !r2.dialogs.some((m) => m.includes('发现上次卸载前的备份')),
    r2.dialogs.length ? `弹了：${r2.dialogs[0].slice(0, 30)}` : '没弹框');

  const r3 = await fresh({ body: '', seedLocal: false });
  chk('没有备份文件时不弹框', r3.dialogs.length === 0, r3.dialogs.length ? '弹了框' : '没弹框');

  const r4 = await fresh({ body: 'not json at all', seedLocal: false });
  chk('备份文件损坏时不弹框、也不报错',
    r4.dialogs.length === 0 && r4.perrs.length === 0,
    `${r4.dialogs.length} 框 / ${r4.perrs.length} 错`);

  await b2.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
