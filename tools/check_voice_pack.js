/* 音色（语音包）的检查。
 *
 * 用户问的是：
 *   「他是不是应该会有语音包那种的？发出类似真人的声音。」
 *
 * 也就是**她的声音**（TTS 合成）。这里查出过两个真问题，正是这一组要盯住的：
 *   1. Java 里的 `voices()` 方法**从来没被网页调用过**——死代码，
 *      所以用户从来没能挑过音色，一直用系统默认那个嗓子。
 *   2. 没有 `setVoice()`，就算列出音色也选不了。
 *
 * 这个文件原来还有另外半块：「识别精度」。用户当时一起问的是
 *   「然后这个对话也能读取我的音频，然后识别成文字。」
 * 2.31 把听你说话（麦克风 + 语音识别 + 免提）整块删掉了，所以那半块连同
 * 设置页的「语音识别」分区一起没了：setAsrMode / startListen / autoListen /
 * testAsr / V.asr / V.caps.mic / asrOffline 在 public/ 里一个都不剩。
 * 断言它们只会当场 ReferenceError（试过），所以整段删除——
 * **不是**换个写法糊回来。用户的原话是「直接把这个录音的功能删除。我直接打字算了。」
 *
 * 音色列表只有真机上才有，而这两条路径（列表渲染、选择与生效）都是纯逻辑，
 * 可以在浏览器里验。
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

/* 一台「典型手机」的音色：有一个高质量但要联网的，有已经下载好可离线的，
   有一个还没下载的，还有一个非中文的（必须被过滤掉）。 */
const PHONE = [
  { name: 'zh-cn-x-ccc-network', locale: 'zh-CN', quality: 500, latency: 300, network: true, installed: true },
  { name: 'zh-cn-x-ccc-local', locale: 'zh-CN', quality: 400, latency: 200, network: false, installed: true },
  { name: 'zh-cn-x-ddd-local', locale: 'zh-CN', quality: 300, latency: 300, network: false, installed: true },
  { name: 'zh-cn-x-eee-network', locale: 'zh-CN', quality: 500, latency: 300, network: true, installed: false },
  { name: 'en-us-x-fff-local', locale: 'en-US', quality: 400, latency: 200, network: false, installed: true },
];

