/* 真打一次「要一句示范」，看模型给的是不是一句能说出口的人话。

不经过 talkHintDemo（它把错误吞成 toast），直接调 llmCall，
这样才能把真正的报错和诊断信息露出来。需要 server.py 在跑（密钥从 .env 读）。
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const SC = {
  id: 's1', title: '刚认识两周，第一次单独出来', stage: '认识试探', difficulty: 2,
  her: '26 岁，做设计的，性格偏慢热。', her_state: '她有点紧张，也怕尴尬。',
  opening: '你好，等很久了吗？', goal: '让她放松地说话', trap: '一直找话题表现自己',
};

const LINES = [
  '今天好累啊，项目一直改需求，烦死了。',
  '你平时周末都干嘛？',
  '嗯',
  '我最近在想要不要换个工作，现在这个项目组人一直在走，我也学不到东西。',
];

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    saveSettings({ apiKey: 'proxy-uses-env', model: 'deepseek-flash', autoSpeak: false });
  });
  await p.evaluate(async (sc) => { await startSession(sc); }, SC);

  for (const line of LINES) {
    const r = await p.evaluate(async (herLine) => {
      V.sess.history.push({ role: 'assistant', content: herLine });
      const move = talkMove(pickTalkMove(herLine).id);
      const dp = talkHintCfg().demo_prompt || {};
      const sys = [dp.role || ''].concat(dp.rules || []).join(String.fromCharCode(10));
      const usr = '对方刚说的是：「' + herLine + '」' + String.fromCharCode(10)
        + '给我一句我能直接说出口的回应。';
      const t0 = Date.now();
      let err = '';
      let demo = '';
      try {
        const o = await llmCall([{ role: 'system', content: sys }, { role: 'user', content: usr }],
          { temperature: 0.8, maxTokens: 1600, textOk: true, noFormat: true });
        demo = String(o.reply || '');
      } catch (e) { err = String(e.message).split(String.fromCharCode(10)).join(' ⏎ '); }
      return { move: move.name, sysLen: sys.length, sec: ((Date.now() - t0) / 1000).toFixed(1), demo, err };
    }, line);
    const d = r.demo || '';
    const flags = [];
    if (!d.length) flags.push('空');
    else if (d.length > 45) flags.push('太长了(' + d.length + '字)');
    if (/^[\[{]/.test(d.trim())) flags.push('像是 JSON');
    if (/应该|建议|可以试试|你需要/.test(d)) flags.push('像说教');
    console.log('她说：' + line.slice(0, 24));
    console.log('  方向：' + r.move + '（提示词 ' + r.sysLen + ' 字，' + r.sec + 's）');
    console.log('  示范：「' + d + '」' + (flags.length ? '  ← ' + flags.join(' / ') : '  ✓'));
    if (r.err) console.log('  报错：' + r.err.slice(0, 320));
    console.log('');
  }
  await b.close();
})();
