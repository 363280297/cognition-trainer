/* 给这次新增的两块界面拍图：设置里的「我自己的音乐」、以及识别诊断。
   截图放在 tools/out/ 里（不放桌面——桌面只留 APK，这是用户定的规矩）。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const OUT = path.join(__dirname, '..', 'output');   // 和其它截图脚本一致
fs.mkdirSync(OUT, { recursive: true });

const STUB = `
  window.__caps = {tts:true, asr:false, asrAct:false, http:true, mic:true, music:true};
  window.EQNative = {
    capabilities: () => JSON.stringify(window.__caps),
    asrProbe: () => JSON.stringify({ service:false, activity:false, activityApp:'', engines:[], sdk:33 }),
    voices: () => '[]', currentVoice: () => '', musicState: () => {},
    musicPlay: () => {}, musicStop: () => {}, musicPick: () => {}, musicSetVolume: () => {},
    musicDuck: () => {}, openVoiceSettings: () => {},
    hasAccessibility: () => false, hasOverlayPermission: () => true, hasNotifPermission: () => true,
  };
`;

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await p.addInitScript(STUB);
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);

  // 1) 没选过文件时的「我自己的音乐」
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    openSettings('sound');
    document.getElementById('musicBox').scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'music-empty.png') });

  // 2) 选过文件之后
  await p.evaluate(() => {
    window.__onMusic({ type: 'picked', has: true, name: '晴天.mp3', playing: true, persist: true });
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'music-picked.png') });

  // 3) 识别诊断：两层都没有
  await p.evaluate(() => {
    const el = document.getElementById('asrDiag');
    el.scrollIntoView({ block: 'center' });
    asrDiagnose();
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'asr-diag-none.png') });

  // 4) 识别诊断：有服务
  await p.evaluate(() => {
    window.__probe = { service: true, activity: true, activityApp: 'com.google.android.googlequicksearchbox',
                       engines: ['com.google.android.googlequicksearchbox'], sdk: 33 };
    asrDiagnose();
    document.getElementById('asrDiag').scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'asr-diag-ok.png') });

  // 5) 选场景页上"没有识别引擎"的那段说明（用户会看到的第一处）
  await p.evaluate(() => {
    closeSheet();
    V.sess = null; V.caps.asr = false; V.caps.asrAct = false;
    setAiSubview('voice');
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'setup-no-asr.png') });

  console.log('截图输出到', OUT);
  fs.readdirSync(OUT).forEach((f) => console.log('  ' + f));
  await b.close();
})();
