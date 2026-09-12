'use strict';
// Run the real voice.js functions with deferred fetch responses and memory-only state.
// No generated HTML, server, API key, browser profile or progress file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
// Optional read-only red check: exercise HEAD without restoring files in the shared workspace.
const baseline = process.argv.includes('--baseline');
const source = baseline
  ? require('node:child_process').execFileSync('git', ['show', 'HEAD:public/voice.js'],
    { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  : fs.readFileSync(path.join(root, 'public', 'voice.js'), 'utf8');
const started = Date.now();
const deadline = setTimeout(() => { console.error('FAIL: 20s test deadline'); process.exit(1); }, 20000);
const SC = { id: 's-test', title: '测试场景', opening: '你怎么看？', her_state: '想听意见', ta: '她' };
const turn = (reply) => ({ reply, tone: '平淡', rating: '好', temp: 54, userText: '我的意见' });

function harness() {
  const nodes = new Map();
  function element(id) {
    const el = { id, style: {}, disabled: false, value: '', children: [], html: '',
      scrollIntoView() {}, focus() {},
      insertAdjacentHTML(where, value) { this.html += value; },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this.html; },
      set(value) {
        const remove = (child) => {
          child.children.forEach(remove);
          if (nodes.get(child.id) === child) nodes.delete(child.id);
        };
        this.children.forEach(remove);
        this.children = [];
        this.html = String(value);
        for (const m of this.html.matchAll(/\bid="([^"]+)"/g)) this.children.push(element(m[1]));
      },
    });
    Object.defineProperty(el, 'textContent', {
      get() { return this.html; }, set(value) { this.innerHTML = value; },
    });
    Object.defineProperty(el, 'firstElementChild', { get() { return this.children[0] || null; } });
    nodes.set(id, el);
    return el;
  }
  element('view');
  const calls = [], notices = [], saved = [], spoken = [], storage = new Map();
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    state: { talks: [], scenes: {} },
    CONTENT: { scenarios: { scenarios: [SC] }, talkhints: { moves: [{ id: 'share', name: '分享' }] } },
    document: { getElementById: (id) => nodes.get(id) || null },
    $: (selector) => nodes.get(selector.slice(1)),
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    esc: (s) => String(s == null ? '' : s), rich: (s) => String(s == null ? '' : s),
    cutWithEllipsis: (s, n) => String(s).slice(0, n),
    toast: (s) => notices.push(s), save: () => saved.push(JSON.stringify(context.state)),
    dropSheets() {},
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    speechSynthesis: { cancel() {}, speak: (u) => spoken.push(u) },
    fetch: (url, opts) => new Promise((resolve, reject) => {
      assert.equal(url, '/api/proxy');
      calls.push({ body: JSON.parse(opts.body), reject,
        resolve(value, finish = 'stop') { resolve({ status: 200, text: async () => JSON.stringify({
          choices: [{ finish_reason: finish, message: { content: value == null ? '' : JSON.stringify(value) } }],
        }) }); },
        httpError(status) { resolve({ status, text: async () => 'controlled error' }); },
      });
    }),
    scrollTo() {},
  });
  context.window = context;
  vm.runInContext(source + '\n;globalThis.testState = { V, HINT };', context, { timeout: 1000 });
  context.saveSettings({ autoSpeak: false });
  return { c: context, v: context.testState.V, hint: context.testState.HINT,
    calls, notices, saved, spoken, node: (id) => nodes.get(id),
    start: () => context.startSession({ ...SC }),
    async complete(reply = '正常回答') {
      const before = calls.length;
      const p = context.userSaid('我的意见');
      assert.equal(calls.length, before + 1, 'the real LLM transport must be reached');
      calls.at(-1).resolve(turn(reply));
      await p;
    },
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('normal opening, turn, persistence and resume use the real source', async () => {
  const h = harness();
  await h.start();
  assert.equal(h.calls.length, 0);
  assert.equal(h.v.sess.turn, 1);
  await h.complete();
  assert.equal(h.v.sess.log[0].reply, '正常回答');
  assert.equal(h.v.busy, false);
  const id = h.v.sess.sid;
  h.c.resumeTalk(id);
  assert.equal(h.v.sess.sid, id);
  assert.match(h.node('herSlot').innerHTML, /正常回答/);
  await h.complete('继续回答');
  assert.equal(h.c.talks().length, 1);
  assert.equal(h.c.talks()[0].log.length, 2);
  assert.equal(h.calls.at(-1).body.messages.some((m) => m.content === '正常回答'), true);
});

test('switch while pending starts the new opening immediately', async () => {
  const h = harness(); await h.start();
  const p = h.c.userSaid('旧问题');
  await h.start();
  assert.equal(h.v.sess.turn, 1);
  assert.equal(h.v.busy, false);
  h.calls[0].resolve(turn('旧回答')); await p;
});

test('old success cannot mutate or paint the new session', async () => {
  const h = harness(); await h.start();
  const old = h.v.sess, p = h.c.userSaid('旧问题');
  await h.start();
  const snapshot = JSON.stringify(h.v.sess), html = h.node('herSlot').innerHTML;
  h.calls[0].resolve(turn('旧回答')); await p;
  assert.equal(JSON.stringify(h.v.sess), snapshot);
  assert.equal(old.log.length, 0);
  assert.equal(h.node('herSlot').innerHTML, html);
  assert.equal(h.c.talks().length, 0);
});

test('ended session rejects pending response and further input', async () => {
  const h = harness(); await h.start();
  const p = h.c.userSaid('旧问题');
  h.c.endSession(); await drain();
  const snapshot = JSON.stringify(h.v.sess), html = h.node('view').innerHTML;
  h.calls[0].resolve(turn('结束后的回答')); await p;
  assert.equal(JSON.stringify(h.v.sess), snapshot);
  const input = h.c.userSaid('结束后输入');
  assert.equal(h.calls.length, 1);
  await input;
  assert.equal(h.node('view').innerHTML, html);
  assert.equal(h.calls.length, 1);
});

for (const reject of [false, true]) test(`old ${reject ? 'failure' : 'success'}/finally cannot unlock or repaint new request`, async () => {
  const h = harness(); await h.start();
  const old = h.c.userSaid('旧问题');
  await h.start();
  const current = h.c.userSaid('新问题');
  assert.equal(h.calls.length, 2, 'new session must be able to issue its own request');
  const thinking = h.node('turnHint').textContent;
  if (reject) h.calls[0].reject(new Error('旧错误'));
  else h.calls[0].resolve(turn('旧回答'));
  await old;
  assert.equal(h.v.busy, true);
  assert.equal(h.node('turnHint').textContent, thinking);
  assert.deepEqual(h.notices, []);
  h.calls[1].resolve(turn('新回答')); await current;
  assert.equal(h.v.busy, false);
  assert.equal(h.v.sess.log.length, 1);
  assert.equal(h.v.sess.log[0].reply, '新回答');
});

test('resume same record while pending invalidates old object even with the same sid', async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid, old = h.v.sess;
  const p = h.c.userSaid('旧请求');
  h.c.resumeTalk(id);
  assert.equal(h.v.busy, false);
  const q = h.c.userSaid('恢复后的请求');
  assert.equal(h.calls.length, 3);
  h.calls[1].resolve(turn('旧回答')); await p;
  assert.equal(h.v.busy, true);
  assert.equal(old.log.length, 1);
  h.calls[2].resolve(turn('恢复回答')); await q;
  assert.equal(h.v.sess.log.length, 2);
  assert.equal(h.v.sess.log[1].reply, '恢复回答');
});

