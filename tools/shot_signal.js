/* 给信号场的几个画面截图，用来肉眼看一下版式。
   断言过了不等于好看：两个按钮要够大、够分清，进度点要能看出对了错了。 */
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
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.EQNative = { capabilities: () => JSON.stringify({ tts: false, asr: false, http: false, mic: false }),
      speak: () => { }, stopSpeak: () => { }, listen: () => { }, stopListening: () => { } };
    V.native = window.EQNative;
    window.fetch = (u) => Promise.resolve({ json: async () => ({}) });
    go('practice'); setPracticeSubview('signal');
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'sig-1-intro.png'), fullPage: true });

  // 玩几条，凑出「有对有错」的进度点
  await p.evaluate(() => {
    startSignalGame();
    const pattern = [true, false, true, true, false, true];
    for (let k = 0; k < 6; k++) {
      const it = game.deck[game.i];
      answerSignal(k === 4 ? !!it.exclusive : (it.exclusive ? pattern[k] : !pattern[k]));
      nextSignal();
    }
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'sig-2-round.png'), fullPage: true });

  // 答完一条之后的反馈画面
  await p.evaluate(() => { answerSignal(true); });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'sig-3-feedback.png'), fullPage: true });

  // 结算
  await p.evaluate(() => {
    startSignalGame();
    for (let k = 0; k < 20; k++) {
      const it = game.deck[game.i];
      answerSignal(k < 3 ? !it.exclusive : !!it.exclusive);
      nextSignal();
    }
    viewSignal();
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'sig-4-result.png'), fullPage: true });
  console.log('截图已写入 output/');
  await b.close();
})();
