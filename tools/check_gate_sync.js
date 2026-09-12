/* Runs the actual web-to-native sender. Disabling the gate must not report the
 * daily exercise as completed, and its date must cross the bridge explicitly. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const body = source.match(/function syncGate\(\) \{[\s\S]*?\n\}/)[0];
let failures = 0;
for (const [enabled, met] of [[false,false],[true,false],[true,true],[false,true]]) {
  const calls = [];
  const native = { setTrainingState: (...args) => calls.push(args), setGate: () => { throw Error('legacy bridge selected'); } };
  const c = vm.createContext({ state: { gate: { enabled, packages: ['com.example.game'] } },
    dailyProgress: () => ({ met, need: 5, done: met ? 5 : 0, cards: 0, lessons: 0, tg: { cards: 4, lessons: 1 }, canSkip: !met }),
    todayStr: () => '2026-09-12', window: { EQNative: native }, EQNative: native, save: () => {} });
  vm.runInContext(body, c); c.syncGate();
  try {
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0,4), [+enabled,+met,'2026-09-12','["com.example.game"]']);
    assert.equal(c.state.gate.armed, enabled && !met);
    console.log(`PASS enabled=${enabled} met=${met}`);
  } catch (e) { failures++; console.log(`FAIL enabled=${enabled} met=${met}: ${e.message}`); }
}
console.log(`结果：${4-failures} 通过，${failures} 失败`);
process.exitCode = failures ? 1 : 0;
