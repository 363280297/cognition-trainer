/* 「我自己的音乐」的检查。
 *
 * 语音识别（听你说话）已经在 2.31 整块删掉了——用户的原话是「直接把这个录音的
 * 功能删除。我直接打字算了。」所以这里只剩音乐那一块。
 * 跟着一起删掉的还有：识别三层路由（service / activity / local）、诊断分层、
 * 免提探测——那些函数（asrCap / asrAvailable / asrHandsFreeOk / asrDiagnose /
 * openVoiceSettings / startListen…）在 voice.js 里已经不存在了，
 * 留着断言只会红在一个假对象上（试过：报 ReferenceError，不是断言失败）。
 *
 * 音乐这块的功能**大部分在原生**（MediaPlayer、文件选择），而我没法在这台
 * 电脑上装到手机上试。能做的是把原生桥整段替换成一个假的 EQNative
 * （记录每一次调用和参数），然后照常跑网页那半边——这样「网页有没有真的
 * 调用它」「参数对不对」「状态回来之后界面有没有如实反映」都能在电脑上验掉，
 * 剩下真正只能靠手机的只有：MediaPlayer 本身能不能播。那件事我在交付说明里
 * 如实写出来。
 *
 * 这也是这个项目一贯的做法：把能客观验的部分验掉，不能验的部分说清楚，
 * 而不是用"应该没问题"糊过去。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

/* 假的原生桥。caps 现在只有 tts / http / music 三项（识别删掉之后 V.caps 就长这样）。 */
const stub = (caps) => `
  window.__log = [];
  window.__caps = ${JSON.stringify(caps)};
  window.EQNative = {
    capabilities: () => JSON.stringify(window.__caps),
    installVoiceData: () => window.__log.push(['installVoiceData']),
    voices: () => '[]',
    currentVoice: () => '',
    setVoice: (v) => window.__log.push(['setVoice', v]),
    speak: (id, text, r, p) => window.__log.push(['speak', text]),
    stopSpeak: () => window.__log.push(['stopSpeak']),
    httpPost: (id, url) => window.__log.push(['httpPost', url]),
    setGate: () => {}, scheduleReminder: () => {}, setDeepBlock: () => {},
    hasAccessibility: () => false, hasOverlayPermission: () => true,
    hasNotifPermission: () => true, probeRoot: () => '{"ok":false,"detail":"测试"}',
    listApps: () => '[]', backupStatus: () => '{"ok":false}', backupNow: () => '',
    backupRead: () => '', testReminder: () => {}, requestNotif: () => {},
    requestBackupPermission: () => 1, openAccessibilitySettings: () => {},
    openOverlaySettings: () => {}, openTtsSettings: () => {}, openAppSettings: () => {},
    // ---- 被检查的这几个 ----
    musicPick: () => window.__log.push(['musicPick']),
    musicPlay: () => window.__log.push(['musicPlay']),
    musicStop: () => window.__log.push(['musicStop']),
    musicForget: () => window.__log.push(['musicForget']),
    musicSetVolume: (v) => window.__log.push(['musicSetVolume', v]),
    musicDuck: (on) => window.__log.push(['musicDuck', !!on]),
    musicState: () => window.__log.push(['musicState']),
  };
`;

async function open(b, caps, pre) {
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(stub(caps));
  if (pre) await p.addInitScript(pre);
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()));
  return { p, errs };
}

