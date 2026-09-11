/* 卡片反馈的检查：答对 / 答错 / 答得差不多，三条路各给了什么。

为什么单独写这个：2026-09-11 核内容时发现——**答得差不多（次优）得到的反馈
比答错还少**。原因是「你选的这条」那一块的条件写成了「不是首选 且 有偏差类型」，
而次优选项的 err 是「正解」（不在 BIAS_TYPES 里，取出来 undefined），
于是整块不渲染：那条选项自己的 why（数据里早就写好了）哪里都没显示。

而次优恰恰是最值得讲的一类——它是最接近的错法，差在哪才是要学的点。
当时**没有任何测试碰过卡片反馈**（grep 遍 tools/ 找不到一处），所以它一直没被发现。

这里把三条路都钉住：次优必须和答错一样，把「你选的这条」讲清楚。

node tools/check_card_feedback.js
*/
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const errs = [];

  /** 答一张卡，把反馈里能观察到的都带回来。card 由 picker 挑，answer 决定选哪个 id。 */
  const answer = async (picker, which) => {
    const p = await b.newPage({ viewport: { width: 412, height: 900 } });
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(OFFLINE, { waitUntil: 'load' });
    await p.waitForFunction('document.getElementById("view") && document.getElementById("view").children.length > 0');
    const r = await p.evaluate(({ pickerSrc, which }) => {
      document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
      const card = eval('(' + pickerSrc + ')')();
      if (!card) return { err: '没找到符合要求的卡' };
      const id = which === 'best' ? card.best
        : which === 'half' ? (card.ok || [])[0]
          : card.options.find((o) => o.err && o.err !== '正解').id;
      session.queue = [card];
      session.i = 0; session.lowLoad = false; session.genrePick = null; session.cluePick = null;
      go('practice');
      renderCard();
      answerCard(id);
      const fb = document.querySelector('#fb');
      const text = fb.textContent.replace(/\s+/g, ' ');
      const opt = card.options.find((o) => o.id === id);
      const bestOpt = card.options.find((o) => o.id === card.best);
      return {
        cardId: card.id, picked: id, best: card.best,
        verdict: (fb.querySelector('h3') || {}).textContent.trim(),
        mineLabel: (fb.querySelector('.diag-mine .label') || {}).textContent || '',
        mineTags: [...fb.querySelectorAll('.diag-mine .tag')].map((t) => t.textContent.trim()),
        // 三条路都必须显示的东西
        hasBestBlock: /首选答案/.test(text),
        hasPrinciple: /要记住的原理/.test(text),
        // 你选的那条自己的 why 有没有被显示（取一段特征串）
        ownWhyShown: opt && opt.why ? text.includes(opt.why.slice(0, 16)) : null,
        ownWhyProbe: opt && opt.why ? opt.why.slice(0, 16) : '',
        bestWhyShown: bestOpt && bestOpt.why ? text.includes(bestOpt.why.slice(0, 16)) : null,
        hasBiasFix: /往这个方向改/.test(text),
        hasVsBest: /它和首选差在哪/.test(text),
      };
    }, { pickerSrc: picker, which });
    await p.close();
    return r;
  };

  // 挑没有读局/依据步骤的卡，流程最短，测的就是反馈本身
  const P_HALF = '() => CONTENT.cards.cards.find((c) => (c.ok || []).length && !c.genre && !c.clues)';
  const P_WRONG = '() => CONTENT.cards.cards.find((c) => !c.genre && !c.clues'
    + ' && c.options.some((o) => o.err && o.err !== "正解"))';
  const P_ANY = '() => CONTENT.cards.cards.find((c) => !c.genre && !c.clues)';

  console.log('\n[一、答对]');
  const ok = await answer(P_ANY, 'best');
  chk('判定是「判断正确」', ok.verdict === '判断正确', ok.verdict);
  chk('答对时不出现「你选的这条…」（没什么可挑的）', ok.mineLabel === '', ok.mineLabel);
  chk('仍然给出首选答案和原理', ok.hasBestBlock && ok.hasPrinciple);

  console.log('\n[二、答错：要诊断 + 改法]');
  const bad = await answer(P_WRONG, 'wrong');
  chk('判定是「差了」', bad.verdict === '差了', bad.verdict);
  chk('标题是「问题出在哪」', /问题出在哪/.test(bad.mineLabel), bad.mineLabel);
  chk('标出了偏差类型（如「过度解读」）', bad.mineTags.length > 0, bad.mineTags.join(','));
  chk('显示了他选的那条自己的 why', bad.ownWhyShown === true, bad.ownWhyProbe);
  chk('给了「往这个方向改」', bad.hasBiasFix);

  console.log('\n[三、答得差不多（次优）：原来这里反馈比答错还少]');
  const half = await answer(P_HALF, 'half');
  chk('判定是「也算说得通，但不是首选」', /也算说得通/.test(half.verdict), half.verdict);
  chk('**次优也要有「你选的这条」这一块**（原来整块不渲染）',
    /你选的这条/.test(half.mineLabel), half.mineLabel || '(整块没出现)');
  chk('标题说清是「为什么不是首选」', /为什么不是首选/.test(half.mineLabel), half.mineLabel);
  chk('**显示了他选的那条自己的 why**（数据里写了却从没显示过）',
    half.ownWhyShown === true, half.ownWhyProbe);
  chk('说明它和首选差在哪', half.hasVsBest);
  chk('次优不是读错，所以不给「往这个方向改」（那是给偏差用的）', !half.hasBiasFix);
  chk('次优仍然给出首选答案和原理', half.hasBestBlock && half.hasPrinciple);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(`\n结果：${fail ? fail + ' 项失败' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
