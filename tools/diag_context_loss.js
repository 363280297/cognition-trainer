/* 诊断「AI 模块上下文容易丢失」到底是丢在哪一步。
   用户的原话：「认知训练中AI模块上下文很容易丢失。」
   猜三种可能，逐个实测，不靠读代码下结论：
     A. 切到别的 tab 再回来 —— 对话还在不在（内存里的 V.sess）
     B. 整页重载（≈ 手机上被系统杀掉 / 划掉再打开）—— 回来看到什么
     C. 重载之后，能不能一眼接着刚才那局聊（还是要去历史里翻）
   只打印，不动任何东西。 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

const TURN = (n) => ({ reply: `她说的第 ${n} 句`, tone: '平淡', inner: `她心里的第 ${n} 句`,
  signal: '信号 ' + n, rating: '好', rating_why: '还行', temp: 50 + n, temp_delta: 1 });

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    V.native = null; state.talks = []; state.genScenes = []; save();
    let n = 0;
    window.llmCall = async () => ({
      reply: `她说的第 ${++n} 句`, tone: '平淡', inner: `她心里的第 ${n} 句`,
      signal: '信号 ' + n, rating: '好', rating_why: '还行', temp: 50 + n, temp_delta: 1,
    });
    go('ai'); setAiSubview('voice');
  });

  // 开一局，实打实走"打字回她"这条路
  const started = await p.evaluate(async () => {
    const sc = allSceneList()[0];
    await startSession(sc.id);
    return { id: sc.id, title: sc.title };
  });
  for (const t of ['第一句我说的话', '第二句我说的话']) {
    await p.evaluate(async (txt) => {
      document.getElementById('typeIn').value = txt;
      await sendTyped();
    }, t);
    await p.waitForTimeout(120);
  }
  const live = await p.evaluate(() => ({
    log: V.sess ? V.sess.log.length : -1,
    hist: V.sess ? V.sess.history.length : -1,
    turn: V.sess ? V.sess.turn : -1,
    bubbles: document.querySelectorAll('#herSlot .bubble, #herSlot .her-card, #herSlot .turn').length,
    talksSaved: talks().length,
    talkDone: talks()[0] ? talks()[0].done : null,
  }));
  console.log(`\n[A] 开局「${started.title}」聊了 2 轮之后：`);
  console.log(`    内存里 log ${live.log} 条 / history ${live.hist} 条 / turn=${live.turn}`);
  console.log(`    屏幕上的对话元素 ${live.bubbles} 个；历史里存了 ${live.talksSaved} 条（done=${live.talkDone}）`);

  // A. 切到别的 tab 再回来
  const afterSwitch = await p.evaluate(() => {
    go('today'); go('practice'); go('growth');
    go('ai');
    return {
      hasSess: !!V.sess, log: V.sess ? V.sess.log.length : -1,
      text: (document.querySelector('#view').textContent || '').slice(0, 60),
      shownMine: (document.querySelector('#view').textContent || '').indexOf('第一句我说的话') >= 0,
      isSetup: /今天就练这个|自己出一个题/.test(document.querySelector('#view').textContent || ''),
      inputThere: !!document.getElementById('typeIn'),
    };
  });
  console.log('\n[B] 切到「今天/练习/成长」再切回 AI：');
  console.log(`    V.sess ${afterSwitch.hasSess ? '还在' : '**没了**'}（log ${afterSwitch.log} 条）`);
  console.log(`    屏幕上：${afterSwitch.isSetup ? '**回到了选场景页**' : '还是对话页'}；`
    + `我说过的那句还在屏上吗：${afterSwitch.shownMine ? '在' : '**不在**'}；输入框：${afterSwitch.inputThere ? '在' : '**没了**'}`);

  // B. 整页重载（≈ 手机上被系统杀掉再打开）
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const afterReload = await p.evaluate(() => {
    document.querySelectorAll('.sheet,.gate').forEach((s) => s.remove());
    go('ai'); setAiSubview('voice');
    const t = document.querySelector('#view').textContent || '';
    return {
      hasSess: !!V.sess,
      talks: talks().map((x) => ({ title: x.sc && x.sc.title, done: x.done, rounds: x.log.length })),
      isSetup: /今天就练这个|自己出一个题/.test(t),
      mentionsUnfinished: /没聊完|接着聊|接着刚才/.test(t),
      head: t.replace(/\s+/g, ' ').slice(0, 120),
    };
  });
  console.log('\n[C] 整页重载之后（相当于被系统杀掉再打开）：');
  console.log(`    V.sess ${afterReload.hasSess ? '还在' : '**没了**'}`);
  console.log(`    历史里存着：${JSON.stringify(afterReload.talks)}`);
  console.log(`    AI 页显示：${afterReload.isSetup ? '选场景页' : '对话页'}`);
  console.log(`    有没有提示还有一局没聊完、能不能一键接着聊：${afterReload.mentionsUnfinished ? '有' : '**没有**'}`);
  console.log(`    首屏文字：${afterReload.head}`);

  console.log(errs.length ? `\n页面报错：${errs.join(' | ')}` : '\n页面报错：无');
  await b.close();
})();
