/* 把设置面板的滚动限制临时去掉，再整页截图。
   浮层的内容区是 max-height:88vh + overflow:auto，fullPage 截不到里面滚动的内容——
   所以要看全一整段，只能把它改成不限制高度。这是**只为肉眼审查**的截图，
   不改产品行为（改的是截图时的样式，不写回文件）。 */
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

  const shot = async (section, file, openFold) => {
    await p.evaluate(({ sec, open }) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      window.fetch = () => Promise.resolve({ json: async () => ({}) });
      V.native = { capabilities: () => JSON.stringify({ tts: true, asr: true, http: false, mic: false }) };
      openSettings(sec);
      let st = document.getElementById('fullview');
      if (!st) {
        st = document.createElement('style');
        st.id = 'fullview';
        // 只为截图：把浮层的滚动限制去掉，让整段都能被截到
        st.textContent = '.sheet .inner{max-height:none!important;position:static!important;'
          + 'border-radius:0!important} .sheet{background:#12131a!important}';
        document.head.appendChild(st);
      }
      const d = document.querySelector('#setBody details.set-details');
      if (d) d.open = !!open;
    }, { sec: section, open: !!openFold });
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, file), fullPage: true });
  };

  await shot('sound', 'v-sound.png', true);      // 声音区，折叠块展开
  await shot('daily', 'v-daily.png', false);
  await shot('gate', 'v-gate.png', false);
  await shot('data', 'v-data.png', false);
  console.log('已写入 output/v-*.png');
  await b.close();
})();
