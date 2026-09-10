/* 连打 12 轮真实对话（历史像 App 一样累积），看哪一轮开始出问题。

为什么这么测：用小提示词单打是打不出那个错的。而 App 每一轮发的都是
[系统提示词 + 全部历史]，历史只会越来越长——用户说的"这么多轮错误"
很可能就是这个形状：前几轮好、后面开始空。这里把每一轮的内容长度、
推理长度、耗时、finish_reason 都打出来，哪一轮开始异常一眼能看到。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const USER_LINES = [
  '你好，等很久了吗？',
  '你平时周末都干嘛？',
  '我也喜欢拍照，不过我拍得很烂',
  '那你觉得这附近有什么好逛的吗',
  '说起来，你最近工作忙吗',
  '我最近也挺忙的，项目一直改需求',
  '嗯，被甲方来回折腾是真累',
  '那你一般怎么放松',
  '我也试试看吧',
  '你朋友介绍我们认识的时候，跟你说了什么',
  '哈哈，她确实话挺多的',
  '那下次要不要一起去拍照',
];

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    saveSettings({ apiKey: 'proxy-uses-env', model: 'deepseek-flash' });
  });

  const rows = [];
  for (let i = 0; i < USER_LINES.length; i++) {
    const r = await p.evaluate(async (arg) => {
      const line = arg.line, turn = arg.turn;
      const sc = (CONTENT.scenarios.scenarios || [])[0];
      // 模拟 App 的历史累积：挂在 window 上，跨轮保留
      window.__h = window.__h || [];
      window.__h.push({ role: 'user', content: line });
      const msgs = [{ role: 'system', content: llmSystem(sc) }, ...window.__h];
      const chars = msgs.reduce((a, m) => a + m.content.length, 0);
      const t0 = Date.now();
      try {
        const o = await llmCall(msgs, { temperature: 0.9, maxTokens: 3000 });
        window.__h.push({ role: 'assistant', content: JSON.stringify(o) });
        return { turn, chars, sec: ((Date.now() - t0) / 1000).toFixed(1),
                 ok: true, replyLen: String(o.reply || '').length };
      } catch (e) {
        window.__h.push({ role: 'assistant', content: '' });
        return { turn, chars, sec: ((Date.now() - t0) / 1000).toFixed(1),
                 ok: false, msg: String(e.message).replace(/\n/g, ' ⏎ ').slice(0, 240) };
      }
    }, { line: USER_LINES[i], turn: i + 1 });
    rows.push(r);
    const tail = r.ok ? `回复 ${r.replyLen} 字` : `失败：${r.msg}`;
    console.log(`第 ${String(r.turn).padStart(2)} 轮  历史共 ${String(r.chars).padStart(5)} 字  ${r.sec}s  ${tail}`);
    if (!r.ok) break;
  }
  const bad = rows.filter((x) => !x.ok).length;
  console.log(`\n共 ${rows.length} 轮，失败 ${bad} 轮`);
  await b.close();
})();
