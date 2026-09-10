/* 量「一个场景从头到尾」花多少钱，并把刚修好的两个模块也算进去。
 *
 * 做法和 measure_tokens.js 一样：把 Node 侧的真发请求函数暴露给页面，
 * 让 App 的原生桥桩调它——量的就是 App 真实发出的请求，usage 是服务端返回的。
 *
 * 计量范围（用户问的「一个场景完成之后」）：
 *   1. 建场景        1 次
 *   2. 场景对话 N 轮   N 次（每轮一次）
 *   3. 结束后的复盘    1 次
 *   4. 表达体检       1 次（可选，但既然刚修好就一起量）
 *   5. 真实复盘       2 次（出题 + 揭晓）
 * 第 0 轮她的开场白是本地拼的，不调模型、不计费。
 *
 * 价格按 2026-09-10 官方 Flash 系列（deepseek-chat 属于这个系列）：
 *   空闲：输入命中 0.02 / 未命中 1 / 输出 4（元每百万 token）
 *   高峰：输入命中 0.04 / 未命中 2 / 输出 8
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const ROOT = path.join(__dirname, '..');

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  for (const p of [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')]) {
    if (fs.existsSync(p)) {
      for (const ln of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (ln.startsWith('DEEPSEEK_API_KEY=')) return ln.split('=')[1].trim();
      }
    }
  }
  return '';
}
const KEY = loadKey();
const TURNS = Number(process.env.EQ_TURNS || 8);

const LINES = [
  '你到了有一会儿了吧？我刚停车找了半天。',
  '这个位置好找吗',
  '我看你朋友圈发过那个展，是上个月去的吗？',
  '对，那个展我也去了，人特别多',
  '你平时周末都干嘛',
  '那下次可以一起去，我知道几个不用排队的地方',
  '嗯……你看起来不太想聊这个，那我们说点别的',
  '今天跟你聊天挺舒服的，就是有点紧张，怕说错话',
];

// 2026-09-10 Flash 系列价（元/百万 token）
const PRICE = {
  off: { hit: 0.02, miss: 1, out: 4 },
  peak: { hit: 0.04, miss: 2, out: 8 },
};
function cost(u, tier) {
  const p = PRICE[tier];
  const hit = u.prompt_cache_hit_tokens || 0;
  const miss = u.prompt_cache_miss_tokens != null
    ? u.prompt_cache_miss_tokens : Math.max(0, (u.prompt_tokens || 0) - hit);
  return hit / 1e6 * p.hit + miss / 1e6 * p.miss + (u.completion_tokens || 0) / 1e6 * p.out;
}

(async () => {
  if (!KEY) { console.log('没有密钥，跳过'); process.exit(0); }
  const calls = [];
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });

  await p.exposeFunction('__realHttp', async (bodyJson) => {
    const t0 = Date.now();
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: bodyJson,
    });
    const text = await r.text();
    let step = '?', u = null;
    try {
      const j = JSON.parse(bodyJson);
      const sys = ((j.messages || [])[0] || {}).content || '';
      const user = ((j.messages || [])[j.messages.length - 1] || {}).content || '';
      const last = (j.messages || [])[j.messages.length - 1] || {};
      const isConv = j.messages && j.messages.length > 2 && /每一轮你返回一个 JSON/.test(sys);
      step = /建造「对话练习场景」/.test(sys) ? '建场景'
        : /表达体检/.test(sys) ? '表达体检'
          : /先出题让他自己判断/.test(sys) ? '复盘·出题'
            : /已经先自己答过一遍/.test(sys) ? '复盘·揭晓'
              : /对话练习.*做复盘|你在给一次/.test(sys) ? '对话后复盘'
                : isConv ? '对话一轮' : '其它';
      if (/你在做一次「对话练习」的复盘|给一次「对话练习」做复盘/.test(sys)) step = '对话后复盘';
    } catch (e) { }
    try { u = (JSON.parse(text).usage) || null; } catch (e) { }
    calls.push({ step, ms: Date.now() - t0, status: r.status, usage: u });
    return JSON.stringify({ status: r.status, body: text });
  });

  await p.goto(pathToFileURL(path.join(ROOT, '认知训练-离线版.html')).href, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.evaluate(({ key }) => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    saveSettings({ apiKey: key, model: 'deepseek-chat' });
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: false, asr: false, http: true, mic: false }),
      httpPost: async (id, url, headersJson, body) => {
        window.__onHttp(id, await window.__realHttp(body));
      },
    };
    V.native = window.EQNative;
    V.caps = { tts: false, asr: false, http: true, mic: false };
  }, { key: KEY });

  // 1) 建场景
  const sc = await p.evaluate(async () => {
    const s = await buildScenario('同事在群里当着大家的面否了我的方案，我想练一句不软不硬的回应');
    return { title: s.title, opening: s.opening };
  });
  console.log(`\n场景：「${sc.title}」`);

  // 2) 对话
  await p.evaluate(async (s) => { await startSession(s); }, sc);
  for (const line of LINES.slice(0, TURNS)) {
    await p.evaluate(async (l) => { await userSaid(l); }, line);
  }

  // 3) 对话后复盘
  await p.evaluate(() => { endSession(); });
  await p.waitForTimeout(12000);

  // 4) 表达体检
  await p.evaluate(async () => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    go('ai'); setAiSubview('checkup');
    document.getElementById('ckText').value = '今天这条裙子很好看，是想见我吗？';
    document.getElementById('ckCtx').value = '认识两个月，单独出来过五次';
    await runCheckup();
  });
  await p.waitForTimeout(500);

  // 5) 真实复盘（出题 + 揭晓）
  await p.evaluate(async () => {
    go('ai'); setAiSubview('replay');
    document.getElementById('rpChat').value = '我：在吗\n她：嗯\n我：在干嘛呢\n她：没干嘛';
    await runReplayQuestions();
  });
  await p.waitForTimeout(500);
  await p.evaluate(async () => {
    const btn = [...document.querySelectorAll('#view button')].find((b) => /^A|字面意思/.test(b.textContent.trim()));
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 120));
    await runReplayReveal();
  });
  await p.waitForTimeout(500);

  // ---------------- 汇总 ----------------
  const ok = calls.filter((c) => c.usage);
  const byStep = {};
  ok.forEach((c) => {
    const s = byStep[c.step] = byStep[c.step] || { n: 0, in: 0, out: 0, hit: 0, miss: 0, ms: 0, off: 0, peak: 0 };
    const u = c.usage;
    s.n++;
    s.in += u.prompt_tokens || 0;
    s.out += u.completion_tokens || 0;
    s.hit += u.prompt_cache_hit_tokens || 0;
    s.miss += u.prompt_cache_miss_tokens || 0;
    s.ms += c.ms;
    s.off += cost(u, 'off');
    s.peak += cost(u, 'peak');
  });
  const tot = Object.values(byStep).reduce((a, s) => ({
    n: a.n + s.n, in: a.in + s.in, out: a.out + s.out, hit: a.hit + s.hit,
    miss: a.miss + s.miss, ms: a.ms + s.ms, off: a.off + s.off, peak: a.peak + s.peak,
  }), { n: 0, in: 0, out: 0, hit: 0, miss: 0, ms: 0, off: 0, peak: 0 });

  console.log('\n' + '='.repeat(72));
  console.log('一步花多少（deepseek-chat，2026-09-10 价）');
  console.log('='.repeat(72));
  console.log('  步骤            次数   输入    输出   缓存命中  空闲时段    高峰时段');
  Object.entries(byStep).forEach(([k, s]) => {
    console.log(`  ${k.padEnd(14)} ${String(s.n).padStart(3)}  ${String(s.in).padStart(6)} ${String(s.out).padStart(6)}`
      + `  ${String(Math.round(s.hit / Math.max(s.hit + s.miss, 1) * 100)).padStart(6)}%`
      + `  ${s.off.toFixed(5).padStart(8)} 元 ${s.peak.toFixed(5).padStart(8)} 元`);
  });
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'合计'.padEnd(14)} ${String(tot.n).padStart(3)}  ${String(tot.in).padStart(6)} ${String(tot.out).padStart(6)}`
    + `  ${String(Math.round(tot.hit / Math.max(tot.hit + tot.miss, 1) * 100)).padStart(6)}%`
    + `  ${tot.off.toFixed(5).padStart(8)} 元 ${tot.peak.toFixed(5).padStart(8)} 元`);
  console.log(`\n  总耗时（不含你思考和说话）${(tot.ms / 1000).toFixed(1)} 秒`);
  console.log(`  一次完整练习成本：空闲 ${(tot.off * 100).toFixed(2)} 分钱 ／ 高峰 ${(tot.peak * 100).toFixed(2)} 分钱`);

  // 只算「一个场景从头到尾」（建场景+对话+复盘，不含体检和真实复盘）
  const scene = ['建场景', '对话一轮', '对话后复盘'].reduce((a, k) => {
    const s = byStep[k] || { off: 0, peak: 0, n: 0, in: 0, out: 0 };
    return { off: a.off + s.off, peak: a.peak + s.peak, n: a.n + s.n, in: a.in + s.in, out: a.out + s.out };
  }, { off: 0, peak: 0, n: 0, in: 0, out: 0 });
  console.log(`\n  ★ 只算「一个场景」=${scene.n} 次调用：`
    + `空闲 ${(scene.off * 100).toFixed(2)} 分 ／ 高峰 ${(scene.peak * 100).toFixed(2)} 分`
    + `（输入 ${scene.in} + 输出 ${scene.out} token）`);
  console.log('\n  按这个数推算（只用场景对话，一天 N 局）：');
  [1, 2, 5, 10].forEach((n) => {
    console.log(`    ${String(n).padStart(2)} 局/天 → 空闲约 ${(scene.off * n * 30).toFixed(2)} 元/月`
      + ` ／ 高峰约 ${(scene.peak * n * 30).toFixed(2)} 元/月`);
  });

  fs.writeFileSync(path.join(__dirname, '.cache_cost.json'),
    JSON.stringify({ byStep, tot, scene, calls }, null, 1));
  console.log('\n（明细写到 tools/.cache_cost.json）');
  await b.close();
})();
