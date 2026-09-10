/* 量一局对话到底花多少 token。
 *
 * 关键点：量的是**App 真实发出去的请求**，不是我在别处复刻的提示词。
 * 做法是把 Node 侧的一个真发请求的函数暴露给页面（page.exposeFunction），
 * 让 App 的原生桥桩直接调它——这样提示词、历史、字段全部是 App 自己拼的，
 * 而 usage 是服务端真实返回的。
 *
 * 一局里会有几次调用：
 *   · 建场景（如果走「随机」或「自己写」这条路）
 *   · 每一轮对话各一次（免提下就是你说一句算一轮）
 *   · 结束时的复盘一次
 * 第 0 轮（她的开场白）是本地拼的，不调模型——所以不计费。
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
const N_TURNS = Number(process.env.EQ_TURNS || 8);

/* 一局的用户台词：长度和口语程度按真实情况来（短句为主，偶尔长一点） */
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

(async () => {
  if (!KEY) { console.log('没有密钥，跳过'); process.exit(0); }
  const calls = [];
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });

  // 把「真发请求」交给 Node：页面里没有 CORS 限制，Node 里也没有
  await p.exposeFunction('__realHttp', async (bodyJson) => {
    const t0 = Date.now();
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: bodyJson,
    });
    const text = await r.text();
    let u = null, model = '', msgs = 0, chars = 0;
    try {
      const j = JSON.parse(bodyJson);
      model = j.model; msgs = (j.messages || []).length;
      chars = JSON.stringify(j.messages || []).length;
    } catch (e) { }
    try { u = (JSON.parse(text).usage) || null; } catch (e) { }
    calls.push({ ms: Date.now() - t0, status: r.status, model, msgs, reqChars: chars, usage: u });
    return JSON.stringify({ status: r.status, body: text });
  });

  await p.goto(pathToFileURL(path.join(ROOT, '认知训练-离线版.html')).href, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  // Playwright 的 evaluate 只收一个参数，多个要包成对象
  await p.evaluate(({ key, model }) => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    saveSettings({ apiKey: key, model: model });
    // 原生桥的桩：只替换 httpPost，其余照旧走页面内逻辑
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: false, asr: false, http: true, mic: false }),
      httpPost: async (id, url, headersJson, body) => {
        const res = await window.__realHttp(body);
        window.__onHttp(id, res);
      },
    };
    V.native = window.EQNative;
    V.caps = { tts: false, asr: false, http: true, mic: false };
  }, { key: KEY, model: process.env.EQ_MODEL || 'deepseek-chat' });

  // ---- 1) 建场景 ----
  const before = calls.length;
  const sc = await p.evaluate(async () => {
    const s = await buildScenario('同事在群里当着大家的面否了我的方案，我想练一句不软不硬的回应');
    return { title: s.title, opening: s.opening, ta: s.ta };
  });
  const scenarioCalls = calls.length - before;
  console.log('\n[建场景] ' + sc.title + '（' + scenarioCalls + ' 次调用）');

  // ---- 2) 跑一局对话 ----
  const turns = LINES.slice(0, N_TURNS);
  await p.evaluate(async (sc2) => { await startSession(sc2); }, sc);
  console.log('  「' + sc.opening + '」（她的开场白，本地拼的，不花 token）');
  for (let i = 0; i < turns.length; i++) {
    await p.evaluate(async (line) => { await userSaid(line); }, turns[i]);
    const c = calls[calls.length - 1] || {};
    const u = c.usage || {};
    console.log(`  第 ${i + 1} 轮  你说「${turns[i]}」`);
    console.log(`           请求 ${c.msgs} 条消息 / ${c.reqChars} 字符  `
      + `→ 输入 ${u.prompt_tokens ?? '?'} + 输出 ${u.completion_tokens ?? '?'} = ${u.total_tokens ?? '?'}  `
      + `${(c.ms / 1000).toFixed(1)}s`);
  }

  // ---- 3) 复盘 ----
  await p.evaluate(() => { endSession(); });
  await p.waitForTimeout(9000);
  console.log('\n[复盘] 结束后这一次调用');

  // ---- 汇总 ----
  const ok = calls.filter((c) => c.usage);
  const sum = (k) => ok.reduce((a, c) => a + (c.usage[k] || 0), 0);
  const cacheHit = ok.reduce((a, c) => a + (c.usage.prompt_cache_hit_tokens || 0), 0);
  const cacheMiss = ok.reduce((a, c) => a + (c.usage.prompt_cache_miss_tokens || 0), 0);
  const totalIn = sum('prompt_tokens'), totalOut = sum('completion_tokens');

  console.log('\n' + '='.repeat(64));
  console.log(`一局（建场景 1 + 对话 ${turns.length} 轮 + 复盘 1）= ${calls.length} 次调用`);
  console.log('='.repeat(64));
  console.log(`  输入 token   合计 ${totalIn}   平均 ${Math.round(totalIn / Math.max(ok.length, 1))}/次`);
  console.log(`  输出 token   合计 ${totalOut}  平均 ${Math.round(totalOut / Math.max(ok.length, 1))}/次`);
  console.log(`  总计         ${totalIn + totalOut}`);
  if (cacheHit || cacheMiss) {
    console.log(`  其中缓存命中 ${cacheHit} / 未命中 ${cacheMiss}`
      + `（命中率 ${Math.round(cacheHit / Math.max(cacheHit + cacheMiss, 1) * 100)}%）`);
  }
  console.log('\n  逐次明细：');
  calls.forEach((c, i) => {
    const u = c.usage || {};
    console.log(`   ${String(i + 1).padStart(2)}. ${String(c.msgs).padStart(2)} 条消息  `
      + `${String(u.prompt_tokens ?? '-').padStart(5)} in / ${String(u.completion_tokens ?? '-').padStart(4)} out`
      + `  ${(c.ms / 1000).toFixed(1)}s  ${c.status}`);
  });
  const sizes = ok.map((c) => JSON.stringify(c.usage).length);
  fs.writeFileSync(path.join(__dirname, '.cache_tokens.json'),
    JSON.stringify({ calls, totalIn, totalOut, cacheHit, cacheMiss, sizes: sizes.length }, null, 1));
  console.log('\n（明细已写到 tools/.cache_tokens.json）');
  await b.close();
})();
