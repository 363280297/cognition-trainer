/* 「闸门失效」和「防掉线」的检查。
 *
 * 起因是用户的一句反馈：「它容易被杀后台，就是关掉之后闸门就消失了。」
 *
 * 查下来是两件事，一件是系统的、一件是我们的：
 *   1. **系统那边**：Android 在强行停止应用时会把已启用的无障碍服务一并撤销，
 *      而且不自愈。实测（模拟器）：
 *         am kill        → 进程没被杀，开关不动
 *         am force-stop  → 进程死 + enabled_accessibility_services 被清成 null
 *         重启            → 自己回来（那个开关是持久化的）
 *      而多数国产 ROM 把「从最近任务划掉」实现成 force-stop。所以闸门是被系统关的，
 *      应用拦不住——只能（a）用 root 自己装回来，（b）如实说出来。
 *   2. **我们这边的 bug**：今天页那张卡只看 armed（= 你想拦 + 今天没达标，即**意图**），
 *      从来不问系统那边的无障碍服务还在不在。于是系统已经把闸门关了，
 *      卡片还在写「闸门已开、打开应用会先弹这个页面」——**一句假话**，
 *      而且用户只有真去打游戏才发现。
 *
 * 第 2 条是「把意图当事实」，和「达标曾经无条件加一」「备份只看写过的记忆」是同一类。
 * 这类 bug 的特点是**不报错、只是说反话**，所以必须用断言钉住，不能靠自觉。
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

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '认知训练-离线版.html'), 'utf8');

  // 静态部分：桥的调用形状。这类错误只在真机上炸，浏览器里发现不了，
  // 所以必须在离线版里静态查一遍。
  chk('网页真的会调 setGateWatch / gateWatchStatus',
    html.includes('EQNative.setGateWatch') && html.includes('EQNative.gateWatchStatus'));
  chk('__onGateWatch 归一化了 q() 包过的 JSON 字符串',
    /__onGateWatch\s*=\s*function[\s\S]{0,220}bridgeObj\(/.test(html),
    '桥回传的一律是字符串，不归一化就会静默失效');
  chk('防掉线只在用户开过的时候才启动（没开过绝不碰 root）',
    /state\.gate\.watch\s*&&\s*state\.gate\.watch\.want/.test(html));

  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];

  /** 注入一个假的 EQNative，然后渲染今天页，把闸门那张卡的文字抓回来。 */
  const today = async (acc) => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const r = await p.evaluate((accVal) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      window.EQNative = {
        hasAccessibility: () => accVal,
        hasOverlayPermission: () => true,
        hasNotifPermission: () => true,
        gateWatchStatus: () => JSON.stringify({ want: false, running: false, ago: -1 }),
        setGateWatch: () => { window.__called = (window.__called || 0) + 1; },
        setDeepBlock: () => {},
      };
      state.gate = state.gate || {};
      state.gate.enabled = true;
      state.gate.packages = ['com.example.game'];
      syncGate();
      go('today');
      const card = document.querySelector('.gate-status');
      return {
        tag: card ? (card.querySelector('.tag') || {}).textContent || '' : '(没有闸门卡)',
        text: card ? card.textContent.replace(/\s+/g, ' ') : '',
        broken: card ? card.className.includes('gate-broken') : false,
      };
    }, acc);
    await p.close();
    return r;
  };

  console.log('\n[无障碍服务被系统关掉了 → 今天页不许再说「闸门已开」]');
  const off = await today(false);
  chk('说的是「闸门失效了」', /闸门失效/.test(off.tag), off.tag);
  chk('不再出现「闸门已开」这句假话', !/闸门已开/.test(off.text), off.text.slice(0, 90));
  chk('点名原因是系统把无障碍服务关了', /无障碍服务/.test(off.text));
  chk('给出出路（开防掉线，需要 root）', /防掉线/.test(off.text));
  chk('这一态有独立的样式类，看得见', off.broken, 'gate-broken');

  console.log('\n[无障碍服务正常 → 照旧显示闸门已开]');
  const on = await today(true);
  chk('说的是「闸门已开」', /闸门已开/.test(on.tag), on.tag);
  chk('不误报成失效', !on.broken && !/闸门失效/.test(on.text));

  // 设置面板里的防掉线状态：三态，最要命的是「开关开着、但没在跑」
  const panel = async (st) => {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const r = await p.evaluate((stJson) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      window.EQNative = {
        hasAccessibility: () => true,
        hasOverlayPermission: () => true,
        hasNotifPermission: () => true,
        gateWatchStatus: () => stJson,
        setGateWatch: () => {},
        setDeepBlock: () => {},
        backupStatus: () => '{}',
      };
      state.gate = state.gate || {};
      state.gate.rootKnown = true;
      state.gate.rootOk = true;
      state.gate.watch = JSON.parse(stJson);
      openDailySettings();
      const blocks = [...document.querySelectorAll('.sheet .block, .gate .block, .block')];
      const w = blocks.find((x) => /防掉线/.test((x.querySelector('.label') || {}).textContent || ''));
      const btn = w ? [...w.querySelectorAll('button')].map((x) => x.textContent).join(' | ') : '';
      return { txt: w ? w.textContent.replace(/\s+/g, ' ') : '(找不到防掉线那一块)', btn };
    }, JSON.stringify(st));
    await p.close();
    return r;
  };

  console.log('\n[防掉线的三种状态必须分得开]');
  const p1 = await panel({ want: false, running: false, ago: -1, rootKnown: true, rootOk: true });
  chk('没开时说「没开」', /没开/.test(p1.txt));
  chk('没开时给的是「开启防掉线」', /开启防掉线/.test(p1.btn), p1.btn);

  const p2 = await panel({ want: true, running: true, ago: 2, rootKnown: true, rootOk: true });
  chk('在跑时说「在跑」并给出心跳秒数', /在跑/.test(p2.txt) && /2 秒前/.test(p2.txt));
  chk('在跑时给的是「关掉防掉线」', /关掉防掉线/.test(p2.btn), p2.btn);

  const p3 = await panel({ want: true, running: false, ago: -1, rootKnown: true, rootOk: true });
  chk('「开关开着但它没在跑」必须写出来（最危险的那一态）',
    /开关是开的/.test(p3.txt) && /没在跑/.test(p3.txt));
  chk('这一态不许说成「在跑」或「没开」', !/在跑（/.test(p3.txt) && !/^没开。/.test(p3.txt));

  console.log('\n[承诺的边界要写在脸上，不能只在注释里]');
  chk('写明不覆盖其它无障碍服务', /不覆盖你其它无障碍服务|先读、缺了才追加/.test(p1.txt));
  chk('写明卸载后自己退出', /卸载之后它自己就退出|卸载之后.{0,8}退出/.test(p1.txt));
  chk('写明不写系统分区、不自启、不隐藏',
    /不.*往系统分区写/.test(p1.txt) && /不.*开机自启/.test(p1.txt) && /不.*隐藏自己/.test(p1.txt));

  chk('全程没有页面异常', errs.length === 0, errs.slice(0, 2).join(' / '));

  await b.close();
  console.log(`\n结果：${fail ? '失败 ' + fail + ' 项' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
