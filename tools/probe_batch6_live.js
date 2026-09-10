/* 真打接口，验的是**App 里现在这套**（不是另写一份提示词来验）：
   连造两轮 6 个，中间不清理，看四件事——
     1) 一轮要等多久（基线：造 3 个测到过 20 秒，另一次 6 个 9.5 秒）；
     2) 缺口表在两轮之间会不会自己挪（第一轮补完了，第二轮该去补别的）；
     3) 去重是不是真的生效（第二轮不许跟第一轮/现成的撞）；
     4) 硬规则模型买不买账：关系是否分散、her_state 是否解释了 opening、
        有没有把"一桌人"这种这台引擎演不了的场景造出来。
   需要 server.py 在跑（密钥从 .env 读）。只打印，不写仓库里的任何东西。
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
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    saveSettings({ apiKey: 'proxy-uses-env', model: 'deepseek-chat', autoSpeak: false });
    state.genScenes = []; state.scenes = {};
    go('ai'); setAiSubview('voice');
  });

  const before = await p.evaluate(() => sceneGap().order);
  console.log(`\n开始前·缺口顺序：${before.join(' > ')}`);

  for (let round = 1; round <= 2; round++) {
    const t0 = Date.now();
    const r = await p.evaluate(async () => {
      const brief = sceneBrief(BATCH_N, null);
      await buildSceneBatch();
      return { brief, msg: (document.getElementById('sceneMsg') || {}).textContent || '',
               n: genScenes().length, gap: sceneGap().order,
               last: genScenes().slice(-6) };
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n════════ 第 ${round} 轮：${secs} 秒，库里累计 ${r.n} 个 ════════`);
    console.log(`界面消息：${r.msg}`);
    console.log(`这一轮点名的关系：${(r.brief.match(/最少的：([^\n]+)/) || [])[1] || '?'}`);
    console.log(`造完之后的缺口顺序：${r.gap.join(' > ')}`);
    r.last.forEach((s, i) => {
      console.log(`\n  ${round}.${i + 1} ${s.title}（${s.stage} · 难度 ${s.difficulty} · ${s.ta} · 主题 ${s.theme || '—'}）`);
      console.log(`     她是谁  ：${s.her}`);
      console.log(`     开场白  ：「${s.opening}」`);
      console.log(`     心里想的：${s.her_state}`);
      console.log(`     要办的事：${s.goal}`);
      console.log(`     最容易错：${s.trap}`);
    });
  }

  const sum = await p.evaluate(() => {
    const all = genScenes();
    const preset = (CONTENT.scenarios.scenarios || []).map((x) => sceneKey(x));
    return {
      n: all.length,
      titles: all.map((x) => x.title),
      dupWithPreset: all.filter((x) => preset.indexOf(sceneKey(x)) >= 0).map((x) => x.title),
      dupInside: (() => {
        const seen = {}, dup = [];
        all.forEach((x) => { const k = sceneKey(x); if (seen[k]) dup.push(x.title); seen[k] = 1; });
        return dup;
      })(),
      byStage: (() => { const m = {}; all.forEach((x) => { m[x.stage] = (m[x.stage] || 0) + 1; }); return m; })(),
      byDiff: (() => { const m = {}; all.forEach((x) => { m[x.difficulty] = (m[x.difficulty] || 0) + 1; }); return m; })(),
      noTheme: all.filter((x) => !x.theme).length,
      empty: all.filter((x) => !x.her || !x.her_state || !x.opening || !x.goal || !x.trap).length,
      stored: (JSON.parse(localStorage.getItem('eq-state-v2') || '{}').genScenes || []).length,
    };
  });

  console.log('\n════════ 汇总 ════════');
  console.log(`库里 ${sum.n} 个；存档里 ${sum.stored} 个（能跟着备份走）`);
  console.log(`关系分布：${JSON.stringify(sum.byStage)}`);
  console.log(`难度分布：${JSON.stringify(sum.byDiff)}`);
  console.log(`与现成 14 个重名的：${sum.dupWithPreset.join('、') || '无'}`);
  console.log(`库内部重名的：${sum.dupInside.join('、') || '无'}`);
  console.log(`没给 theme 的：${sum.noTheme} 个；字段不全的：${sum.empty} 个`);
  console.log(errs.length ? `页面报错：${errs.join(' | ')}` : '页面报错：无');
  await b.close();
})();
