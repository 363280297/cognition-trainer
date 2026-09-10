/* 给「提示」和「白话回落」拍图，放进 output/（和其它截图脚本一致）。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;
const OUT = path.join(__dirname, '..', 'output');
fs.mkdirSync(OUT, { recursive: true });

const SC = {
  id: 's1', title: '刚认识两周，第一次单独出来', stage: '认识试探', difficulty: 2,
  her: '26 岁，做设计的，性格偏慢热。你们是朋友介绍认识的，微信聊了两周，今天是第一次单独见面。',
  her_state: '她其实有点紧张，也怕尴尬。她最在意的是「跟你在一起累不累」。',
  opening: '你好，等很久了吗？', goal: '让她放松地说话', trap: '一直找话题表现自己',
};

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: true, asr: false, asrAct: false, http: true, mic: true, music: false }),
      voices: () => '[]', currentVoice: () => '', speak: () => {}, stopSpeak: () => {}, setVoice: () => {},
      listen: () => {}, stopListening: () => {},
      httpPost: async (id) => window.__onHttp(id, JSON.stringify({ status: 200, body: JSON.stringify({
        choices: [{ message: { content: '听起来今天把你折腾得够呛。' }, finish_reason: 'stop' }] }) })),
    };
    V.native = window.EQNative; probeNative();
    saveSettings({ apiKey: 'sk-test', autoSpeak: false, audioAsk: false });
  });
  await p.evaluate(async (sc) => { await startSession(sc); }, SC);
  await p.waitForTimeout(300);

  // 1) 提示面板（她第一句是问句 → 应该给「先正面回答，再递回去一句」）
  await p.evaluate(() => {
    openTalkHint();
    document.getElementById('talkHint').scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'hint-open.png') });

  // 2) 要一句示范之后
  await p.evaluate(async () => { await talkHintDemo(); });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'hint-demo.png') });

  // 3) 白话回落那一轮：模型只给一句人话
  await p.evaluate(async () => {
    window.EQNative.httpPost = async (id) => window.__onHttp(id, JSON.stringify({ status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '我也就是随便逛逛，没什么计划。' }, finish_reason: 'stop' }] }) }));
    await userSaid('你今天有什么安排吗？');
    document.getElementById('herSlot').lastElementChild.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'plain-reply.png') });

  // 4) 情绪句的提示：走**真实路径**（让模型回一句带情绪的话），
  //    而不是直接调 showHerTurn 塞一个假的——那样 history 没更新，
  //    lastHerLine() 读到的还是上一句，提示就会给错方向（第一版截图就是这么假的）。
  await p.evaluate(async () => {
    window.EQNative.httpPost = async (id) => window.__onHttp(id, JSON.stringify({ status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '今天好累啊，项目一直改需求，烦死了。' }, finish_reason: 'stop' }] }) }));
    await userSaid('那你最近工作忙吗？');
    openTalkHint();
    document.getElementById('talkHint').scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(OUT, 'hint-feel.png') });

  console.log('截图：');
  ['hint-open.png', 'hint-demo.png', 'plain-reply.png', 'hint-feel.png']
    .forEach((f) => console.log('  output/' + f));
  await b.close();
})();
