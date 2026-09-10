/* 找那个签名：content = 一个空格、finish=stop、没有 reasoning 字段。

用户贴的返回就是这个形状。它和「推理吃光额度」不一样（那种 reasoning 字段是满的），
所以不是额度问题。这里把几种可疑输入逐个打一遍，看哪一种能把那个签名复现出来：
  1. 最后一条消息是空字符串
  2. 只有 system、没有 user
  3. 历史里夹着空的 assistant
  4. 没有 system、只有 user
  5. 超长 user（上下文溢出会怎么表现）
  6. max_tokens=1 / 50（额度极小）
  7. 同一个请求连打 4 次（看有没有随机性/节流）
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
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  const cases = [
    ['最后一条是空串', [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '' }], 3000],
    ['只有 system', [{ role: 'system', content: '只输出 JSON。' }], 3000],
    ['空的 assistant 在中间', [{ role: 'system', content: '只输出 JSON。' },
      { role: 'assistant', content: '' }, { role: 'user', content: '你好' }], 3000],
    ['没有 system', [{ role: 'user', content: '你好，只输出 JSON。' }], 3000],
    ['超长 user(20000字)', [{ role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '测试'.repeat(10000) }], 3000],
    ['max_tokens=1', [{ role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '你好' }], 1],
    ['max_tokens=50', [{ role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '你好' }], 50],
    ['空 system + 空 user', [{ role: 'system', content: '' }, { role: 'user', content: '' }], 3000],
  ];

  console.log('模型 deepseek-flash');
  for (const [name, messages, maxTokens] of cases) {
    const r = await p.evaluate(async (arg) => {
      const body = JSON.stringify({ model: 'deepseek-flash', messages: arg.messages,
        response_format: { type: 'json_object' }, max_tokens: arg.maxTokens, temperature: 0.9 });
      const t0 = Date.now();
      try {
        const res = await fetch('/api/proxy', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body });
        const text = await res.text();
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        let j = null; try { j = JSON.parse(text); } catch (e) { }
        if (!j) return { sec, status: res.status, note: text.slice(0, 120) };
        const ch0 = (j.choices || [{}])[0];
        const msg = ch0.message || {};
        const c = msg.content;
        return { sec, status: res.status, finish: ch0.finish_reason,
                 contentRepr: JSON.stringify(c).slice(0, 30),
                 contentLen: typeof c === 'string' ? c.length : null,
                 reasoningLen: (msg.reasoning_content || '').length,
                 completion: j.usage && j.usage.completion_tokens,
                 errMsg: j.error && j.error.message };
      } catch (e) { return { sec: '?', note: String(e).slice(0, 120) }; }
    }, { messages, maxTokens });
    const empty = r.contentLen === 0 || (r.contentRepr === '" "') || (r.contentRepr === '""');
    console.log(`${empty ? '★空' : '     '} ${name.padEnd(20)} ${r.sec}s status=${r.status} `
      + `finish=${r.finish} content=${r.contentRepr} len=${r.contentLen} 推理=${r.reasoningLen} `
      + `completion=${r.completion}${r.errMsg ? ' err=' + String(r.errMsg).slice(0, 60) : ''}`
      + `${r.note ? ' note=' + r.note : ''}`);
  }

  console.log('\n同一个正常请求连打 4 次（看有没有随机空）：');
  for (let i = 0; i < 4; i++) {
    const r = await p.evaluate(async () => {
      const body = JSON.stringify({ model: 'deepseek-flash',
        messages: [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '说一句问候' }],
        response_format: { type: 'json_object' }, max_tokens: 3000, temperature: 0.9 });
      const res = await fetch('/api/proxy', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body });
      const j = JSON.parse(await res.text());
      const ch0 = (j.choices || [{}])[0]; const msg = ch0.message || {};
      return { finish: ch0.finish_reason, len: (msg.content || '').length,
               reasoning: (msg.reasoning_content || '').length };
    });
    console.log(`  第 ${i + 1} 次: len=${r.len} finish=${r.finish} 推理=${r.reasoning}`);
  }
  await b.close();
})();
