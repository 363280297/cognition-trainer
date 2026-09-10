/* 先确认一件事：APK 里（= 这份离线单文件版）「表达体检」和「真实复盘」到底能不能用。
 *
 * 它们走的是 /api/ai/checkup、/api/ai/replay/*，而离线适配层对这三个地址一律返回 503。
 * 如果确认是死的，那用户问「token 消耗」时有一半答案是「那两个模块根本不发请求」——
 * 同时也说明 README 把它们列成可用功能是不准确的。
 */
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
  const reqs = [];
  p.on('request', (r) => { if (/\/api\//.test(r.url())) reqs.push(r.url()); });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

  // 表达体检：填一句话提交
  const ck = await p.evaluate(async () => {
    go('ai'); setAiSubview('checkup');
    const ta = document.querySelector('#view textarea, #view input[type=text]');
    if (ta) ta.value = '在吗？在干嘛呢？怎么不回我';
    const btn = [...document.querySelectorAll('#view button')].find((x) => /体检|看看|分析|开始/.test(x.textContent));
    const label = btn ? btn.textContent.trim() : '(没找到提交按钮)';
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      label,
      out: document.getElementById('view').textContent.replace(/\s+/g, ' ').slice(0, 260),
    };
  });
  console.log('\n[表达体检]');
  console.log('  提交按钮：' + ck.label);
  console.log('  提交后界面：' + ck.out);

  // 真实复盘：贴一段聊天记录提交
  const rp = await p.evaluate(async () => {
    go('ai'); setAiSubview('replay');
    const ta = document.querySelector('#view textarea');
    if (ta) ta.value = '我：在吗\n她：嗯\n我：在干嘛呢\n她：没干嘛';
    const btn = [...document.querySelectorAll('#view button')].find((x) => /复盘|开始|出题|分析/.test(x.textContent));
    const label = btn ? btn.textContent.trim() : '(没找到提交按钮)';
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      label,
      out: document.getElementById('view').textContent.replace(/\s+/g, ' ').slice(0, 260),
    };
  });
  console.log('\n[真实复盘]');
  console.log('  提交按钮：' + rp.label);
  console.log('  提交后界面：' + rp.out);

  console.log('\n[实际发出的 /api 请求]');
  console.log('  ' + (reqs.length ? reqs.join('\n  ') : '(没有)'));
  await b.close();
})();
