/* 出图：AI 页（今天就练这个）+ 设置页的模型选择。人眼确认。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1150 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    state.scenes = { s1: 2, s4: 1 };
    save();
    go('ai'); setAiSubview('voice');
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_ai_today.png') });

  await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    const el = document.getElementById('modelHint');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_models.png') });

  await b.close();
})();
