/* A/B 对照：带 / 不带 response_format，各打 12 次，统计"内容不能当答案用"的比例。

判据不是"空不空"，而是**这份内容能不能拿来做这个模块的事**：
  · 正常：能 JSON.parse，且含该模块需要的字段
  · 回显 schema：解析出来是 {type:'json_object'} 这种（合法 JSON，但不是答案）
  · 空白 / 空：拿不到内容
这才能区分"看着有字，其实是废的"——用户的"模型返回了空内容"只是这一类的极端形态。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const N = 12;

const SYS_VOICE = null; // 用页面里的真实提示词

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  const run = async (withFmt, shape) => {
    const r = await p.evaluate(async (arg) => {
      const shapes = {
        voice: {
          msgs: () => [{ role: 'system', content: llmSystem((CONTENT.scenarios.scenarios || [])[0]) },
                       { role: 'user', content: '【对方说】你好，等很久了吗？' }],
          need: ['reply', 'tone', 'inner', 'rating', 'temp'], mt: 3000, tp: 0.9,
        },
        checkup: {
          msgs: () => [{ role: 'system', content: '你在做「表达体检」：给一段话照五个维度打分。只输出 JSON。'
              + '返回 {"scores":{"清晰度":0-100,...},"signals":[...],"advice":"..."}' },
            { role: 'user', content: '我说的话：\n其实我觉得这个方案也不是不行，就是可能有点赶，要不我们再看看？' }],
          need: ['scores'], mt: 4000, tp: 0.3,
        },
      };
      const cfg = shapes[arg.shape];
      const body = { model: 'deepseek-flash', messages: cfg.msgs(),
                     max_tokens: cfg.mt, temperature: cfg.tp };
      if (arg.fmt) body.response_format = { type: 'json_object' };
      const t0 = Date.now();
      const res = await fetch('/api/proxy', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const txt = await res.text();
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      let j; try { j = JSON.parse(txt); } catch (e) { return { sec, kind: 'HTTP/解析失败', note: txt.slice(0, 60) }; }
      const ch0 = (j.choices || [{}])[0]; const msg = ch0.message || {};
      const c = msg.content || '';
      let parsed = null;
      try { parsed = JSON.parse(String(c).replace(/```(?:json)?/g, '').trim()); } catch (e) { }
      let kind;
      if (!String(c).trim()) kind = '空白';
      else if (!parsed) kind = '不是 JSON';
      else if (parsed.type === 'json_object' && Object.keys(parsed).length <= 2) kind = '回显 schema';
      else if (!cfg.need.every((k) => Object.prototype.hasOwnProperty.call(parsed, k))) kind = '缺字段';
      else kind = '正常';
      return { sec, kind, finish: ch0.finish_reason, len: String(c).length,
               head: JSON.stringify(c).slice(0, 40), reasoning: (msg.reasoning_content || '').length };
    }, { fmt: withFmt, shape });
    return r;
  };

  for (const shape of ['voice', 'checkup']) {
    for (const fmt of [true, false]) {
      const tally = {};
      const bad = [];
      for (let i = 0; i < N; i++) {
        const r = await run(fmt, shape);
        tally[r.kind] = (tally[r.kind] || 0) + 1;
        if (r.kind !== '正常') bad.push(`${r.kind}(${r.head})`);
      }
      console.log(`${shape.padEnd(8)} response_format=${fmt ? '带' : '不带'}  `
        + JSON.stringify(tally) + (bad.length ? '   坏的例子：' + bad.slice(0, 3).join(' ') : ''));
    }
  }
  await b.close();
})();
