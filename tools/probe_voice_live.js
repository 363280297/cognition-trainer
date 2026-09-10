/* 用 App 自己的代码路径打一次真实请求，看会不会出现「返回了空内容」。
 *
 * 为什么要这样测：光用 curl 手搓一个小提示词是打不出那个错的
 * （我已经试过：三个模型名、带/不带 response_format 都正常返回 JSON）。
 * 用户手机上跑的是**这一整段提示词 + 历史**，所以必须用同一段。
 *
 * 走的是 server.py 的 /api/proxy（服务端用 .env 里的密钥），
 * 也就是电脑上打开 App 时那条真实路径。密钥不进这个脚本、不进页面 localStorage。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  // 通过 server.py 打开（不是 file://），这样 /api/proxy 可用
  await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    // 密钥随便填一个占位：代理那边用的是 .env 里的真密钥
    saveSettings({ apiKey: 'proxy-uses-env', model: 'deepseek-flash' });
  });

  // 1) 把真实的系统提示词长度量出来
  const info = await p.evaluate(() => {
    const sc = (CONTENT.scenarios.scenarios || [])[0];
    const sys = llmSystem(sc);
    return { scId: sc.id, sysLen: sys.length, sysHead: sys.slice(0, 120) };
  });
  console.log('场景:', info.scId, '系统提示词', info.sysLen, '字');
  console.log('开头:', info.sysHead.replace(/\n/g, ' / '));

  // 2) 直接调用 App 的 llmCall，用真实的系统提示词 + 真实的一段对话历史
  const out = await p.evaluate(async () => {
    const sc = (CONTENT.scenarios.scenarios || [])[0];
    const sys = llmSystem(sc);
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: '【对方说】你好，等很久了吗？' },
      { role: 'assistant', content: '{"reply":"没有，我也刚到。"}' },
      { role: 'user', content: '【对方说】你平时周末都干嘛？' },
    ];
    const t0 = Date.now();
    try {
      const r = await llmCall(messages, { temperature: 0.9, maxTokens: 3000 });
      return { ok: true, sec: ((Date.now() - t0) / 1000).toFixed(1),
               keys: Object.keys(r), reply: String(r.reply || '').slice(0, 60) };
    } catch (e) {
      return { ok: false, sec: ((Date.now() - t0) / 1000).toFixed(1), msg: String(e.message).slice(0, 400) };
    }
  });
  console.log('\n[用完整系统提示词的 llmCall]');
  console.log(JSON.stringify(out, null, 1));

  // 3) 真开一局：走 startSession（它是用户实际会点的那个按钮）
  const sess = await p.evaluate(async () => {
    const sc = (CONTENT.scenarios.scenarios || [])[0];
    state = Object.assign({}, state, { apiKey: 'proxy-uses-env', model: 'deepseek-flash' });
    V.sess = null;
    try {
      await startSession(sc.id);
      await new Promise((r) => setTimeout(r, 4000));
    } catch (e) { /* 界面自己会提示 */ }
    const view = document.querySelector('#view').textContent || '';
    return {
      hasSession: !!V.sess,
      turnN: V.sess && V.sess.turn,
      err: (document.getElementById('toast') || {}).textContent || '',
      // 她的第一句（对方先开口）在页面上吗
      herLine: (view.match(/对方[^\n]{0,40}/) || [''])[0].slice(0, 60),
      viewHead: view.slice(0, 120).replace(/\s+/g, ' '),
    };
  });
  console.log('\n[startSession 真开一局]');
  console.log(JSON.stringify(sess, null, 1));

  console.log('\nJS 报错:', errs.length ? errs.slice(0, 3) : '无');
  await b.close();
})();
