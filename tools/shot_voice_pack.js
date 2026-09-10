/* 出图：音色面板 + 识别模式。人眼确认排版。不参与测试。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

const PHONE = [
  { name: 'zh-cn-x-ccc-network', locale: 'zh-CN', quality: 500, latency: 300, network: true, installed: true },
  { name: 'zh-cn-x-ccc-local', locale: 'zh-CN', quality: 400, latency: 200, network: false, installed: true },
  { name: 'zh-cn-x-ddd-local', locale: 'zh-CN', quality: 300, latency: 300, network: false, installed: true },
  { name: 'zh-cn-x-eee-network', locale: 'zh-CN', quality: 500, latency: 300, network: true, installed: false },
  { name: 'zh-cn-x-fff-local', locale: 'zh-CN', quality: 400, latency: 200, network: false, installed: true },
];

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1180 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  await p.evaluate((phone) => {
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, asr: true, http: true, mic: true }),
      voices: () => JSON.stringify(phone),
      setVoice: () => { },
      currentVoice: () => 'zh-cn-x-ccc-local',
      installVoiceData: () => { },
      openTtsSettings: () => { },
      speak: () => { },
      stopSpeak: () => { },
      listen: () => { },
      stopListening: () => { },
    };
    V.native = window.EQNative;
    V.caps = JSON.parse(window.EQNative.capabilities());
    VOICE_LIST = null;
    saveSettings({ voice: 'zh-cn-x-ccc-local' });
  }, PHONE);
  // 开机后会有一次__gateKick：没达标就异步弹出闸门面板，把设置页盖住。
  // 所以先把今天标成已达标（dailyProgress().met），它就不会弹了；
  // 再等一会儿让所有异步流程跑完，最后才开设置页。
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    state.daily = Object.assign({}, state.daily, { met: true, cards: 4, lessons: 1 });
    save();
  });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((x) => x.remove());
    openSettings();
    // 开机流程里「每日计划」那张面板是异步弹出的，会盖在我的设置页上面。
    // 截图前把它清掉，并确认音色区真的在。
    const box = document.getElementById('voiceBox');
    if (box) box.scrollIntoView({ block: 'start' });
  });
  await p.waitForTimeout(400);
  console.log(await p.evaluate(() => JSON.stringify({
    sheets: document.querySelectorAll('.sheet').length,
    hasVoiceBox: !!document.getElementById('voiceBox'),
    items: document.querySelectorAll('.voice-item').length,
  })));
  await p.screenshot({ path: path.join(__dirname, '_voice_pack.png') });

  await p.evaluate(() => {
    const el = document.getElementById('asrHint');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_asr_mode.png') });

  await b.close();
})();
