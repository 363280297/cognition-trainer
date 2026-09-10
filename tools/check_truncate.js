/* 截断兜底的检查。
 *
 * 这条逻辑是补 README 里那句「会自动翻倍重试」时发现根本没有、才做出来的。
 * 所以它必须真的被测到——否则又是「文档说有、实际没有」的老问题。
 *
 * 被截断的失败方式很隐蔽：模型返回的是一段**残缺 JSON**，
 * 直接解析会得到「返回的不是 JSON」，用户完全看不出是额度问题。
 * 所以要验三件事：
 *   1. finish_reason=length 会被认出来（不是当成正常返回去解析）
 *   2. 会带着翻倍后的额度重试一次
 *   3. 两次都截断时，报的错要指出「额度不够、多半是推理吃掉了」，
 *      而不是一个指不到原因的 JSON 解析错
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
  const p = await b.newPage({ viewport: { width: 420, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => { document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove()); });

  /* 把底层的 llmCallOnce 换成一个假的「服务端」：
     第一次返回 finish_reason=length 的残缺 JSON，之后返回完整的。
     记录每次请求用的 max_tokens，用来验「额度真的翻倍了」。 */
  const stub = async (script) => p.evaluate((script) => {
    window.__calls = [];
    window.llmCallOnce = async (messages, temperature, maxTokens) => {
      window.__calls.push({ maxTokens, msgs: messages.length });
      const step = script[Math.min(window.__calls.length - 1, script.length - 1)];
      if (step.truncated) {
        const e = new Error('输出被 max_tokens 截断');
        e.truncated = true;
        e.raw = '{"reply":"他话说到一半就';
        throw e;
      }
      return step.value;
    };
  }, script);

  console.log('\n[被截断：翻倍重试一次]');
  await stub([{ truncated: true }, { value: { reply: '嗯。', tone: '平淡' } }]);
  const once = await p.evaluate(() => llmCall([{ role: 'user', content: 'x' }], 0.5)
    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, msg: e.message }))
    .then(async (r) => ({ ...r, calls: window.__calls })));
  chk('第一次被截断后重试成功', once.ok === true, JSON.stringify(once.v));
  chk('一共请求了两次', once.calls.length === 2, `${once.calls.length} 次`);
  chk('第一次用的是设置里的额度', once.calls[0].maxTokens === 3000, String(once.calls[0].maxTokens));
  chk('第二次的额度翻倍了', once.calls[1].maxTokens === 6000,
    `${once.calls[0].maxTokens} → ${once.calls[1].maxTokens}`);

  console.log('\n[连续两次都截断：如实报错，不许报成 JSON 解析错]');
  await stub([{ truncated: true }]);
  const twice = await p.evaluate(() => llmCall([{ role: 'user', content: 'x' }], 0.5)
    .then((v) => ({ ok: true }), (e) => ({ ok: false, msg: e.message }))
    .then((r) => ({ ...r, calls: window.__calls })));
  chk('两次都截断时会报错', twice.ok === false, JSON.stringify(twice.msg));
  chk('只重试一次就放弃（不会疯狂翻倍）', twice.calls.length === 2, `${twice.calls.length} 次`);
  chk('报错说清是长度限制，不是「不是 JSON」',
    /截断|长度限制/.test(twice.msg || '') && !/不是 JSON/.test(twice.msg || ''),
    String(twice.msg).slice(0, 70));
  chk('报错指出了多半是推理吃掉了额度，并给出方向',
    /推理/.test(twice.msg || '') && /deepseek-chat/.test(twice.msg || ''),
    String(twice.msg).slice(-60));

  console.log('\n[上限：额度再翻也不会超过 12000]');
  await stub([{ truncated: true }]);
  const cap = await p.evaluate(async () => {
    saveSettings({ maxTokens: 9000 });
    await llmCall([{ role: 'user', content: 'x' }], 0.5).catch(() => { });
    saveSettings({ maxTokens: 3000 });
    return window.__calls.map((c) => c.maxTokens);
  });
  chk('9000 翻倍会被压到 12000（不是 18000）', cap[1] === 12000, cap.join(' → '));

  console.log('\n[正常返回：不受影响，也不会多花一次请求]');
  await stub([{ value: { reply: '嗯。', tone: '平淡' } }]);
  const ok = await p.evaluate(() => llmCall([{ role: 'user', content: 'x' }], 0.5)
    .then((v) => ({ v, calls: window.__calls })));
  chk('正常情况只请求一次', ok.calls.length === 1, `${ok.calls.length} 次`);
  chk('正常情况原样返回解析好的对象', ok.v && ok.v.reply === '嗯。', JSON.stringify(ok.v));

  console.log('\n[非截断的错（比如 404）不该被重试]');
  await stub([{ value: { reply: 'x' } }]);
  const other = await p.evaluate(() => {
    window.llmCallOnce = async () => { throw new Error('模型返回 404：这个地址上没东西'); };
    return llmCall([{ role: 'user', content: 'x' }], 0.5)
      .then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
  });
  chk('404 这类错误直接抛出，不做额度重试',
    other.ok === false && /404/.test(other.msg || ''), String(other.msg).slice(0, 50));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