/* 注意：桩必须在**页面里**构造。p.evaluate 只能传可序列化的值，
   传含函数的对象会直接报 "Attempting to serialize unexpected value"。
   所以这里只传数据（音色数组），函数在页面里现造。 */

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // ---------------------------------------------------------------- 音色列表
  console.log('\n[音色列表：把系统里的音色翻成人能判断的信息]');
  await p.evaluate((phone) => {
    // MAKE_STUB 定义在页面外，这里用 Function 在页面里重建一份（见上面注释）
    window.__phone = phone;
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, http: true, music: false }),
      voices: () => { window.__voiceCalls = (window.__voiceCalls || 0) + 1; return JSON.stringify(window.__phone); },
      setVoice: (n) => { window.__setVoice = window.__setVoice || []; window.__setVoice.push(n); },
      currentVoice: () => 'zh-cn-x-ccc-local',
      installVoiceData: () => { window.__installCalled = (window.__installCalled || 0) + 1; },
      speak: (t) => { window.__spoke = window.__spoke || []; window.__spoke.push(t); },
      stopSpeak: () => { },
    };
    V.native = window.EQNative;
    V.caps = JSON.parse(window.EQNative.capabilities());
    VOICE_LIST = null;
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
  }, PHONE);
  await p.waitForTimeout(300);
  const list = await p.evaluate(() => {
    const box = document.getElementById('voiceBox');
    const items = [...document.querySelectorAll('.voice-item')];
    return {
      hasBox: !!box,
      labels: items.map((x) => x.querySelector('.voice-name').textContent.trim()),
      metas: items.map((x) => (x.querySelector('.voice-meta') || {}).textContent || ''),
      marks: items.map((x) => (x.querySelector('.voice-mark') || {}).textContent || ''),
      on: items.filter((x) => x.classList.contains('on')).length,
      first: items[0] ? items[0].querySelector('.voice-name').textContent.trim() : '',
      rawNameShown: items.some((x) => /zh-cn-x/.test(x.querySelector('.voice-name').textContent)),
      voiceCalls: window.__voiceCalls,
    };
  });
  chk('设置页有音色区', list.hasBox);
  chk('第一项是「自动（推荐）」', list.first === '自动（推荐）', list.first);
  chk('默认选中「自动」', list.on === 1, `${list.on} 项被选中`);
  chk('列出了这台手机上的中文音色', list.labels.length === 5, list.labels.join(' / '));
  chk('非中文音色被过滤掉了',
    !list.metas.some((m) => /en-us/.test(m)), list.metas.join(' / '));
  chk('把音色名翻成了人话（不是 zh-cn-x-ccc-local）', !list.rawNameShown);
  // 同一台手机上同参数的音色必须能区分开：否则这个列表就没法用来挑
  chk('每一行的标签互不相同', new Set(list.labels).size === list.labels.length,
    list.labels.join(' / '));
  chk('标签里带了可辨识的短编号（ccc / fff 这种）',
    list.labels.filter((x) => /· *[a-z0-9]{1,5}$/.test(x)).length >= 3,
    list.labels.filter((x) => /· *[a-z0-9]{1,5}$/.test(x)).join(' / '));
  chk('说明了是否要联网', list.labels.some((x) => /需联网/.test(x)) && list.labels.some((x) => /可离线/.test(x)),
    list.labels.join(' / '));
  chk('标了音质', list.labels.some((x) => /音质/.test(x)), list.labels.join(' / '));
  chk('没下载的音色标了「未下载」', list.marks.some((m) => m === '未下载'), list.marks.join(' / '));
  chk('原始音色名仍然显示出来（便于核对）', list.metas.some((m) => /zh-cn-x/.test(m)));

  console.log('\n[排序：能用的、质量高的排前面]');
  chk('已下载的排在未下载的前面',
    list.marks.indexOf('未下载') === -1 || list.marks[list.marks.length - 1] === '未下载',
    list.marks.join(' / '));
  {
    // 第一个真实音色（不是「自动」）应该最好用：离线优先于联网，再看音质
    const firstReal = list.labels[1] || '';
    chk('第一个真实音色是可离线的高音质那个',
      /可离线/.test(firstReal) && /音质很高|音质高/.test(firstReal), firstReal);
  }

  console.log('\n[选一个音色：立刻存 + 立刻生效]');
  const pick = await p.evaluate(() => {
    const items = [...document.querySelectorAll('.voice-item')];
    const target = items.find((x) => /zh-cn-x-ccc-local/.test(x.textContent));
    target.click();
    // 点完列表会被重画，target 已经是脱离文档的旧节点——
    // 必须重新查一次，否则读到的是点击前的状态（我第一次就是这么写错的）
    const fresh = [...document.querySelectorAll('.voice-item')]
      .find((x) => /zh-cn-x-ccc-local/.test(x.textContent));
    return {
      saved: JSON.parse(localStorage.getItem('eq-settings-v1') || '{}').voice,
      setVoiceCalls: window.__setVoice,
      on: [...document.querySelectorAll('.voice-item.on')].map((x) => x.querySelector('.voice-name').textContent.trim()),
      markedSelected: fresh ? fresh.querySelector('.voice-mark').textContent.trim() : '(找不到)',
    };
  });
  chk('点一下就存进设置', pick.saved === 'zh-cn-x-ccc-local', String(pick.saved));
  chk('点一下就通知原生切换（不用再点保存）',
    (pick.setVoiceCalls || []).includes('zh-cn-x-ccc-local'), JSON.stringify(pick.setVoiceCalls));
  chk('选中状态跟着换', pick.on.length === 1 && /可离线/.test(pick.on[0]), pick.on.join(' / '));
  chk('打上了「已选」', pick.markedSelected === '已选', pick.markedSelected);

  console.log('\n[选了未下载的音色：要提醒，不能静默失败]');
  const notInstalled = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    const items = [...document.querySelectorAll('.voice-item')];
    const t = items.find((x) => /zh-cn-x-eee-network/.test(x.textContent));
    const before = document.getElementById('toast').textContent;
    t.click();
    return { toast: document.getElementById('toast').textContent, before };
  });
  chk('选未下载的音色会提示去下载',
    /还没下载|下载/.test(notInstalled.toast), String(notInstalled.toast).slice(0, 50));

  console.log('\n[试听]');
  const preview = await p.evaluate(() => {
    saveSettings({ voice: 'zh-cn-x-ccc-local' });
    window.__setVoice = [];
    window.__spoke = [];
    previewVoice();
    return { setVoice: window.__setVoice, spoke: window.__spoke };
  });
  chk('试听前会先把当前音色应用上（否则听到的是上一个）',
    (preview.setVoice || []).includes('zh-cn-x-ccc-local'), JSON.stringify(preview.setVoice));
  chk('试听真的出声了', (preview.spoke || []).length === 1, JSON.stringify(preview.spoke).slice(0, 40));

  console.log('\n[去系统里下载音色]');
  const dl = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => /去系统里下载音色/.test(x.textContent));
    if (btn) btn.click();
    return { called: window.__installCalled || 0, hasBtn: !!btn };
  });
  chk('有「去系统里下载音色」这个按钮', dl.hasBtn);
  chk('点了会调原生的下载入口', dl.called === 1, String(dl.called));

  console.log('\n[没有中文音色的手机：要说清怎么办]');
  const empty = await p.evaluate(() => {
    VOICE_LIST = null;
    window.EQNative.voices = () => '[]';
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    return document.getElementById('voiceBox').textContent;
  });
  chk('没有音色时说明原因并给出出路',
    /没有中文音色/.test(empty) && /下载|文字转语音/.test(empty), empty.slice(0, 60));

  console.log('\n[音色列表要缓存，不能每次开设置都读一遍]');
  const cache = await p.evaluate(() => {
    window.EQNative.voices = () => { window.__voiceCalls = (window.__voiceCalls || 0) + 1; return JSON.stringify([]); };
    VOICE_LIST = null;
    window.__voiceCalls = 0;
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    const first = window.__voiceCalls;
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();          // 第二次开，应该用缓存
    const second = window.__voiceCalls;
    loadVoices(true);        // 明确点「重新读取」才该再读
    return { first, second, afterForce: window.__voiceCalls };
  });
  chk('第一次开设置读一次', cache.first === 1, String(cache.first));
  chk('再开一次不重复读（用缓存）', cache.second === 1, String(cache.second));
  chk('点「重新读取」才会再读', cache.afterForce === 2, String(cache.afterForce));

  /* ---------------------------------------------------------------- 识别
   *
   * 这里原来有两节：「语音识别：能读音频转文字，且模式可选」（测设置页的
   * 在线/离线开关、setAsrMode 有没有把模式真的传给原生、免提自动收音那条路
   * 带不带模式），以及「识别自检：把结果原样显示出来」（testAsr + V.asr 回调）。
   *
   * 2.31 把听你说话整块删掉之后，这些 API（setAsrMode / startListen / autoListen /
   * testAsr / V.asr / V.phase / asrOffline / #asrChips / #asrHint）在 public/ 里
   * 一个都不剩。整段删除——**不是**换个写法糊回来：免提和识别都不存在了，
   * 留着断言只会红在一个假对象上（试过：先 FAIL 四条，再 ReferenceError）。
   */

  console.log('\n[「实际生效的音色」要看得见]');
  const now = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    saveSettings({ voice: 'zh-cn-x-ccc-local' });
    window.EQNative.currentVoice = () => 'zh-cn-x-ccc-local';
    openSettings();
    return document.getElementById('voiceNow').textContent;
  });
  chk('显示了当前实际生效的音色', /zh-cn-x-ccc-local/.test(now), String(now).slice(0, 50));

  // 选了但没生效（比如音色被引擎忽略）必须能看出来——这是「选了没反应」的解药
  const mismatch = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    saveSettings({ voice: 'zh-cn-x-eee-network' });     // 选了那个未下载的
    window.EQNative.currentVoice = () => 'zh-cn-x-ccc-local';  // 实际还是旧的
    openSettings();
    return document.getElementById('voiceNow').textContent;
  });
  chk('选的音色和实际生效的不一致时会明确指出来',
    /注意/.test(mismatch) && /zh-cn-x-eee-network/.test(mismatch) && /zh-cn-x-ccc-local/.test(mismatch),
    String(mismatch).slice(0, 70));

  console.log('\n[打开系统语音设置：音色列表为空时的唯一出口]');
  const sys = await p.evaluate(() => {
    window.__ttsSettings = 0;
    window.EQNative.openTtsSettings = () => { window.__ttsSettings++; };
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    const btn = [...document.querySelectorAll('button')].find((x) => /打开系统语音设置/.test(x.textContent));
    if (btn) btn.click();
    return { hasBtn: !!btn, called: window.__ttsSettings };
  });
  chk('有「打开系统语音设置」这个按钮', sys.hasBtn);
  chk('点了会调原生入口（换引擎/下语音包都在那里）', sys.called === 1, String(sys.called));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
