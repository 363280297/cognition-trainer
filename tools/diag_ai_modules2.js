/* 正确地点一次「体检」和「出题」，看 APK 里（= 离线单文件版）这两个模块到底能不能用。
 *
 * 上一版我点错了按钮（点到了标题旁的同一个词），于是「没有请求」什么也说明不了。
 * 这次直接调真正的处理函数 runCheckup() / runReplayQuestions()。
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
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

  const ck = await p.evaluate(async () => {
    go('ai'); setAiSubview('checkup');
    document.getElementById('ckText').value = '今天这条裙子很好看，是想见我吗？';
    document.getElementById('ckCtx').value = '认识两个月，单独出来过五次';
    await runCheckup();
    return { out: document.getElementById('ckOut').textContent.replace(/\s+/g, ' ').trim() };
  });
  console.log('\n[表达体检 · 提交后]');
  console.log('  ' + (ck.out || '(输出区是空的)'));

  const rp = await p.evaluate(async () => {
    go('ai'); setAiSubview('replay');
    document.getElementById('rpChat').value = '我：在吗\n她：嗯\n我：在干嘛呢\n她：没干嘛';
    await runReplayQuestions();
    return { out: document.getElementById('view').textContent.replace(/\s+/g, ' ').slice(-320) };
  });
  console.log('\n[真实复盘 · 提交后]');
  console.log('  ' + rp.out);

  // 场景对话走的是原生桥，不是 /api/*，所以它应该是好的——顺便确认一下
  const chat = await p.evaluate(() => {
    go('ai'); setAiSubview('voice');
    return { hasToday: !!document.querySelector('.daily-scene'),
             hint: document.querySelector('.daily-scene') ? '今天就练这个在场' : '不在场' };
  });
  console.log('\n[场景对话] ' + chat.hint);

  await b.close();
})();
