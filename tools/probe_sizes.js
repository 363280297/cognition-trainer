/* 输入越大越容易出问题吗？按长度梯度打一遍。

线索：前面「超长 user(20000 字)」那一格返回的是 {"type":"json_object"}
——合法 JSON，但不是答案。真实复盘里用户会**粘贴整段聊天记录**，
体检里会粘贴整段话，这些都可能很长。所以按长度分档看拐点在哪。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const SIZES = [2000, 6000, 12000, 24000, 48000];

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  for (const size of SIZES) {
    const r = await p.evaluate(async (n) => {
      // 造一段像聊天记录的长文本（真实复盘/体检里就是这种）
      const line = '她：今天好累啊，项目一直改需求，烦死了。\n我：早点睡。\n';
      let text = '';
      while (text.length < n) text += line;
      const messages = [
        { role: 'system', content: '你在做「真实复盘」的出题：从聊天记录里挑关键处出选择题。只输出 JSON。'
            + '返回 {"question":"...","options":["A...","B...","C..."],"answer":"B"}' },
        { role: 'user', content: '聊天记录：\n' + text },
      ];
      const t0 = Date.now();
      const res = await fetch('/api/proxy', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', messages, max_tokens: 4000,
                               temperature: 0.7, response_format: { type: 'json_object' } }) });
      const txt = await res.text();
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      let j; try { j = JSON.parse(txt); } catch (e) {
        return { sec, status: res.status, kind: '响应不是 JSON', note: txt.slice(0, 80) };
      }
      if (j.error) return { sec, status: res.status, kind: 'HTTP 错误', note: String(j.error.message).slice(0, 80) };
      const ch0 = (j.choices || [{}])[0]; const msg = ch0.message || {};
      const c = msg.content || '';
      let kind;
      try {
        const o = JSON.parse(String(c).replace(/```(?:json)?/g, '').trim());
        kind = (o.question && o.options) ? '正常' : '不是答案(缺字段)';
      } catch (e) { kind = String(c).trim() ? '不是 JSON' : '★空白'; }
      return { sec, status: res.status, kind, finish: ch0.finish_reason,
               len: String(c).length, head: JSON.stringify(c).slice(0, 44),
               promptTokens: j.usage && j.usage.prompt_tokens,
               reasoning: (msg.reasoning_content || '').length };
    }, size);
    console.log(`输入约 ${String(size).padStart(5)} 字  ${r.sec}s status=${r.status} `
      + `prompt_tokens=${r.promptTokens}  finish=${r.finish}  → ${r.kind}  len=${r.len} ${r.head || r.note || ''}`);
  }
  await b.close();
})();
