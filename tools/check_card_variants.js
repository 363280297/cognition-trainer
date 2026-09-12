/* Regression: a new scenario must carry its own answers and feedback; shuffling
 * must not change scoring or split a family's existing review progress. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const context = vm.createContext({ structuredClone, state: { srs: {} }, Math });
for (const name of ['shuffleInPlace', 'cardForms', 'applyVariant', 'planEditor', 'savePlan', 'showPlanSource']) {
  const match = src.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  if (match) vm.runInContext(match[0], context);
}
const option = (id, text, correct) => ({ id, text, err: correct ? '正解' : '投射', why: text + '的具体依据' });
const base = {
  id: 'fixture', skill: '提前交代变更', type: 'boundary', domain: '朋友',
  context: '答应周六帮忙搬家，周五确认临时值班。', quote: '明天几点到？', question: '怎么处理搬家约定？',
  options: ['A','B','C','D'].map((id) => option(id, '搬家处理' + id, id === 'A')),
  best: 'A', ok: ['B'], explain: '提前说明搬家的变化', alt: '能够调班时另议',
  action: '提前说明并提供替代', plan: { if: '搬家承诺要变更', then: '提前告知朋友' },
  variants: [
    { id: 'fixture-v1', skill: '提前交代变更', context: '接下组内订场地，发现周日场馆已经排满。',
      quote: '我可以按原计划通知大家了吗？', question: '这时哪一步能避免其他人白跑？',
      options: ['A','B','C','D'].map((id) => option(id, '场地处理' + id, id === 'C')),
      best: 'C', ok: [], explain: '场地尚未落实，先暂停发通知', alt: '若已有可用备用场地可以先确认',
      action: '说明场地没订上并一起调整', plan: { if: '活动场地未落实', then: '暂停通知并说明现状' } },
    { id: 'fixture-v2', skill: '提前交代变更', context: '负责把小组材料交给同事，发现其中一份缺少审核。',
      quote: '我下午就用这套材料提交了。', question: '如何让同事及时调整提交安排？',
      options: ['A','B','C','D'].map((id) => option(id, '材料处理' + id, id === 'D')),
      best: 'D', ok: [], explain: '缺审核会影响提交，交接前说明', alt: '若审核已经完成先核对版本',
      action: '说明缺项和补齐时间', plan: { if: '交接材料有缺项', then: '告知对方缺项及补齐时间' } },
  ],
};
let failures = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); }
}
const original = JSON.stringify(base);
test('first encounter includes original question, and three completed encounters cover all three forms', () => {
  const ids = [];
  for (let seen = 0; seen < 6; seen++) {
    context.state.srs.fixture = { seen };
    ids.push(context.applyVariant(base).formId);
  }
  assert.deepEqual(ids, ['fixture', 'fixture-v1', 'fixture-v2', 'fixture', 'fixture-v1', 'fixture-v2']);
});
test('variant uses its own question, answer text, feedback and plan while keeping family ID', () => {
  context.state.srs.fixture = { seen: 1 };
  const card = context.applyVariant(base);
  assert.equal(card.id, 'fixture');
  assert.equal(card.question, '这时哪一步能避免其他人白跑？');
  assert.equal(card.options.find((o) => o.id === card.best).text, '场地处理C');
  assert.equal(card.options.find((o) => o.id === card.best).answerKey, 'C');
  assert.equal(card.explain, '场地尚未落实，先暂停发通知');
  assert.equal(card.plan.if, '活动场地未落实');
  assert.equal(card.ok.length, 0);
});
test('shuffle changes visible answer positions but preserves preferred and acceptable answer meaning', () => {
  context.state.srs.fixture = { seen: 0 };
  const positions = new Set();
  for (let i = 0; i < 80; i++) {
    const card = context.applyVariant(base);
    positions.add(card.best);
    assert.equal(card.options.find((o) => o.id === card.best).text, '搬家处理A');
    assert.equal(card.options.find((o) => o.id === card.ok[0]).text, '搬家处理B');
    assert.deepEqual(Array.from(card.options, (o) => o.id), ['A','B','C','D']);
  }
  assert.ok(positions.size > 1, 'correct answer remains in a fixed position');
});
test('incomplete old surface variants cannot combine new scene with original answers', () => {
  context.state.srs.fixture = { seen: 1 };
  const card = context.applyVariant({ ...base, variants: [{ context: '另一件不相干的事', quote: '新的话' }] });
  assert.equal(card.context, base.context);
  assert.equal(card.formId, base.id);
});
test('invalid best or read-scene metadata cannot enter the exercise queue', () => {
  context.state.srs.fixture = { seen: 1 };
  const broken = structuredClone(base.variants[0]); broken.best = 'missing';
  assert.equal(context.applyVariant({ ...base, variants: [broken] }).formId, base.id);
  const read = { ...base, type: 'read', genre: '求建议', state: '原题的局面', genreWhy: '原依据', clues: [{ text: '原证据', ok: true }] };
  assert.equal(context.applyVariant(read).formId, base.id, 'must not inherit original read clues into unrelated variant');
});
test('materializing and shuffling questions never mutates authored content', () => assert.equal(JSON.stringify(base), original));
test('plans retain the exact source question and legacy plans stay on their original question', () => {
  const nodes = { pIf: { value: '发现原约定要改变时' }, pThen: { value: '提前说明变更原因并确认可行安排' }, planMsg: {} };
  Object.assign(context, {
    CONTENT: { cards: { cards: [base] } }, session: { queue: [context.applyVariant(base)], i: 0 },
    document: { getElementById: (id) => nodes[id] }, save() {}, bump() {},
    planProblem: () => null, renderCard() {}, esc: (s) => s, fmtDay: () => '今天',
  });
  context.state.plans = [{ id: 'legacy', cardId: 'fixture', if: '原题预案', then: '原题动作', ts: 1 }];
  context.state.srs.fixture = { seen: 1 };
  context.session.queue = [context.applyVariant(base)];
  assert.ok(!context.planEditor(context.session.queue[0]).includes('value="原题预案"'));
  context.savePlan('fixture');
  assert.equal(context.state.plans.length, 2, 'variant plan must not overwrite original plan');
  const saved = context.state.plans[1];
  assert.equal(saved.formId, 'fixture-v1');
  context.showPlanSource('fixture', saved.id);
  assert.equal(context.session.queue[0].question, base.variants[0].question);
  context.showPlanSource('fixture', 'legacy');
  assert.equal(context.session.queue[0].question, base.question);
});
console.log(`结果：${total - failures} 通过，${failures} 失败`);
process.exitCode = failures ? 1 : 0;
