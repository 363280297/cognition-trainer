/* 把 App 真正会发的四种请求各打一遍，看哪一种会返回空内容。

为什么按"四种形状"打：用户说"这么多轮错误"，可能是**某一类调用**一直不行，
而不是所有调用都不行。这四种分别是：
  1. 对话每一轮（系统提示词 + 历史，max_tokens 3000）
  2. 一局之后的复盘打分（makeDebrief，max_tokens 3000）
  3. 表达体检 aiCheckup（max_tokens 4000，temperature 0.3）
  4. 真实复盘的出题 aiReplayQuestions（4000）与揭晓 aiReplayReveal（5000）
每个形状各打两次（两个模型），并且把原始返回里几个关键字段直接打出来：
finish_reason、有没有 reasoning_content、有没有 logprobs、content 到底是什么。
本环境的假密钥（proxy-uses-env）：真密钥在 server.py 那边读 .env。
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

  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    await p.evaluate((m) => {
      document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
      saveSettings({ apiKey: 'proxy-uses-env', model: m });
    }, model);

    const out = await p.evaluate(async () => {
      const sc = (CONTENT.scenarios.scenarios || [])[0];
      const rows = [];
      /* 每一行：名字 + 构造 messages 的写法 + 额度。全部走 App 自己的 llmCall，
         并且把最后那次原始 HTTP 返回截下来看字段（llmCallOnce 不暴露它，
         所以这里改用 fetch 走同一条代理，把原文拿全）。 */
      const raw = async (messages, maxTokens, temperature) => {
        const body = JSON.stringify({
          model: settings().model, messages,
          response_format: { type: 'json_object' },
          max_tokens: maxTokens, temperature,
        });
        const t0 = Date.now();
        const r = await fetch('/api/proxy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const text = await r.text();
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        let j = null;
        try { j = JSON.parse(text); } catch (e) { }
        if (!j) return { sec, status: r.status, raw: text.slice(0, 160) };
        const ch0 = (j.choices || [{}])[0];
        const msg = ch0.message || {};
        const c = msg.content;
        return {
          sec, status: r.status, respModel: j.model, finish: ch0.finish_reason,
          hasReasoningField: Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'),
          reasoningLen: (msg.reasoning_content || '').length,
          hasLogprobs: Object.prototype.hasOwnProperty.call(ch0, 'logprobs'),
          contentRepr: JSON.stringify(c).slice(0, 40),
          contentLen: typeof c === 'string' ? c.length : null,
          usage: j.usage && j.usage.completion_tokens,
        };
      };

      // 1. 对话一轮
      rows.push(['对话一轮', await raw([
        { role: 'system', content: llmSystem(sc) },
        { role: 'user', content: '【对方说】你好，等很久了吗？' }], 3000, 0.9)]);
      // 2. 一局后的复盘打分（用 App 里那段真实的评分提示词构造）
      const debriefSys = [
        '你在给一段「用户和陪练对象」的对话写复盘。只输出 JSON。',
        '返回字段：summary（一句话）、good（做对的 2-3 条）、better（可以更好的 2-3 条）、',
        'next（下次专门练一件事）。每条不超过 40 字。',
      ].join('\n');
      rows.push(['复盘打分', await raw([
        { role: 'system', content: debriefSys },
        { role: 'user', content: '对话记录：\n对方：你好，等很久了吗？\n我：没有，我也刚到。\n对方：你平时周末都干嘛？\n我：睡觉。' }],
        3000, 0.7)]);
      // 3. 表达体检
      rows.push(['表达体检', await raw([
        { role: 'system', content: '你在做「表达体检」：给一段话照五个维度打分。只输出 JSON。signals 最多 3 条。' },
        { role: 'user', content: '我说的话：\n其实我觉得这个方案也不是不行，就是可能有点赶，要不我们再看看？' }],
        4000, 0.3)]);
      // 4. 真实复盘：出题
      rows.push(['复盘出题', await raw([
        { role: 'system', content: '你在做「真实复盘」的出题：从一段聊天记录里挑出关键处出选择题。只输出 JSON。' },
        { role: 'user', content: '聊天记录：\n她：今天好累啊\n我：早点睡\n她：嗯' }],
        4000, 0.7)]);
      // 5. 真实复盘：揭晓
      rows.push(['复盘揭晓', await raw([
        { role: 'system', content: '你在给「真实复盘」的选择题揭晓答案并解释。只输出 JSON。' },
        { role: 'user', content: '聊天记录：\n她：今天好累啊\n我：早点睡\n她：嗯\n\n题目：她此刻最想要的是什么？\n选项：A 建议 B 被听见 C 独处\n我选了：A' }],
        5000, 0.7)]);
      return rows;
    });

    console.log(`\n===== 模型 ${model} =====`);
    for (const [name, r] of out) {
      const flag = (r.contentLen || 0) > 0 ? 'OK  ' : '空!!';
      console.log(`${flag} ${name.padEnd(6)} ${r.sec}s  finish=${r.finish}  `
        + `content=${r.contentRepr} len=${r.contentLen}  推理字段=${r.hasReasoningField ? r.reasoningLen : '无'}  `
        + `logprobs=${r.hasLogprobs ? '有' : '无'}  completion=${r.usage}`);
    }
  }
  await b.close();
})();
