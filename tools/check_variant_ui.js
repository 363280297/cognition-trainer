/* Exercise the shipped offline UI in a fresh, disposable browser context.
 * No server, API keys, existing browser profile or user's progress file. */
const { chromium } = require('E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const started = Date.now();
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EQ_CHROME ||
    'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, '认知训练-离线版.html')).href);
    await page.waitForFunction(() => document.getElementById('view')?.children.length);
    const result = await page.evaluate(() => {
      document.querySelectorAll('.sheet, .gate').forEach((e) => e.remove());
      go('practice'); setPracticeSubview('cards');
      const failures = [], all = CONTENT.cards.cards;
      let checked = 0, reads = 0;
      const plain = (s) => String(s).replace(/\*\*/g, '');
      const expect = (cond, message) => { if (!cond) throw Error(message); };
      for (const base of all) for (let index = 0; index < 3; index++) {
        const authored = [base, ...base.variants][index];
        try {
          state.srs[base.id] = { seen: index, due: 0, interval: 1, ease: 2.5 };
          const card = applyVariant(base);
          expect(card.formId === authored.id, 'wrong form selected');
          session = { queue: [card], i: 0, lowLoad: false, genrePick: null, cluePick: null };
          renderCard();
          expect(document.querySelector('.prompt').textContent === plain(authored.question), 'question mismatch');
          expect(document.querySelector('.scene').textContent === plain(authored.context), 'scenario mismatch');
          expect(document.querySelectorAll('#opts .opt').length === 4, 'missing options');
          expect(!document.querySelector('#fb').textContent.trim(), 'feedback leaked before answer');
          if (card.genre) {
            reads++;
            expect(document.getElementById('opts').style.display === 'none', 'read gate missing');
            [...document.querySelectorAll('#genreStep button')].find((b) => b.dataset.g === authored.genre).click();
            expect(document.getElementById('opts').style.display === 'none', 'clue gate missing');
            const clue = authored.clues.findIndex((c) => c.ok);
            document.querySelector(`#clueStep [data-c="${clue}"]`).click();
            expect(document.getElementById('opts').style.display !== 'none', 'clues cannot unlock answers');
          }
          const selected = card.options.find((o) => o.id === card.best);
          expect(selected.text === authored.options.find((o) => o.id === authored.best).text, 'answer mapping mismatch');
          document.querySelector(`#opts [data-id="${card.best}"]`).click();
          const fb = document.querySelector('#fb').textContent;
          expect(fb.includes('判断正确'), 'correct answer marked wrong');
          expect(fb.includes(plain(selected.why)), 'own answer rationale missing');
          // explain is intentionally behind the accessible “为什么” disclosure button;
          // assert the control and its payload rather than requiring hidden text in #fb.
          const whyButton = [...document.querySelectorAll('#fb button')].find((b) => b.textContent.includes('为什么'));
          expect(whyButton, 'explanation disclosure missing');
          const popId = whyButton.getAttribute('onclick')?.match(/openPop\('([^']+)'\)/)?.[1];
          expect(popId && POP_STORE[popId]?.body === authored.explain, 'explanation payload missing');
          expect(fb.includes(plain(authored.plan.if)) && fb.includes(plain(authored.plan.then)), 'own plan missing');
          const record = state.answers[state.answers.length - 1];
          expect(record.id === base.id && record.formId === authored.id && record.answerKey === authored.best && record.ok, 'wrong persisted source or score');
          expect(state.srs[base.id].seen === index + 1, 'family progress not incremented');
          expect(!state.srs[base.id + '-v1'] && !state.srs[base.id + '-v2'], 'family progress split');
          checked++;
        } catch (e) { failures.push(`${authored?.id || base.id}: ${e.message}`); }
      }
      clearCardTimer();
      return { checked, reads, failures, groups: all.length };
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.checked, result.groups * 3);
    assert.ok(result.checked >= 360 && result.reads >= 36);
    const dir = path.join(root, 'output', 'validation');
    fs.mkdirSync(dir, { recursive: true });
    await page.evaluate(() => {
      const base = CONTENT.cards.cards.find((c) => c.id === 'c01');
      state.srs[base.id].seen = 1;
      session = { queue: [applyVariant(base)], i: 0, lowLoad: false, genrePick: null, cluePick: null };
      renderCard(); window.scrollTo(0, 0);
    });
    await page.screenshot({ path: path.join(dir, 'variant-question.png'), fullPage: true });
    await page.evaluate(() => document.querySelector(`#opts [data-id="${session.queue[0].best}"]`).click());
    await page.screenshot({ path: path.join(dir, 'variant-feedback.png'), fullPage: true });
    await page.evaluate(() => {
      fillPlan(session.queue[0].id); savePlan(session.queue[0].id);
      renderPlans();
    });
    await page.getByRole('button', { name: '看这道题', exact: true }).last().click();
    assert.ok((await page.locator('.scene').textContent()).includes('补光灯'));
    await page.setViewportSize({ width: 900, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    assert.deepEqual(errors, []);
    console.log(`结果：${result.groups} 组 / ${result.checked} 道 UI 判分通过（含 ${result.reads} 道读局），预案来源及桌面布局通过；${Date.now() - started}ms`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
