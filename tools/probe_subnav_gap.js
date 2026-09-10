/* AI 页那条切换条的左右空隙对不对称？——真机上看着右边贴边，量一下。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const F = (n) => pathToFileURL(path.join(__dirname, '..', n)).href;

async function m(b, url) {
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  await p.goto(url);
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length>0');
  await p.evaluate(() => document.querySelectorAll('.gate').forEach((s) => s.remove()));
  await p.evaluate(() => { go('ai'); setAiSubview('voice'); });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const main = document.querySelector('main');
    const nav = document.querySelector('.subnav');
    const first = document.querySelector('.subnav .chips .chip-btn');
    const act = document.querySelector('.subnav-act');
    const cs = getComputedStyle(main);
    const W = document.documentElement.clientWidth;
    return {
      视口: W,
      main左内边距: cs.paddingLeft, main右内边距: cs.paddingRight,
      nav宽: Math.round(nav.getBoundingClientRect().width),
      第一个胶囊左空隙: Math.round(first.getBoundingClientRect().left),
      动作胶囊右空隙: act ? Math.round(W - act.getBoundingClientRect().right) : null,
      动作胶囊宽: act ? Math.round(act.getBoundingClientRect().width) : null,
    };
  });
  await p.close();
  return r;
}

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--mute-audio'] });
  console.log('旧(第一步前):', JSON.stringify(await m(b, F('.tmpcmp/prev-step1.html'))));
  console.log('新(现在)    :', JSON.stringify(await m(b, F('认知训练-离线版.html'))));
  await b.close();
})();
