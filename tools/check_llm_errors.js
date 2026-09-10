/* 接口地址与报错文本的检查。
 *
 * 背景是一次真实故障：用户在设置里填了
 *   接口地址 https://api.deepseek.com/anthropic
 * 界面上只显示「失败：模型返回 404」，没有任何别的信息。
 *
 * 两个原因叠在一起：
 *   1. 那个输入框是**被直接 POST** 的（不拼路径），而 /anthropic 是
 *      Anthropic 协议的**基础地址**，请求体形状也跟 OpenAI 不一样 —— 必然 404；
 *   2. 原来的报错只从 JSON 里取 error.message，而这个网关的报错是**纯文本**
 *      （实测 `Authentication Fails (governor)`）。JSON.parse 一抛异常，
 *      服务端的话就被整段丢掉，界面上只剩一个状态码。
 *
 * 所以这两个函数（normalizeEndpoint / httpProblem）是这次修复的全部落点，
 * 必须钉住——它们坏掉的表现，恰好就是「用户看着一个 404 不知道改哪里」。
 * 跑的是离线单文件版，也就是 APK 里装的那一份，不是另写一份逻辑来测。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const DEF = 'https://api.deepseek.com/chat/completions';

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  // 先做一次纯静态检查：万一离线版没把 voice.js 内联进去，
  // 后面所有断言都会在「函数不存在」上失败，而那种失败看不出真正的原因。
  const html = fs.readFileSync(path.join(__dirname, '..', '认知训练-离线版.html'), 'utf8');
  chk('离线版里内联了 normalizeEndpoint', html.includes('function normalizeEndpoint'));
  chk('离线版里内联了 httpProblem', html.includes('function httpProblem'));

  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  console.log('\n[地址规范化]');
  const cases = await p.evaluate((DEF) => {
    const N = (v) => normalizeEndpoint(v);
    return {
      anthropic: N('https://api.deepseek.com/anthropic'),
      anthropicSlash: N('https://api.deepseek.com/anthropic/'),
      naked: N('https://api.deepseek.com'),
      nakedSlash: N('https://api.deepseek.com/'),
      v1: N('https://api.deepseek.com/v1'),
      full: N('https://api.deepseek.com/chat/completions'),
      fullSlash: N('https://api.deepseek.com/chat/completions/'),
      empty: N(''),
      noScheme: N('api.deepseek.com'),
      custom: N('https://my-proxy.example.com/llm/openai'),
      spaces: N('  https://api.deepseek.com  '),
      DEF,
    };
  }, DEF);

  chk('/anthropic 被挡下并说明是协议不对',
    cases.anthropic.url === DEF && /Anthropic 协议/.test(cases.anthropic.bad),
    cases.anthropic.note);
  chk('/anthropic/（带斜杠）同样被挡下',
    cases.anthropicSlash.url === DEF && !!cases.anthropicSlash.bad);
  chk('只填域名 → 补成完整端点',
    cases.naked.url === DEF && !!cases.naked.note, cases.naked.note);
  chk('域名带结尾斜杠 → 同样补全且不出现双斜杠',
    cases.nakedSlash.url === DEF && !cases.nakedSlash.url.includes('//chat'), cases.nakedSlash.url);
  chk('域名 + /v1 → 补 /chat/completions',
    cases.v1.url === DEF.replace('/chat', '/v1/chat'), cases.v1.url);
  chk('已经是完整端点 → 不动，且不产生多余的提示',
    cases.full.url === DEF && cases.full.note === '', cases.full.note || '(无提示)');
  chk('完整端点带结尾斜杠 → 去掉斜杠',
    cases.fullSlash.url === DEF, cases.fullSlash.url);
  chk('空地址 → 默认值并说明', cases.empty.url === DEF && !!cases.empty.note);
  chk('没写协议头 → 改回默认并说明',
    cases.noScheme.url === DEF && !!cases.noScheme.note, cases.noScheme.note);
  chk('自定义反代的路径原样保留（不乱改用户的输入）',
    cases.custom.url === 'https://my-proxy.example.com/llm/openai' && cases.custom.note === '',
    cases.custom.url);
  chk('前后空格被清掉', cases.spaces.url === DEF, cases.spaces.url);

  console.log('\n[报错文本]');
  const msgs = await p.evaluate(() => {
    const H = (status, body, url, model) => httpProblem({ status, body }, url, model);
    const plain = H(404, '404 page not found', 'https://api.deepseek.com/v1/chat/completions', 'm');
    const anthropic = H(404, 'Authentication Fails (governor)',
      'https://api.deepseek.com/anthropic', 'm');
    const auth = H(401, JSON.stringify({ error: { message: 'Authentication Fails' } }),
      'https://api.deepseek.com/chat/completions', 'm');
    const noBody = H(404, '', 'https://api.deepseek.com/nope', 'm');
    const badModel = H(404, JSON.stringify({ error: { message: 'Model Not Exist' } }),
      'https://api.deepseek.com/chat/completions', 'deepseek-v4-pro');
    const empty = H(0, '', 'https://api.deepseek.com/chat/completions', 'm');
    return { plain, anthropic, auth, noBody, badModel, empty };
  });

  chk('纯文本报错也会露出来（这次故障的正因）',
    msgs.plain.includes('404 page not found'), msgs.plain.split('\n')[0].slice(0, 48));
  chk('报错里带上「实际发到哪个地址」',
    msgs.plain.includes('https://api.deepseek.com/v1/chat/completions'));
  chk('404 给出方向（跟密钥无关）',
    /密钥无关|401/.test(msgs.plain), (msgs.plain.match(/404 在这里[^\n]{0,24}/) || [''])[0]);
  chk('/anthropic 的 404 额外点出协议不对',
    /Anthropic 协议/.test(msgs.anthropic));
  chk('401 的 JSON message 仍然取得到',
    msgs.auth.includes('Authentication Fails') && /密钥/.test(msgs.auth));
  chk('没有任何响应体时也不崩，并给出地址',
    msgs.noBody.includes('404') && msgs.noBody.includes('https://api.deepseek.com/nope'),
    msgs.noBody.split('\n')[0]);
  chk('模型名不存在时点出来（并带上填的模型名）',
    /model|模型/.test(msgs.badModel) && msgs.badModel.includes('deepseek-v4-pro'),
    (msgs.badModel.match(/服务端说[^\n]{0,30}/) || [''])[0]);
  chk('状态码 0（连不上/超时）不误报成 404 方向',
    msgs.empty.includes('0') && !/404 在这里/.test(msgs.empty), msgs.empty.split('\n')[0]);

  // 报错里绝不能出现密钥
  const anyKey = [msgs.plain, msgs.anthropic, msgs.auth, msgs.empty].join(' ');
  chk('报错文本里不含密钥字样', !/sk-[a-z0-9]/i.test(anyKey) && !/Bearer/.test(anyKey));

  console.log('\n[设置页]');
  const ui = await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    openSettings('ai');   // 接口地址那一栏在「AI 陪练」分区里
    const hint = document.getElementById('urlHint');
    const before = hint ? hint.textContent : '';
    const el = document.getElementById('setUrl');
    el.value = 'https://api.deepseek.com/anthropic';
    previewEndpoint();
    const after = document.getElementById('urlHint').textContent;
    return { before, after, color: document.getElementById('urlHint').style.color };
  });
  chk('设置页打开时就显示「实际会发到哪个地址」',
    ui.before.includes('实际会 POST 到'), ui.before.slice(0, 60));
  chk('填了 /anthropic 当场变警告（不用等保存才报错）',
    /Anthropic 协议/.test(ui.after), ui.after.slice(0, 50));
  chk('警告用醒目颜色', !!ui.color, ui.color || '(无色)');

  chk('无脚本报错', errs.length === 0, errs.join(' | ') || '无');
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