for (const reject of [false, true]) test(`stale debrief ${reject ? 'failure' : 'success'} cannot repaint/save another session`, async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid;
  h.c.endSession();
  const box = h.node('debriefBody');
  await h.start(); await h.complete('新局回答');
  const current = JSON.stringify(h.c.talks().find((t) => t.id === h.v.sess.sid));
  const html = box.innerHTML;
  if (reject) h.calls[1].reject(new Error('旧复盘失败'));
  else h.calls[1].resolve({ verdict: '旧复盘' });
  await drain();
  assert.equal(h.v.lastDebrief, null);
  assert.equal(box.innerHTML, html);
  assert.equal(JSON.stringify(h.c.talks().find((t) => t.id === h.v.sess.sid)), current);
  assert.equal(h.c.talks().find((t) => t.id === id).done, true, 'ended log must be saved before waiting');
});

test('debrief finishes normally and latest duplicate request wins', async () => {
  const h = harness(); await h.start(); await h.complete();
  h.c.endSession();
  const latest = h.c.fillDebrief();
  h.calls[2].resolve({ verdict: '最新复盘' }); await latest;
  h.calls[1].resolve({ verdict: '迟到复盘' }); await drain();
  assert.equal(h.v.lastDebrief.verdict, '最新复盘');
  assert.equal(h.c.talks()[0].debrief.verdict, '最新复盘');
  assert.match(h.node('debriefBody').innerHTML, /最新复盘/);
  assert.doesNotMatch(h.node('debriefBody').innerHTML, /迟到复盘/);
});

test('debrief cannot paint a replaced history view', async () => {
  const h = harness(); await h.start(); await h.complete();
  h.c.endSession();
  h.c.renderTalkRecord(h.v.sess.sid);
  const box = h.node('debriefBody'), html = box.innerHTML;
  h.calls[1].resolve({ verdict: '后台复盘' }); await drain();
  assert.equal(box.innerHTML, html);
});

