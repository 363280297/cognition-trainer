/* 针对三处怀疑点做定点测量（旧 CSS vs 新 CSS）：
   1) 成长页顶部那张卡里的「设置」按钮——截图上看它竖排成两行；
   2) 小标签 .tag 的高度——间距映射把 2px 四舍五入到 4px，盒子会整体变高；
   3) 底部 tab 条的高度。
   前两处都不是"溢出"，所以上一版的溢出扫描扫不到，只能定点量。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const CUR = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const OLD = pathToFileURL(path.join(__dirname, '..', '.tmpcmp', 'prev-step1.html')).href;

const PROBE = () => {
  const box = (sel) => {
    const e = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      lines: Math.max(1, Math.round(r.height / lh)),
      fs: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      pad: cs.paddingTop + '/' + cs.paddingRight,
    };
  };
  // 成长页那张卡里的两个按钮
  const row = document.querySelector('.daily-card .row');
  const btns = row ? [...row.querySelectorAll('button')].map((b) => ({
    t: b.textContent.trim(), ...box(b),
  })) : null;
  return {
    卡里的按钮: btns,
    小标签: box('.tag'),
    小标签内边距: (document.querySelector('.tag') || {}).style ? null : null,
    胶囊: box('.chip-btn'),
    tab条: box('.tabs'),
  };
};

async function run(b, url) {
  const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  await p.goto(url);
  await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
  await p.evaluate(() => document.querySelectorAll('.gate').forEach((s) => s.remove()));
  await p.evaluate(() => go('growth'));
  await p.waitForTimeout(500);
  const r = await p.evaluate(PROBE);
  await p.close();
  return r;
}

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--mute-audio'] });
  const o = await run(b, OLD);
  const n = await run(b, CUR);
  await b.close();
  console.log('=== 成长页「每日计划」卡里的按钮 ===');
  console.log('旧:', JSON.stringify(o.卡里的按钮));
  console.log('新:', JSON.stringify(n.卡里的按钮));
  console.log('\n=== 小标签 / 胶囊 / tab 条 ===');
  for (const k of ['小标签', '胶囊', 'tab条']) {
    console.log(k.padEnd(6) + '旧 ' + JSON.stringify(o[k]));
    console.log('      ' + '新 ' + JSON.stringify(n[k]));
  }
})();
