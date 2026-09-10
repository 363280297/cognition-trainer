/* 建场景页 + 免提对话页的截图，方便人眼确认排版。不参与测试。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1180 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href,
    { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    V.native = null; V.sess = null;
    go('ai'); setAiSubview('voice');
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(__dirname, '_setup.png') });

  // 免提对话中：装个桩，让她说话 / 收麦两种状态各来一张
  await p.evaluate(async () => {
    V.native = {
      capabilities: () => JSON.stringify({ tts: true, asr: true, http: true, mic: true }),
      listen: () => {}, stopListening: () => {}, speak: () => {}, stopSpeak: () => {},
    };
    V.caps = { tts: true, asr: true, http: true, mic: true };
    window.llmCall = async () => ({
      reply: '好吧，那你说说看。', tone: '平淡',
      inner: '他倒是没急着辩解，我先听听。', signal: '接住了，但没有追下去',
      rating: '好', rating_why: '没有当场顶回去', temp: 54, temp_delta: 4,
    });
    await startSession((CONTENT.scenarios.scenarios || [])[0]);
    V.phase = 'speaking';
    renderTalkBar();
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(__dirname, '_talk_speaking.png') });

  await p.evaluate(() => { V.phase = 'listening'; renderTalkBar(); });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(__dirname, '_talk_listening.png') });

  // 复盘页
  await p.evaluate(() => {
    window.llmCall = async (m) => (/复盘/.test(m[0].content) ? {
      verdict: '这一局你没有当场反驳，这是对的。但整局没有一个追问，所以话题一直停在事上，没往人身上走。',
      pattern: '你一直在回答，没有一次把话头递回去。',
      keeps: ['被当面否定时先问了一句「你担心哪一块」', '没有用「但是」接他的话'],
      fixes: [{ act: '至少追问一次他的顾虑', say: '你最担心的是哪一块？我想先听这个。',
                why: '追问会让他觉得你真在听，而不是等着轮到自己说。' }],
      one: '每一局至少追问一次对方刚说的细节',
    } : { reply: '嗯。', tone: '平淡', inner: '…', rating: '漏着', rating_why: '没接住', temp: 44, temp_delta: -6 });

  });
  await p.evaluate(async () => {
    await userSaid('你担心的是哪一块？我想先听这个。');
    endSession();
  });
  await p.waitForTimeout(700);
  await p.evaluate(() => { document.getElementById('debriefBody').scrollIntoView(); });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(__dirname, '_debrief.png') });

  await b.close();
})();
