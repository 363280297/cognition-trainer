/* Content contract and runtime acceptance for every question, including variants.
 * These checks catch copied options and missing scene metadata; semantic quality
 * still requires reading the questions, not only passing this script. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const cards = JSON.parse(fs.readFileSync(path.join(root, 'data/cards.json'), 'utf8')).cards;
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.match(/function cardForms\([^]*?\n\}/)[0], context);
const errors = [];
const check = (name, fn) => { try { fn(); } catch (e) { errors.push(name + ': ' + e.message); } };
const genres = [...app.match(/const GENRES = \[[^]*?\];/)[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const biasBlock = app.slice(app.indexOf('const BIAS_TYPES'), app.indexOf('function recordBias'));
const biases = new Set(['正解', ...[...biasBlock.matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1])]);
const ids = new Set(), contexts = new Set();
for (const c of cards) {
  check(c.id + ' complete family', () => {
    assert.equal(c.variants.length, 2);
    assert.equal(context.cardForms(c).length, 3, 'runtime rejected an incomplete variant');
    assert.equal(new Set([c.best, ...c.variants.map((v) => v.best)]).size, 3, 'authored answer positions repeat');
  });
  const forms = [c, ...c.variants];
  for (const f of forms) check(f.id, () => {
    assert.ok(!ids.has(f.id), 'duplicate form ID'); ids.add(f.id);
    assert.ok(!contexts.has(f.context), 'repeated scenario'); contexts.add(f.context);
    for (const key of ['skill', 'context', 'quote', 'question', 'explain', 'alt', 'action']) assert.ok(f[key]?.trim(), 'missing ' + key);
    assert.equal(f.skill, c.skill);
    assert.equal(f.options.length, 4);
    assert.deepEqual(f.options.map((o) => o.id).sort(), ['A', 'B', 'C', 'D']);
    assert.equal(new Set(f.options.map((o) => o.text)).size, 4);
    assert.equal(f.options.find((o) => o.id === f.best)?.err, '正解');
    assert.ok(f.ok.every((k) => k !== f.best && f.options.some((o) => o.id === k && o.err === '正解')));
    for (const o of f.options) {
      assert.ok(o.text.trim() && o.why.trim());
      assert.ok(biases.has(o.err), 'unknown bias ' + o.err);
    }
    const best = f.options.find((o) => o.id === f.best);
    const wrong = f.options.filter((o) => o.err !== '正解');
    if (wrong.length) assert.ok(best.text.length <= 1.5 * Math.max(...wrong.map((o) => o.text.length)), 'correct answer conspicuously longer');
    if (c.type === 'read') {
      assert.ok(genres.includes(f.genre) && f.genreAlt.every((g) => genres.includes(g) && g !== f.genre));
      assert.ok(f.state.length >= 20 && f.genreWhy.trim());
      assert.ok(f.clues.length >= 3 && f.clues.length <= 5);
      assert.ok(f.clues.filter((x) => x.ok).length >= 1 && f.clues.filter((x) => x.ok).length <= 2);
    }
  });
  for (let i = 0; i < forms.length; i++) for (let j = i + 1; j < forms.length; j++) check(`${c.id} forms ${i}/${j}`, () => {
    const a = forms[i], b = forms[j];
    for (const key of ['context', 'quote', 'question', 'explain', 'action']) assert.notEqual(a[key], b[key], 'reused ' + key);
    const old = new Set(a.options.map((o) => o.text));
    assert.ok(b.options.every((o) => !old.has(o.text)), 'reused answer/option text');
    const why = new Set(a.options.map((o) => o.why));
    assert.ok(b.options.every((o) => !why.has(o.why)), 'reused option rationale');
  });
}
check('expansion', () => { assert.ok(cards.length >= 120); assert.ok(ids.size >= 360); });
errors.slice(0, 30).forEach((e) => console.error('FAIL ' + e.replace(/\s+/g, ' ')));
if (errors.length > 30) console.error(`另有 ${errors.length - 30} 项，先修复以上结构问题后重跑。`);
console.log(`结果：${cards.length} 组 / ${ids.size} 道完整题目，${errors.length} 项失败`);
process.exitCode = errors.length ? 1 : 0;
