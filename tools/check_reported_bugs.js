/* 用户报的两个 bug 的回归检查。
 *
 *   「偶尔 ai 界面还是会显示练习界面的内容」
 *   「AI 界面，我点了开始说，他没有用。然后我打字说出了，然后显示模型返回内容为空」
 *
 * 诊断结论（前面三个诊断脚本走了弯路，教训写在注释里）：
 *   · 「点了 AI 看到别的页面」的根因是**子页状态跨 tab 保留**。
 *     去过「成长→我的预案」之后 cardsView='plans'，再点「练习」，
 *     viewCards() 就会把预案页渲染到练习 tab 下面——这是真串台。
 *     同理点 AI 可能停在上次的「真实复盘」而不是场景对话。
 *   · 「模型返回内容为空」是因为带推理的模型把 max_tokens 吃光了，
 *     而原来的报错只说「再试一次」，既没原因也没方向，还把服务端原文丢了。
 *
 * 「点了开始说没用」这一半已经**没有对应的功能了**：用户后来把语音输入整个删掉
 * （「直接把这个录音的功能删除。我直接打字算了。」），micTap 在 2.31 不存在了，
 * 所以原来管这一条的那一节整节删除（见下面第二节位置留下的说明），
 * 不再在这里假装还守着它。剩下的两条照旧。
 *
 * 所以这一组直接断言**用户能感觉到的结果**，不去数内部变量。
 * 判「现在是哪一页」用 DOM 结构（id / class），不用文字关键词——
 * 前一个诊断就是栽在关键词上（今天页里有「第 0 关」「1 条微课」，全线误报）。
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

const WHO_SRC = `(() => {
  const v = document.getElementById('view');
  const has = (s) => !!v.querySelector(s);
  const id = (x) => !!document.getElementById(x);
  if (id('talkCard')) return 'AI:场景对话(进行中)';
  if (id('scenePrompt') || has('.seed-list')) return 'AI:场景对话';
  if (id('ckText')) return 'AI:表达体检';
  if (id('rpChat') || id('rpOut')) return 'AI:真实复盘';
  if (id('opts') || id('genreStep')) return '练习:卡片';
  if (has('.lesson-item')) return '练习:微课';
  if (has('.sg-dots') || has('.sg-btns') || has('.sg-review')) return '练习:信号场';
  if (has('.scene')) return '练习:语境校准';
  if (has('.plan-card')) return '成长:我的预案';
  if (has('.bias-card')) return '成长:偏差画像';
  if (has('.today-card')) return '今天';
  if (has('.stage-head') || has('.daily-card')) return '成长:阶段';
  /* 空数据时上面几个类都不存在（一个 .card + 一个 h2）。
     这一组页面本来就靠标题区分，所以按标题认——用整串精确匹配，
     不做关键词包含，免得又踩「今天页里也有第 0 关」那种误报。 */
  const h = v.querySelector('h2');
  const t = h ? h.textContent.trim() : '';
  const BY_HEAD = {
    '偏差画像': '成长:偏差画像',
    '还没有预案': '成长:我的预案',
    '阶段评估': '成长:阶段',
    '信号场': '练习:信号场',
    '球在谁手里': '练习:闲聊',
  };
  if (BY_HEAD[t]) return BY_HEAD[t];
  return '其它' + (t ? ':' + t : '');
})()`;

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, http: true, music: false }),
      httpPost: async (id) => window.__onHttp(id, JSON.stringify({ status: 200, body: '{}' })),
      speak: () => { }, stopSpeak: () => { },
    };
    V.native = window.EQNative;
    V.caps = { tts: true, http: true, music: false };
    saveSettings({ apiKey: 'sk-x', model: 'deepseek-chat' });
  });

  // ============================================================ 一、串台
  console.log('\n[一、点底部 tab 必须落到那一路的默认页]');
  const cases = [
    { pre: "go('growth');setGrowthSubview('plans')", tab: 'practice', want: '练习:卡片' },
    { pre: "go('growth');setGrowthSubview('bias')", tab: 'practice', want: '练习:卡片' },
    { pre: "go('practice');setPracticeSubview('learn')", tab: 'practice', want: '练习:卡片' },
    { pre: "go('practice');setPracticeSubview('calib')", tab: 'practice', want: '练习:卡片' },
    { pre: "go('practice');setPracticeSubview('learn')", tab: 'ai', want: 'AI:场景对话' },
    { pre: "go('ai');setAiSubview('replay')", tab: 'ai', want: 'AI:场景对话' },
    { pre: "go('ai');setAiSubview('checkup')", tab: 'ai', want: 'AI:场景对话' },
    { pre: "go('practice');setPracticeSubview('calib')", tab: 'growth', want: '成长:阶段' },
    { pre: "go('growth');setGrowthSubview('plans')", tab: 'growth', want: '成长:阶段' },
    { pre: "go('growth');setGrowthSubview('bias')", tab: 'today', want: '今天' },
    { pre: "go('ai');setAiSubview('replay')", tab: 'today', want: '今天' },
  ];
  for (const c of cases) {
    await p.evaluate(`(() => { ${c.pre}; go('${c.tab}'); })()`);
    const who = await p.evaluate(WHO_SRC);
    const ok = who === c.want;
    chk(`${c.pre.padEnd(42)} → 点「${c.tab}」= ${who}`, ok, ok ? '' : `期望 ${c.want}`);
  }

  console.log('\n[串台方向：每个 tab 下只能出现自己那一路的页面]');
  const ALLOWED = { today: ['今天'], practice: ['练习:'], ai: ['AI:'], growth: ['成长:'] };
  let bleed = 0;
  for (const pre of ['stages', 'bias', 'plans']) {
    await p.evaluate(`go('growth');setGrowthSubview('${pre}')`);
    for (const t of ['practice', 'ai', 'growth', 'today', 'practice', 'ai']) {
      await p.evaluate(`go('${t}')`);
      const r = await p.evaluate(`({ tab: currentTab, who: ${WHO_SRC} })`);
      if (!ALLOWED[r.tab].some((a) => r.who.startsWith(a))) {
        bleed++; console.log(`     !! go(${r.tab}) 之后是 ${r.who}`);
      }
    }
    // 反向也走一遍：从练习的子页出发
    await p.evaluate("go('practice');setPracticeSubview('calib')");
    for (const t of ['growth', 'practice', 'today', 'ai']) {
      await p.evaluate(`go('${t}')`);
      const r = await p.evaluate(`({ tab: currentTab, who: ${WHO_SRC} })`);
      if (!ALLOWED[r.tab].some((a) => r.who.startsWith(a))) {
        bleed++; console.log(`     !! go(${r.tab}) 之后是 ${r.who}`);
      }
    }
  }
  chk('来回切换 30 次都没有出现别的 tab 的页面', bleed === 0, `${bleed} 次`);

  // 修 go() 的时候真踩过一次坑：setAiSubview 内部调 go()，于是
  // go 一重置，二级切换条点了就弹回第一个页面——「表达体检」「真实复盘」直接点不开。
  // 所以这里**真的去点 DOM 上的切换条**，而不是调 setter。
  console.log('\n[二级切换条必须真的能切（不是点了弹回去）]');
  /* 切换条上除了子页按钮，还允许挂**动作**入口（带 .subnav-act，比如 AI 那一路的
     「📋 历史」）。所以这里按 .subnav-tab 数子页；动作入口单独验，且必须带
     .subnav-act——否则就是把一个点了不换页的东西混进了子页队列里，那才是真 bug。 */
  const SUBTABS = {
    practice: ['练习:卡片', '练习:语境校准', '练习:微课', '练习:信号场', '练习:闲聊'],
    ai: ['AI:场景对话', 'AI:表达体检', 'AI:真实复盘'],
    growth: ['成长:阶段', '成长:偏差画像', '成长:我的预案'],
  };
  const ACTS = { practice: 0, ai: 1, growth: 0 };
  for (const tab of ['practice', 'ai', 'growth']) {
    const want = SUBTABS[tab];
    await p.evaluate(`go('${tab}')`);
    const n = await p.evaluate(`document.querySelectorAll('#view .subnav .chip-btn.subnav-tab').length`);
    chk(`${tab} 的切换条有 ${want.length} 个子页按钮`, n === want.length, `${n} 个`);
    const acts = await p.evaluate(
      `[...document.querySelectorAll('#view .subnav .chip-btn:not(.subnav-tab)')].map(b => b.className)`);
    chk(`  ${tab} 的动作入口 ${ACTS[tab]} 个，且都带 subnav-act`,
      acts.length === ACTS[tab] && acts.every((c) => /\bsubnav-act\b/.test(c)), JSON.stringify(acts));
    for (let i = 0; i < want.length; i++) {
      await p.evaluate(`go('${tab}')`);
      await p.evaluate((k) => {
        const bs = document.querySelectorAll('#view .subnav .chip-btn.subnav-tab');
        bs[k].click();
      }, i);
      const r = await p.evaluate(`({ tab: currentTab, who: ${WHO_SRC} })`);
      const ok = r.tab === tab && r.who === want[i];
      chk(`  ${tab} 点第 ${i + 1} 个「${want[i]}」→ ${r.who}`, ok,
        ok ? '' : `tab=${r.tab} 期望 ${want[i]}`);
      // 点完还在原地，说明没有被 go() 弹回去
    }
    // 连点最后一个按钮两次也不能弹回去
    const lastI = want.length - 1;
    await p.evaluate(`go('${tab}')`);
    await p.evaluate((k) => document.querySelectorAll('#view .subnav .chip-btn.subnav-tab')[k].click(), lastI);
    await p.evaluate((k) => document.querySelectorAll('#view .subnav .chip-btn.subnav-tab')[k].click(), lastI);
    const twice = await p.evaluate(`({ tab: currentTab, who: ${WHO_SRC} })`);
    chk(`  ${tab} 连点两次第 ${want.length} 个子页按钮仍在 ${want[lastI]}`, twice.who === want[lastI],
      JSON.stringify(twice));
  }

  // 练习 tab 里点「偏差画像」这种按钮，必须把 tab 也带过去，不能留在练习下面
  const cross = await p.evaluate(`(() => {
    go('practice');
    setGrowthSubview('bias');
    return { tab: currentTab, who: ${WHO_SRC} };
  })()`);
  chk('练习页里点「偏差画像」会切到成长 tab（不是留在练习下面）',
    cross.tab === 'growth' && cross.who.startsWith('成长:'), JSON.stringify(cross));

  // ======================================================== 二、开始说（已删除）
  /* 这一节原来测的是「点『开始说』不能再是点了没反应」：没有会话 / 这一局已结束 /
     手机没有识别引擎 / 麦克风没权限 / 没给原生桥 / 一切正常 —— 六种情况下
     micTap() 要么把原因讲清楚、要么真的开麦，不能静默。

     用户后来把语音输入整个否掉了：「等他说完话，我这边就会自动录音，停止这个功能。
     直接把这个录音的功能删除。我直接打字算了。」2.31 删掉之后 micTap / V.phase /
     V.caps.asr / V.caps.mic / listen 都不存在了，这一节连跑都跑不到
     （ReferenceError: micTap is not defined），所以整节删除——
     **不是**换个写法糊回来。输入方式现在只有打字，那条链路由
     check_voice_talk.js（输入框 → 发出 / 回车 → 她回话）盯着。 */

  // ============================================================ 三、空返回
  console.log('\n[三、模型返回空内容时要说清原因和方向]');
  /* 这一节是用户逼出来的：他说「这个 AI 语音出了这么多轮错误」，
     而当时的报错让他去「检查设置里的模型名」——方向是错的。
     查下来是官方文档承认的偶发行为（JSON 模式偶尔返回空内容），
     所以正确做法是**自动重试**，重试仍失败才报错，并且报错要带真实诊断。 */
  const mkCalls = (bodies) => p.evaluate(`(() => {
    const list = ${JSON.stringify(bodies)};
    window.__tries = [];
    window.EQNative.httpPost = async (id, url, hdrs, body) => {
      const i = window.__tries.length;
      window.__tries.push(JSON.parse(body));
      const spec = list[Math.min(i, list.length - 1)];
      window.__onHttp(id, JSON.stringify({
        status: 200,
        body: JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: spec.msg, finish_reason: spec.finish }],
          usage: { prompt_tokens: 1200, completion_tokens: spec.completion || 0 },
        }),
      }));
    };
    return llmCall([{ role: 'user', content: 'hi' }], { maxTokens: 3000 })
      .then((r) => ({ ok: true, tries: window.__tries, got: r }),
            (e) => ({ ok: false, msg: e.message, tries: window.__tries }));
  })()`);

  // 1) 空一次、第二次正常 → 必须自己重试成功，用户不该看到任何错
  const retried = await mkCalls([
    { msg: { content: '' }, finish: 'stop' },
    { msg: { content: '{"reply":"好"}' }, finish: 'stop' },
  ]);
  chk('空内容会自己重试，第二次成功就照常返回（不弹错）',
    retried.ok && retried.got && retried.got.reply === '好' && retried.tries.length === 2,
    `ok=${retried.ok} 尝试 ${retried.tries.length} 次`);
  chk('重试那一次去掉了 response_format（换个形状，而不是原地重打）',
    retried.tries[0].response_format && !retried.tries[1].response_format,
    JSON.stringify([!!retried.tries[0].response_format, !!retried.tries[1].response_format]));

  // 2) 回显 schema（{"type":"json_object"}）也要当成"没给内容"，同样重试
  const echo = await mkCalls([
    { msg: { content: '{"type":"json_object"}' }, finish: 'stop' },
    { msg: { content: '{"reply":"好"}' }, finish: 'stop' },
  ]);
  chk('把 response_format 回显回来（合法 JSON 但不是答案）也算空，同样重试',
    echo.ok && echo.tries.length === 2, `ok=${echo.ok} 尝试 ${echo.tries.length} 次`);

  // 3) 一直空 → 报错里要有真正能用的信息，而且**不许**再让人去改模型名
  const alwaysEmpty = await mkCalls([{ msg: { content: ' ' }, finish: 'stop' }]);
  chk('连续空内容最终报错时，带上 finish_reason / 端点 / 额度 / 模型',
    /finish_reason/.test(alwaysEmpty.msg) && /端点/.test(alwaysEmpty.msg)
    && /额度/.test(alwaysEmpty.msg) && /deepseek-flash/.test(alwaysEmpty.msg),
    alwaysEmpty.msg.split('\n').slice(-3).join(' / '));
  chk('不再把原因推给「模型名」（那是错的，用户照着改也不会好）',
    !/检查一下设置里的模型名/.test(alwaysEmpty.msg), '');
  chk('说清这是官方文档承认的偶发情况，并给出下一步（再点一次）',
    /偶尔会返回空内容/.test(alwaysEmpty.msg) && /再点一次/.test(alwaysEmpty.msg), '');
  chk('带了服务端返回的原文', /服务端返回/.test(alwaysEmpty.msg), '');
  chk('试了两次才放弃（不是一失败就报错）', alwaysEmpty.tries.length === 2,
    `尝试 ${alwaysEmpty.tries.length} 次`);

  // 4) 只返回推理（推理吃光额度）→ 指路 + 仍然重试
  const onlyReasoning = await mkCalls([
    { msg: { content: '', reasoning_content: '推理'.repeat(2000) }, finish: 'stop' },
    { msg: { content: '{"reply":"好"}' }, finish: 'stop' },
  ]);
  chk('只有推理没正文时也会重试一次', onlyReasoning.ok && onlyReasoning.tries.length === 2, '');
  const onlyReasoning2 = await mkCalls([
    { msg: { content: '', reasoning_content: '推理'.repeat(2000) }, finish: 'stop' }]);
  chk('一直只有推理、最终失败时，指出换不带推理的模型更稳',
    /推理/.test(onlyReasoning2.msg) && /不带推理/.test(onlyReasoning2.msg),
    onlyReasoning2.msg.split('\n').slice(0, 3).join(' / ').slice(0, 80));

  // 5) 截断那条路不能被改坏：额度翻倍重试，且报错是"截断"不是"空内容"
  //    两次就够：第一次 3000 被截 → 翻倍到 6000 再打一次 → 还截就如实报错。
  //    （这里我一开始把期望写成了 3 次，是把"额度翻倍"和"换个形状"两件事混在一起了。）
  const truncated = await mkCalls([{ msg: { content: '{"a":' }, finish: 'length' }]);
  chk('被截断走的仍是截断那条路（额度翻倍重试，不混进空内容的重试）',
    !truncated.ok && /截断|长度限制/.test(truncated.msg) && !/没有返回内容/.test(truncated.msg)
    && truncated.tries.length === 2 && truncated.tries[1].max_tokens === 6000
    && truncated.tries[0].response_format && truncated.tries[1].response_format,
    `尝试 ${truncated.tries.length} 次，第二次 max_tokens=${truncated.tries[1].max_tokens}`);

  // 6) 网络/密钥类错误不许重试（重试是白花钱）
  const netErr = await p.evaluate(`(() => {
    window.__n = 0;
    window.EQNative.httpPost = async (id) => {
      window.__n++;
      window.__onHttp(id, JSON.stringify({ status: 401, body: 'Authentication Fails (governor)' }));
    };
    return llmCall([{ role: 'user', content: 'hi' }], { maxTokens: 3000 })
      .then(() => ({ ok: true, n: window.__n }), (e) => ({ ok: false, n: window.__n, msg: e.message }));
  })()`);
  chk('401 这类错误不重试（重试只会白花钱）',
    !netErr.ok && netErr.n === 1 && /401|Authentication/.test(netErr.msg),
    `尝试 ${netErr.n} 次`);

  // 「返回内容为空」最省事的防线是不让它发生：装了旧版本的人，设置里存的
  // 如果是一个带推理的模型名，开一局必然空返回。第一版迁移只认一个字符串。
  const mig = await p.evaluate(`(() => {
    const out = [];
    const put = (m) => { localStorage.setItem('eq-settings-v1', JSON.stringify({ apiKey: 'sk-x', model: m })); };
    const get = () => (JSON.parse(localStorage.getItem('eq-settings-v1') || '{}').model);
    ['deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-r1', 'DeepSeek-Reasoner',
     'deepseek-r1-0528', 'deepseek-flash', 'deepseek-chat'].forEach((m) => {
      put(m); migrateOldModel();
      out.push({ from: m, to: get() });
    });
    return out;
  })()`);
  const wantMig = ['deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-r1',
    'DeepSeek-Reasoner', 'deepseek-r1-0528'];
  for (const r of mig) {
    if (wantMig.includes(r.from)) {
      chk(`装过旧版本、存的是 ${r.from} → 开机自动换成 deepseek-chat`,
        r.to === 'deepseek-chat', `实际 ${r.to}`);
    } else {
      chk(`自己选的 ${r.from} 不被乱改`, r.to === r.from, `实际 ${r.to}`);
    }
  }

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