(async () => {
  const b = await chromium.launch({
    executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  /* ================================================== 一、我自己的音乐 */
  console.log('[一、我自己的音乐：有原生桥]');
  {
    const { p, errs } = await open(b, { tts: false, http: false, music: true });

    const boot = await p.evaluate(() => ({
      has: musicSupported(),
      // 启动时应该问过一次原生状态，否则界面上会出现"看起来选了、其实没选"
      asked: window.__log.some((x) => x[0] === 'musicState'),
      inList: allTracks().some((t) => t.id === MY_TRACK),
      noteInSettings: (() => { openSettings('sound'); return (document.querySelector('#setBody') || document.body).textContent.indexOf('为什么这里没有内置几首歌') >= 0; })(),
    }));
    chk('原生有 MediaPlayer 时，「我自己的音乐」出现在音轨列表里', boot.has && boot.inList);
    chk('启动时问了一次原生的音乐状态（不然界面会显示假状态）', boot.asked);
    chk('设置里写了「为什么不内置几首歌」的理由', boot.noteInSettings);

    const pick = await p.evaluate(() => {
      window.__log = [];
      closeSheet();
      chooseTrack(MY_TRACK);            // 还没选过 → 应该去挑文件，而不是假装开始播
      return { log: window.__log.map((x) => x[0]), playing: AUDIO.playing };
    });
    chk('还没选文件时点它 → 去挑文件，而不是假装在放',
      pick.log.join(',') === 'musicPick' && !pick.playing, pick.log.join(','));

    const picked = await p.evaluate(() => {
      window.__log = [];
      window.__onMusic({ type: 'picked', detail: '我的歌.mp3', has: true, name: '我的歌.mp3', playing: false, persist: true });
      const li = allTracks().find((t) => t.id === MY_TRACK);
      return { name: li.name, toastText: document.getElementById('toast').textContent };
    });
    chk('选了文件之后：列表里显示文件名', /我的歌\.mp3/.test(picked.name), picked.name);
    chk('选完有提示（说清选到了什么）', /我的歌\.mp3/.test(picked.toastText), picked.toastText);

    /* 「选完就直接开始放」这一步是原生做的（onActivityResult 里选完就调 musicPlayImpl），
       所以这里要验的是**它开始放之后网页有没有跟上**：状态切到自己那条，
       并且把还在响的合成音轨停掉——不停就会两条声音一起响。 */
    const playingMsg = await p.evaluate(() => {
      // 先让合成音轨在响，模拟"他正听着雨，然后去挑了一首歌"
      audioStart('rain');
      const before = { track: AUDIO.track, playing: AUDIO.playing, nodes: AUDIO.nodes.length };
      window.__onMusic({ type: 'playing', has: true, name: '我的歌.mp3', playing: true, persist: true });
      return { before, after: { track: AUDIO.track, playing: AUDIO.playing, nodes: AUDIO.nodes.length },
               fab: (document.getElementById('audioFab') || {}).className || '' };
    });
    chk('原生开始放音乐之后，网页状态切到「我自己的音乐」',
      playingMsg.after.track === '__mine' && playingMsg.after.playing, JSON.stringify(playingMsg.after));
    chk('同时把还在响的合成音轨停掉（否则两条声音会叠在一起）',
      playingMsg.before.nodes > 0 && playingMsg.after.nodes === 0,
      `合成节点 ${playingMsg.before.nodes} → ${playingMsg.after.nodes}`);
    chk('常驻按钮显示「响着」', /on/.test(playingMsg.fab), playingMsg.fab);

    const play = await p.evaluate(() => {
      window.__log = [];
      AUDIO.playing = false; AUDIO.track = null;
      musicStart();
      return { log: window.__log.map((x) => x[0]), playing: AUDIO.playing, track: AUDIO.track };
    });
    chk('放自己的音乐 = 调原生 musicPlay，并把音量同步给原生',
      play.log.indexOf('musicPlay') >= 0 && play.log.indexOf('musicSetVolume') >= 0 &&
      play.playing && play.track === '__mine', play.log.join(','));

    const duck = await p.evaluate(() => {
      window.__log = [];
      audioDuck(true);
      const a = window.__log.map((x) => x[0] + ':' + x[1]);
      audioDuck(false);
      const b2 = window.__log.map((x) => x[0] + ':' + x[1]);
      return { a, b: b2 };
    });
    chk('她说话时，用户自己的音乐也被压低（不然她的声音会被盖住）',
      duck.a.indexOf('musicDuck:true') >= 0 && duck.b.indexOf('musicDuck:false') >= 0,
      duck.b.join(' | '));

    const vol = await p.evaluate(() => {
      window.__log = [];
      setAudioVolume(0.5);
      const v = window.__log.filter((x) => x[0] === 'musicSetVolume').map((x) => x[1]);
      setAudioVolume(9);                 // 上限
      const v2 = window.__log.filter((x) => x[0] === 'musicSetVolume').map((x) => x[1]);
      return { v, cap: settings().audioVolume, v2 };
    });
    chk('音量滑块也管到原生音乐，而且上限仍然是 0.6',
      vol.v.length >= 1 && vol.v2[vol.v2.length - 1] <= 0.6 && vol.cap === 0.6,
      `${JSON.stringify(vol.v)} 上限后 ${vol.v2[vol.v2.length - 1]}`);

    const stop = await p.evaluate(() => {
      window.__log = [];
      audioStop();                       // 关背景声 → 自己的音乐也要停
      return { log: window.__log.map((x) => x[0]), playing: AUDIO.playing, track: AUDIO.track };
    });
    chk('关掉背景声时，原生音乐也停了（不会偷偷继续放）',
      stop.log.indexOf('musicStop') >= 0 && !stop.playing && !stop.track, stop.log.join(','));

    const forget = await p.evaluate(() => {
      window.__log = [];
      window.__onMusic({ type: 'forgot', has: false, name: '', playing: false, persist: true });
      const li = allTracks().find((t) => t.id === MY_TRACK);
      return { name: li.name, text: document.getElementById('toast').textContent };
    });
    chk('忘掉之后列表回到「我自己的音乐」（不再显示那个文件名）',
      forget.name === '我自己的音乐', forget.name);
    chk('提示里写明「不会删你手机里的音乐」', /没动|没删|不会删/.test(forget.text), forget.text);

    const broken = await p.evaluate(() => {
      // 选过、但文件没了（has=false）
      window.__onMusic({ type: 'error', detail: '这个文件播不了', has: false, name: 'x', playing: false, persist: false });
      return {
        playing: AUDIO.playing,
        toastText: document.getElementById('toast').textContent,
        // 播放失败之后不能还显示"响着"
        fab: (document.getElementById('audioFab') || {}).className || '',
      };
    });
    chk('文件播不了时如实报错，并且不会继续显示「响着」',
      /播不了/.test(broken.toastText) && !broken.playing && !/on/.test(broken.fab),
      `${broken.toastText} fab="${broken.fab}"`);

    chk('全程没有 JS 报错（原生桥这条线）', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* 「重装之后」「没选过」这两个状态：不在电脑上测原生，只看界面分支 */
  console.log('\n[二、没有原生桥（电脑上打开）]');
  {
    const { p, errs } = await open(b, { tts: false, http: false, music: false }, null);
    const r = await p.evaluate(() => {
      openSettings('sound');
      const t = (document.querySelector('#setBody') || document.body).textContent;
      return {
        supported: musicSupported(),
        inList: allTracks().some((t2) => t2.id === MY_TRACK),
        saysNeedsPhone: /装到手机上才有/.test(t),
        // 电脑上没有原生桥时，不该出现"点了没反应"的按钮。
        // 注意要查**按钮**（onclick），不能查文字——上面那段说明里也有"从手机里挑一个"，
        // 拿文字当判据会红在一个假对象上（这条断言第一版就是这么红的）。
        pickBtn: /pickMyMusic\(\)/.test(t),
      };
    });
    chk('电脑上不显示「我自己的音乐」这一条（那是点了没用的按钮）',
      !r.supported && !r.inList && r.saysNeedsPhone && !r.pickBtn, JSON.stringify(r));
    chk('电脑上也没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await p.close();
  }

  /* ================================================== 三、四、五：语音识别
   *
   * 原第三～五节测的是「识别三层路由」（有服务 / 只有识别界面 / 两层都没有）
   * 和「诊断分层」。2.31 把听你说话整块删掉之后，这些函数
   * （asrCap / asrAvailable / asrHandsFreeOk / asrDiagnose / openVoiceSettings /
   * startListen / listen / listenViaActivity / stopListening）在 public/ 里一个都不剩，
   * 断言它们只会当场 ReferenceError。整节删除——**不是**换个写法糊回来。
   * 现在这台 App 的输入方式是打字：那部分由 check_voice_talk.js 和
   * check_talk_history.js 盯着。
   */

  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
