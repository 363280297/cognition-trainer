/* 复盘传截图：**真打一次视觉接口**（App 自己的代码路径，不桩 llmCall）。

为什么要单独一个：`check_replay_shot.js` 那 34 条断言把 `llmCall` 换成了桩，
验的是"请求形状对不对"；而"这个模型名认不认、图能不能真读出来"它验不了。
开发机上那把旧 key 失效（401），所以这一环一直空着。用户给了新 key，这里补上。

走的是**和手机一样的代码**：`ocrChatShots` → `llmCall`，只是手机上过原生桥，
这里过 `server.py` 的 `/api/proxy`（浏览器里没有原生桥时就是这条路）。

需要 server.py 在跑（它从上级 .env 读密钥，密钥不进浏览器）：
    py -3 server.py &
    node tools/probe_shot_ocr_live.js

不打印密钥。会真实消耗一点额度（一张图约 2~3k token）。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');

const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const URL = process.env.EQ_URL || 'http://127.0.0.1:8787/';
const SHOT = path.join(__dirname, '..', 'output', 'fake-chat.png');

// fake-chat.png 里的原话（判定 OCR 有没有真读出来）
const TRUTH = ['工作上出问题', '没人说话', '我在啊', '在地铁上'];

(async () => {
  if (!fs.existsSync(SHOT)) {
    console.log(`  跳过：找不到 ${SHOT}（它是模拟器那一轮用的测试截图）`);
    process.exit(0);
  }
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 412, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
  // 启动时的浮层会挡住点击：每日闸门（`.gate`）和「要不要放点声音」（`.sheet open`）。
  // 后者每次进 App 都问一次，全屏盖住，点什么都点不到——在模拟器上就是这么连偏三次的。
  // 其它脚本用的是这个更全的选择器（只摘 `.gate` 会漏掉 sheet，属于"碰巧能过"）。
  await p.evaluate(() => document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()));
  await p.waitForTimeout(1500);

  // 进「真实复盘」
  await p.evaluate(() => { go('ai'); });
  await p.waitForTimeout(400);
  await p.evaluate(() => { setAiSubview('replay'); });
  await p.waitForTimeout(400);
  const hasBtn = await p.evaluate(() => !!document.getElementById('rpShotBtn'));
  console.log(`  复盘页就绪：上传按钮 ${hasBtn ? '在' : '不在'}`);

  // ---- 走 App 真实的处理链 -------------------------------------------------
  // `#shotInput` 是**点了按钮才创建的**（这是那条"点了没反应"的教训的产物），
  // 所以先点一下按钮再喂文件。headless 里点隐藏的 file input 不会弹窗，
  // Playwright 会接管 setInputFiles。
  console.log('\n[真打一次：把聊天截图交给 App 自己的 OCR 链]');
  const t0 = Date.now();
  await p.evaluate(() => {
    document.getElementById('rpChat').value = '';
    window.__done = null;
    const orig = window.shotDone;
    window.shotDone = function (r, why) { window.__done = { r, why }; orig(r, why); };
  });
  // 点「上传聊天截图」。那张「要不要放点声音」浮层是**异步**再打开的
  // （开页时摘掉它，过一会儿它又建了一张新的），所以这里：
  //   先再摘一次 → 试真点击 → 被拦就退回 JS click。
  // 用 JS click 不影响这个探针的目的：它验的是"选完图之后 OCR 这条链通不通"，
  // 而"按钮能不能被点到"由 check_replay_shot 用真点击盯着。
  await p.evaluate(() => document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()));
  let clickMode = '真点击';
  try {
    await p.click('#rpShotBtn', { timeout: 8000 });
  } catch (e) {
    clickMode = 'JS click（浮层又弹回来了，真点击被拦）';
    await p.evaluate(() => document.getElementById('rpShotBtn').click());
  }
  await p.waitForTimeout(300);
  console.log(`  按钮触发方式：${clickMode}`);
  const inputThere = await p.evaluate(() => !!document.getElementById('shotInput'));
  console.log(`  点了按钮之后隐藏 input ${inputThere ? '已创建' : '没创建'}`);
  await p.setInputFiles('#shotInput', SHOT);
  // 视觉模型有推理 token，慢一点；最多等 150 秒
  for (let i = 0; i < 75; i++) {
    const d = await p.evaluate(() => window.__done);
    if (d) break;
    await p.waitForTimeout(2000);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = await p.evaluate(() => ({
    done: window.__done,
    state: document.getElementById('rpShotState').textContent,
    box: document.getElementById('rpChat').value,
    btnEnabled: !document.getElementById('rpShotBtn').disabled,
  }));

  if (!out.done) {
    console.log(`  ✗ ${secs}s 内没等到结果（超时）。界面提示：${out.state.slice(0, 100)}`);
  } else if (!out.done.r) {
    console.log(`  ✗ 识别失败：${out.done.why}`);
  } else {
    console.log(`  ✓ ${secs}s 拿到结果（${out.done.r.parts} 张图切段）`);
    console.log('  抄出来的文字：');
    console.log('  ' + out.box.split('\n').join('\n  '));
    const hit = TRUTH.filter((t) => out.box.includes(t));
    console.log(`  命中真值 ${hit.length}/${TRUTH.length}：${JSON.stringify(hit)}`);
    console.log(`  提示语：${out.state.slice(0, 80)}`);
    console.log(`  按钮已恢复可用：${out.btnEnabled}`);
    console.log(hit.length === TRUTH.length
      ? '  → 结论：视觉这条路**真的能读中文聊天截图**'
      : '  → 有字没读对，需要看提示词或图片预处理');
  }

  // ---- 再验一次"原生的真实形状"：字符串 payload + 同一张图 ------------------
  // 手机上原生就是这么发的（JSONObject.quote 包成字符串），所以这一条最接近真机。
  // 原图在 Node 这边读成 dataURL 再塞进去，省掉原生那步降采样（对 OCR 只会更清楚）。
  console.log('\n[再按原生的形状调一次桥（JSON 字符串 + 同一张真图）]');
  const dataUrlPng = 'data:image/png;base64,' + fs.readFileSync(SHOT).toString('base64');
  await p.evaluate(() => {
    document.getElementById('rpChat').value = '';
    document.getElementById('rpShotState').innerHTML = '';
    window.__done = null;
  });
  const t1 = Date.now();
  await p.evaluate((u) => {
    // 注意这里**故意传字符串**——原生发的就是字符串，这正是那个静默 bug 的形状
    window.__onShot(JSON.stringify({ ok: true, dataUrl: u }));
  }, dataUrlPng);
  for (let i = 0; i < 75; i++) {
    const d = await p.evaluate(() => window.__done);
    if (d) break;
    await p.waitForTimeout(2000);
  }
  const b2 = await p.evaluate(() => ({
    done: window.__done,
    state: document.getElementById('rpShotState').textContent,
    box: document.getElementById('rpChat').value,
  }));
  console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (b2.done && b2.done.r) {
    const hit2 = TRUTH.filter((t) => b2.box.includes(t));
    console.log(`  ✓ 桥这条路也通了（${b2.done.r.parts} 张图），命中真值 ${hit2.length}/${TRUTH.length}`);
  } else {
    console.log(`  ✗ 桥这条路：${b2.done ? b2.done.why : '超时'}｜提示语：${b2.state.slice(0, 80)}`);
  }

  console.log(`\n  JS 报错：${errs.length ? errs.slice(0, 2).join(' | ') : '无'}`);
  await b.close();
  process.exit(0);
})();
