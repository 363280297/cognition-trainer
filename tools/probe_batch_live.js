/* 真打一次「让 AI 现造 3 个」，看返回能不能被解析、三个是不是真的不一样。

为什么必须真打：这一段是**提示词 + 解析**两头都得对上的活。
提示词写歪了，模型给三个换汤不换药的；解析写窄了，模型给个数组或者
数字键的对象，界面上就是"没造成"——而这两件事静态检查都看不出来。
需要 server.py 在跑（密钥从 .env 读）。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    saveSettings({ apiKey: 'proxy-uses-env', model: 'deepseek-chat', autoSpeak: false });
    V.sess = null; setAiSubview('voice');
  });
  await p.waitForTimeout(300);

  console.log('—— 真打一次「现造 3 个」——');
  const t0 = Date.now();
  const r = await p.evaluate(async () => {
    // 直接调 buildSceneBatch（它内部走 llmCall），然后把 sceneBatch 和报错都拿出来
    let err = '';
    const savedToast = window.toast;
    window.toast = (m) => { err = String(m); };
    await buildSceneBatch();
    window.toast = savedToast;
    const msg = document.getElementById('sceneMsg');
    return {
      list: (sceneBatch || []).map((s) => ({
        title: s.title, stage: s.stage, diff: s.difficulty, ta: s.ta,
        opening: s.opening, goal: s.goal, her: (s.her || '').slice(0, 30),
        id: s.id,
      })),
      msg: msg ? msg.textContent : '',
      err,
      cards: document.querySelectorAll('.batch-card').length,
    };
  });
  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  console.log(`解析出 ${r.list.length} 个，界面上摆了 ${r.cards} 张卡`);
  r.list.forEach((s, i) => {
    console.log(`\n[${i + 1}] ${s.title}（${s.stage} · 难度 ${s.diff} · ${s.ta}）`);
    console.log(`    对方：${s.her}…`);
    console.log(`    开场：「${s.opening}」`);
    console.log(`    要练：${s.goal}`);
  });
  // 三个是不是真的"不一样"
  const titles = r.list.map((s) => s.title);
  const openings = r.list.map((s) => s.opening);
  const stages = r.list.map((s) => s.stage);
  console.log('\n标题互不相同:', new Set(titles).size === titles.length);
  console.log('开场白互不相同:', new Set(openings).size === openings.length);
  console.log('关系阶段互不相同:', new Set(stages).size, '种');
  console.log('页面提示:', r.msg);
  console.log('页面错误:', errs.length ? errs.slice(0, 2) : '无');
  await b.close();
})();
