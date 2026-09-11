/* 「表达体检」「真实复盘」在手机里能不能用 的检查。
 *
 * 这两个模块原来调 /api/ai/checkup 和 /api/ai/replay/*，而 APK 里没有服务端——
 * 离线适配层对这三个地址一律回 503，所以**在手机上它们是死的**：
 * 实测点「体检」和「出题」都只得到一句「这是离线单文件版，不含 AI 功能」。
 *
 * 现在提示词和调用都搬到前端（走 llmCall → 原生桥 / 代理），所以断言分两层：
 *   1. **不再经过 /api/ai/***：把 window.fetch 换成一个「任何 /api/ 都报错」的桩，
 *      两个模块仍然必须跑通。这是直接复现当初那个失败条件。
 *   2. 真的走到了 llmCall，而且提示词/字段都对（看它发出的请求内容）。
 *
 * 第 1 条是关键：它用「会失败的 fetch」来证明这条路上不再依赖 fetch。
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

const CHECKUP = {
  scores: { canned: 8, overstep: 9, narcissism: 6, judge: 9, sexual: 10 },
  overall: '整体健康，但重心偏在自己身上',
  signals: [{ dim: 'narcissism', problem: '「是想见我吗」把重点落在自己身上', fix: '换成问她这条裙子' }],
  why_greasy: '不算油，只是有点自我中心',
  revised: ['这条裙子很适合你', '你今天这个颜色好看'],
  principle: '把注意力放在对方身上，比放在对方对你的反应上安全得多',
  confidence: '中',
};

const REPLAY_Q = {
  summary: '你连问三句，对方只回了一个字',
  questions: [{ q: '「没干嘛」这句最可能是？', options: ['字面意思，就是没事', '不想接话', '在忙'], answer_index: 1, why: '连着三句问句只回一个字' }],
  note: '',
};

const REPLAY_R = {
  score_line: '第一题判断对了',
  turn_point: '分水岭是那句「没干嘛」',
  readings: [{ quote: '没干嘛', face_value: '没事做', possible: '不想继续这个话题', confidence: '中', signals: '回复只有一个词' }],
  your_part: [{ quote: '在干嘛呢', effect: '看起来像查岗' }],
  options: [{ move: '承接情绪', direction: '先说自己的事，把话题递回去' }],
  principle: '连问三句之前先给一句自己的东西',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);

  /* 直接复现当初的失败条件：任何 /api/ 请求都失败。
     如果这两个模块还在走 /api/ai/*，下面必然拿到错误。 */
  await p.evaluate((sc) => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.__reqs = [];
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: false, asr: false, http: true, mic: false }),
      httpPost: async (id, url, headersJson, body) => {
        const j = JSON.parse(body);
        window.__reqs.push({ url, model: j.model, messages: j.messages, max_tokens: j.max_tokens });
        /* 按提示词判断该回哪一份假数据。看**整段请求**，不是只看 messages[0]：
           2.42 把真实复盘的任务说明从 system 挪到了后面的消息里（目的是让出题和揭晓
           共用同一段前缀、拿到缓存价）。只看 messages[0] 的话，假数据会认错——
           把「揭晓」那份回给了「出题」这一步，于是流程走到一半就停住。
           假数据该跟着**内容**走，不该跟着**位置**走。 */
        const all = JSON.stringify(j.messages);
        const out = /表达体检/.test(all) ? sc.checkup
          : /先出题让他自己判断/.test(all) ? sc.q : sc.r;
        window.__onHttp(id, JSON.stringify({
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }),
        }));
      },
    };
    V.native = window.EQNative;
    V.caps = { tts: false, asr: false, http: true, mic: false };
    saveSettings({ apiKey: 'sk-test-not-real', model: 'deepseek-chat' });
    // 万一还有代码走 fetch，让它必然失败
    const orig = window.fetch;
    window.fetch = (u, i) => {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      if (url.indexOf('/api/') === 0) {
        window.__fetchApi = (window.__fetchApi || []).concat([url]);
        return Promise.reject(new Error('离线版没有这个接口'));
      }
      return orig(u, i);
    };
  }, { checkup: CHECKUP, q: REPLAY_Q, r: REPLAY_R });

  console.log('\n[表达体检：填一句话 → 必须出结果]');
  const ck = await p.evaluate(async () => {
    go('ai'); setAiSubview('checkup');
    document.getElementById('ckText').value = '今天这条裙子很好看，是想见我吗？';
    document.getElementById('ckCtx').value = '认识两个月，单独出来过五次';
    await runCheckup();
    const out = document.getElementById('ckOut').textContent;
    return { out, reqs: window.__reqs.slice(), fetchApi: window.__fetchApi || [] };
  });
  chk('体检出结果了（不再是一句「离线版不含 AI」）',
    !/离线单文件版|没能完成/.test(ck.out) && /整体健康/.test(ck.out),
    ck.out.replace(/\s+/g, ' ').slice(0, 70));
  chk('渲染出了五维分数', /罐头度|越级度|自恋度|评判度|性暗示度/.test(ck.out));
  chk('渲染出了改法', /怎么改/.test(ck.out));
  chk('全程没有走 /api/ai/*（用会失败的 fetch 验证的）',
    ck.fetchApi.length === 0, ck.fetchApi.join(', '));
  chk('真的调了一次模型', ck.reqs.length === 1, `${ck.reqs.length} 次`);
  chk('用的是设置里那个模型', (ck.reqs[0] || {}).model === 'deepseek-chat', String((ck.reqs[0] || {}).model));
  chk('提示词是体检那份（五维度说明在里面）',
    /canned 罐头度/.test(((ck.reqs[0] || {}).messages || [{}])[0].content || ''));
  chk('用户那句话进了请求', /是想见我吗/.test(JSON.stringify((ck.reqs[0] || {}).messages || [])));
  chk('体检的额度是 4000（不是对话那个 3000）', (ck.reqs[0] || {}).max_tokens === 4000,
    String((ck.reqs[0] || {}).max_tokens));

  console.log('\n[真实复盘：贴记录 → 出题 → 揭晓]');
  const rp1 = await p.evaluate(async () => {
    go('ai'); setAiSubview('replay');
    document.getElementById('rpChat').value = '我：在吗\n她：嗯\n我：在干嘛呢\n她：没干嘛';
    await runReplayQuestions();
    return { out: document.getElementById('view').textContent.replace(/\s+/g, ' ').slice(-300),
             reqs: window.__reqs.slice() };
  });
  chk('出题这一步跑通了',
    !/没能完成/.test(rp1.out) && /字面意思/.test(rp1.out),
    rp1.out.slice(-90));
  /* 断言的是「那句话在提示词里」，不是「它在 messages[0]」。
     2.42 把任务说明从 system 挪到了记录后面（为了让两次调用共用前缀、拿到缓存价），
     位置是允许变的；但这句话本身必须还在——那才是这条断言守的东西。 */
  chk('出题用的是出题那份提示词',
    /先出题让他自己判断/.test(JSON.stringify(rp1.reqs[rp1.reqs.length - 1].messages)));
  chk('出题没有走 /api/ai/*',
    (await p.evaluate(() => (window.__fetchApi || []).length)) === 0);

  const rp2 = await p.evaluate(async () => {
    // 答第一题然后揭晓
    const btn = [...document.querySelectorAll('#view button')].find((b) => /^A|字面意思/.test(b.textContent.trim()));
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 100));
    const next = [...document.querySelectorAll('#view button')].find((b) => /揭晓|看分析|提交|完成/.test(b.textContent));
    if (next) next.click();
    else if (typeof runReplayReveal === 'function') await runReplayReveal();
    await new Promise((r) => setTimeout(r, 400));
    return { out: document.getElementById('view').textContent.replace(/\s+/g, ' ').slice(-320),
             reqs: window.__reqs.slice(),
             fetchApi: window.__fetchApi || [] };
  });
  chk('揭晓这一步也跑通了', /分水岭|判断对了|承接情绪/.test(rp2.out), rp2.out.slice(-90));
  chk('揭晓用的是揭晓那份提示词，且额度 5000',
    JSON.stringify(rp2.reqs[rp2.reqs.length - 1].messages).includes('已经先自己答过一遍')
      && rp2.reqs[rp2.reqs.length - 1].max_tokens === 5000,
    String(rp2.reqs[rp2.reqs.length - 1].max_tokens));
  chk('两个模块全程都没有一个 /api/ 请求', rp2.fetchApi.length === 0, rp2.fetchApi.join(', '));

  console.log('\n[错误也要给人话]');
  const bad = await p.evaluate(async () => {
    window.EQNative.httpPost = async (id) => {
      window.__onHttp(id, JSON.stringify({ status: 401, body: '{"error":{"message":"Authentication Fails"}}' }));
    };
    saveSettings({ apiKey: 'sk-bad' });
    go('ai'); setAiSubview('checkup');
    document.getElementById('ckText').value = '随便一句';
    await runCheckup();
    return document.getElementById('ckOut').textContent;
  });
  chk('密钥不对时说明是密钥问题（不是白屏）',
    /401|密钥/.test(bad), bad.replace(/\s+/g, ' ').slice(0, 70));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
