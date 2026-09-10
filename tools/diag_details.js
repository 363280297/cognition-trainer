/* 探一下：收起的 <details> 里的输入框为什么还能量到矩形。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const info = await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    openDailySettings();
    const add = document.getElementById('addPkg');
    const det = add ? add.closest('details') : null;
    const r = add ? add.getBoundingClientRect() : null;
    const cs = add ? getComputedStyle(add) : null;
    return {
      found: !!add,
      insideDetails: !!det,
      detailsOpen: det ? det.open : null,
      detailsClass: det ? det.className : null,
      rect: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } : null,
      clientRects: add ? add.getClientRects().length : -1,
      checkVisibility: add && add.checkVisibility
        ? add.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) : 'n/a',
      display: cs ? cs.display : null,
      visibility: cs ? cs.visibility : null,
      contentVisibility: cs ? cs.contentVisibility : null,
      // 外面那层的 HTML 长什么样
      outer: det ? det.outerHTML.replace(/\s+/g, ' ').slice(0, 400) : '',
      // 这个 details 的父链上有没有被强制显示的
      parentDisplay: det ? getComputedStyle(det).display : null,
      lastChildOfDetails: det && det.lastElementChild ? det.lastElementChild.tagName : null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})();
