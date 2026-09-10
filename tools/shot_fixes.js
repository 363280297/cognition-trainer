/* 出图：偏差画像 / 我的预案 / 挑应用。人眼确认。不参与测试。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1120 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    // 造一点偏差数据，画像页才不是空的
    state.bias['过度解读'] = 4; state.bias['字面化'] = 3; state.bias['过度让步'] = 2;
    state.stats.answered = 47; state.stats.correct = 32;
    state.plans = [{ cardId: 'c01', ts: Date.now() - 86400000, text: '如果他当众否我，我先问他担心的是哪一块，不在会上争对错。' }];
    save();
    go('growth'); setGrowthSubview('bias');
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_bias.png') });

  await p.evaluate(() => setGrowthSubview('plans'));
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(__dirname, '_plans.png') });

  // 挑应用面板
  await p.evaluate(() => {
    window.EQNative = {
      listApps: () => JSON.stringify([
        { label: '王者荣耀', pkg: 'com.tencent.tmgp.sgame' },
        { label: '和平精英', pkg: 'com.tencent.tmgp.pubgmhd' },
        { label: '抖音', pkg: 'com.ss.android.ugc.aweme' },
        { label: '哔哩哔哩', pkg: 'tv.danmaku.bili' },
        { label: '小红书', pkg: 'com.xingin.xhs' },
        { label: '微信读书', pkg: 'com.tencent.weread' },
        { label: '原神', pkg: 'com.miHoYo.Yuanshen' },
        { label: '照片', pkg: 'com.android.gallery3d' },
      ]),
    };
    PKG_LIST = null;
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openAppPicker();
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    document.querySelector('.pkg-item[data-pkg="com.tencent.tmgp.sgame"]').click();
    document.querySelector('.pkg-item[data-pkg="com.ss.android.ugc.aweme"]').click();
    document.querySelector('.pkg-item[data-pkg="com.miHoYo.Yuanshen"]').click();
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(__dirname, '_picker.png') });

  // 设置页里闸门那一段（看折叠有没有收好）
  await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openDailySettings();
    const det = document.querySelector('details.diag-more');
    if (det) det.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_gate.png') });

  await b.close();
})();