for (const action of ['switch', 'close', 'turn']) test(`late hint is ignored after ${action}`, async () => {
  const h = harness(); await h.start();
  h.c.openTalkHint();
  const p = h.c.talkHintDemo();
  if (action === 'switch') { await h.start(); h.c.openTalkHint(); }
  else if (action === 'close') { h.c.closeTalkHint(); h.c.openTalkHint(); }
  else await h.complete();
  h.calls[0].resolve({ reply: '过期提示' }); await p;
  assert.equal(h.hint.demo, '');
  const box = h.node('hintDemo');
  if (box) assert.doesNotMatch(box.innerHTML, /过期提示/);
});

test('normal hint works and older duplicate cannot overwrite it', async () => {
  const h = harness(); await h.start(); h.c.openTalkHint();
  const first = h.c.talkHintDemo(), latest = h.c.talkHintDemo();
  h.calls[1].resolve({ reply: '最新提示' }); await latest;
  h.calls[0].resolve({ reply: '旧提示' }); await first;
  assert.equal(h.hint.demo, '最新提示');
  assert.equal(h.node('hintDemoBtn').disabled, false);
});

test('history reanalysis cannot overwrite a record that has resumed and advanced', async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid;
  h.c.renderTalkRecord(id);
  const p = h.c.reanalyzeTalk(id);
  h.c.resumeTalk(id); await h.complete('新一轮');
  h.calls[1].resolve({ verdict: '旧记录分析' }); await p;
  assert.equal(h.c.talks()[0].debrief, null);
});

test('resuming invalidates old analysis even when it resolves before the new reply', async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid;
  h.c.renderTalkRecord(id);
  const analysis = h.c.reanalyzeTalk(id);
  h.c.resumeTalk(id);
  const next = h.c.userSaid('第二轮新问题');
  h.calls[1].resolve({ verdict: '只分析了第一轮' }); await analysis;
  assert.equal(h.c.talks()[0].debrief, null);
  h.calls[2].resolve(turn('第二轮回答')); await next;
  assert.equal(h.c.talks()[0].log.length, 2);
  assert.equal(h.c.talks()[0].debrief, null);
});

test('advancing a session clears an analysis of fewer turns', async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid; h.c.renderTalkRecord(id);
  const analysis = h.c.reanalyzeTalk(id);
  h.calls[1].resolve({ verdict: '第一轮分析' }); await analysis;
  h.c.resumeTalk(id); await h.complete('第二轮回答');
  assert.equal(h.c.talks()[0].debrief, null);
});

test('random generation from ended page does not navigate back after leaving', async () => {
  const h = harness(); await h.start(); await h.complete(); h.c.endSession();
  assert.equal(h.node('sceneMsg'), undefined);
  const sess = h.v.sess, p = h.c.randomStart();
  h.c.renderTalkHistory();
  const page = h.node('view').innerHTML;
  h.calls[2].resolve({ ...SC, title: '迟到的新场景' }); await p;
  assert.equal(h.v.sess, sess);
  assert.equal(h.node('view').innerHTML, page);
  h.calls[1].resolve({ verdict: '原复盘' }); await drain();
});

for (const kind of ['empty', 'length', '404']) test(`stale ${kind} response cannot trigger retry or toast`, async () => {
  const h = harness();
  if (kind === '404') h.c.saveSettings({ baseUrl: 'https://example.test/custom' });
  await h.start();
  const p = h.c.userSaid('旧问题');
  await h.start();
  if (kind === '404') h.calls[0].httpError(404);
  else h.calls[0].resolve(null, kind === 'length' ? 'length' : 'stop');
  await drain();
  assert.equal(h.calls.length, 1, 'stale operation must not retry');
  assert.deepEqual(h.notices, []);
  await p;
});

test('current failure releases busy and current empty reply still retries normally', async () => {
  const h = harness(); await h.start();
  const p = h.c.userSaid('问题');
  h.calls[0].reject(new Error('当前错误')); await p;
  assert.equal(h.v.busy, false);
  assert.match(h.node('herSlot').innerHTML, /当前错误/);
  const q = h.c.userSaid('重试');
  h.calls[1].resolve(null); await drain();
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve(turn('重试成功')); await q;
  assert.equal(h.v.sess.log[0].reply, '重试成功');
});

