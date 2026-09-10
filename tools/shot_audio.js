/* 背景声与设置页的截图，用来肉眼看版式。
   断言过了不等于好看，也不等于"设置页像大部分软件那样"——那个只能看。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OUT = path.join(__dirname, '..', 'output');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({
    executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const p = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.fetch = () => Promise.resolve({ json: async () => ({}) });
    V.native = { capabilities: () => JSON.stringify({ tts: true, asr: true, http: false, mic: false }) };
  });

  // 1 进来时问的那个框
  await p.evaluate(() => { saveSettings({ audioAsk: true }); maybeAskAudio(); });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'snd-1-ask.png'), fullPage: true });

  // 2 设置页 · 声音区
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    openSettings('sound');
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'snd-2-settings-sound.png'), fullPage: true });

  // 3 设置页 · 其余分区（拼一张）
  for (const k of ['ai', 'daily', 'gate', 'data', 'about']) {
    await p.evaluate((sec) => setSettingSection(sec), k);
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(OUT, `snd-3-settings-${k}.png`), fullPage: true });
  }

  // 4 界面 + 常驻按钮（开着声音的状态）
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    saveSettings({ audioAsk: false, audioTrack: 'waves', audioVolume: 0.3 });
    audioStart('waves');
    go('today');
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, 'snd-4-fab.png'), fullPage: false });
  console.log('截图已写入 output/');
  await b.close();
})();