for (const method of ['randomStart', 'buildAndStart']) test(`late ${method} cannot replace a chosen session`, async () => {
  const h = harness(); await h.start();
  h.node('view').innerHTML = '<input id="scenePrompt"><button id="randBtn"></button><button id="buildBtn"></button><div id="sceneMsg"></div>';
  h.node('scenePrompt').value = '练习接话';
  const p = h.c[method]();
  assert.equal(h.calls.length, 1);
  await h.start();
  const sess = h.v.sess;
  h.calls[0].resolve({ ...SC, title: '迟到场景' }); await p;
  assert.equal(h.v.sess, sess);
  assert.equal(h.v.sess.sc.title, SC.title);
});

test('latest scene generation starts normally; earlier generation cannot replace it', async () => {
  const h = harness();
  h.node('view').innerHTML = '<input id="scenePrompt"><button id="buildBtn"></button><div id="sceneMsg"></div>';
  h.node('scenePrompt').value = '练习接话';
  const first = h.c.buildAndStart(), latest = h.c.buildAndStart();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ ...SC, title: '最新场景' }); await latest;
  assert.equal(h.v.sess.sc.title, '最新场景');
  h.calls[0].resolve({ ...SC, title: '过期场景' }); await first;
  assert.equal(h.v.sess.sc.title, '最新场景');
});

test('old hint finally cannot enable a newer hint request button', async () => {
  const h = harness(); await h.start(); h.c.openTalkHint();
  const old = h.c.talkHintDemo(), current = h.c.talkHintDemo();
  h.calls[0].reject(new Error('过期提示错误')); await old;
  assert.equal(h.node('hintDemoBtn').disabled, true);
  assert.deepEqual(h.notices, []);
  h.calls[1].resolve({ reply: '新提示' }); await current;
  assert.equal(h.node('hintDemoBtn').disabled, false);
});

test('old browser speech callback cannot mark new speech done', async () => {
  const h = harness(); h.c.saveSettings({ autoSpeak: true });
  await h.start(); const old = h.spoken[0];
  await h.start(); const current = h.spoken[1];
  old.onend(); old.onerror();
  assert.equal(h.v.speaking, true);
  current.onend();
  assert.equal(h.v.speaking, false);
});

test('old debrief cannot replace a second ended session debrief', async () => {
  const h = harness(); await h.start(); await h.complete(); h.c.endSession();
  await h.start(); await h.complete('第二局'); h.c.endSession();
  const id = h.v.sess.sid, box = h.node('debriefBody'), waiting = box.innerHTML;
  h.calls[1].resolve({ verdict: '第一局复盘' }); await drain();
  assert.equal(box.innerHTML, waiting);
  assert.equal(h.v.lastDebrief, null);
  h.calls[3].resolve({ verdict: '第二局复盘' }); await drain();
  assert.equal(h.v.lastDebrief.verdict, '第二局复盘');
  assert.equal(h.c.talks().find((t) => t.id === id).debrief.verdict, '第二局复盘');
});

test('normal debrief failure keeps ended record and retry succeeds', async () => {
  const h = harness(); await h.start(); await h.complete(); h.c.endSession();
  h.calls[1].reject(new Error('当前复盘失败')); await drain();
  assert.equal(h.c.talks()[0].done, true);
  assert.match(h.node('debriefBody').innerHTML, /当前复盘失败/);
  const p = h.c.fillDebrief();
  h.calls[2].resolve({ verdict: '补上复盘' }); await p;
  assert.equal(h.c.talks()[0].debrief.verdict, '补上复盘');
});

test('history reanalysis saves only its record after navigating away, without a toast', async () => {
  const h = harness(); await h.start(); await h.complete();
  const id = h.v.sess.sid; h.c.renderTalkRecord(id);
  const p = h.c.reanalyzeTalk(id);
  await h.start();
  const before = h.node('view').innerHTML;
  h.calls[1].resolve({ verdict: '历史分析' }); await p;
  assert.equal(h.c.talks().find((t) => t.id === id).debrief.verdict, '历史分析');
  assert.equal(h.node('view').innerHTML, before);
  assert.deepEqual(h.notices, []);
});

test('sending a turn invalidates its pending hint even if that turn fails', async () => {
  const h = harness(); await h.start(); h.c.openTalkHint();
  const hint = h.c.talkHintDemo(), p = h.c.userSaid('我想好了');
  h.calls[1].reject(new Error('本轮失败')); await p;
  h.calls[0].resolve({ reply: '旧提示' }); await hint;
  assert.equal(h.hint.open, false, 'old hint panel must not remain stuck loading');
  assert.equal(h.hint.demo, '');
  h.c.openTalkHint();
  assert.equal(h.node('hintDemoBtn').disabled, false);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + e.message); }
  }
  clearTimeout(deadline);
  console.log(`${baseline ? 'HEAD baseline: ' : ''}${tests.length - failures}/${tests.length} passed; ${failures} failed; ${Date.now() - started}ms`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { clearTimeout(deadline); console.error(e); process.exitCode = 1; });
