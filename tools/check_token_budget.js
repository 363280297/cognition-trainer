/* token 开销的检查。
 *
 * 用户的规矩（原话）：「Token不要消耗太多就行，必要的就行，就比如说功能必须的就行，
 * 然后如果有功能，可以以更省token的方式来实现，就选那个，而不是说为了token而放弃功能。」
 *
 * 也就是：**功能不许为了省钱被砍掉；但同一件事如果有更省的做法，必须用省的那种。**
 * 这个文件就是把那句话变成能跑的断言，不然它只是每次都得有人记得的原则。
 *
 * 为什么这类问题必须靠断言守：**省钱的改动一旦被改回去，功能一切正常**，
 * 不报错、不崩、界面完全一样，只是每次多花钱。所以它属于「最难发现」的那一类，
 * 只能靠断言。
 *
 * 三条最要紧的：
 *   1. 真实复盘那两次调用必须**共用同一段前缀**（system + 聊天记录）。
 *      这是全 App 最大的一笔可省开销：记录是用户自己粘的，可能两万字，
 *      前缀一旦不共用，同一段话就得按全价买两遍。
 *   2. 只带白话模式的请求（接话提示 / OCR），空返回时**不许重试**——
 *      那会发出一个一模一样的请求，多花一倍的钱、多等一倍的时间，
 *      而且不可能有不同的结果。
 *   3. 每条路的提示词体积要有上限，涨上去就报出来（避免无声翻倍）。
 *
 * 体积用**字符数**衡量（不是真实 token）。理由：中文大致 1.5~1.7 字符/token，
 * 而这个检查要守的是「有没有翻倍」这种量级的变化，字符数足够，而且完全确定、不花钱。
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

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const voiceSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'voice.js'), 'utf8');
const grab = (src, name) => {
  const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  return m ? m[1] : null;
};

(async () => {
  // ---------------------------------------------------------- 静态：提示词体积
  console.log('[提示词体积（字符数，守住量级）]');
  const STATIC = [
    ['app.js', 'CHECKUP_SYSTEM', 1200],
    ['app.js', 'REPLAY_SHARED_SYS', 400],
    ['app.js', 'REPLAY_Q_TASK', 900],
    ['app.js', 'REPLAY_REVEAL_TASK', 1600],
    ['voice.js', 'SCENE_SYS', 1400],
    ['voice.js', 'OCR_SYS', 600],
  ];
  for (const [f, name, ceil] of STATIC) {
    const txt = grab(f === 'app.js' ? appSrc : voiceSrc, name);
    chk(`${name} 在 ${ceil} 字以内`, txt != null && txt.length <= ceil,
      txt == null ? '找不到这个常量（改名了？）' : `${txt.length} 字`);
  }

  /* 复盘那一段共用前缀必须**真的很短**：它是每次都要按原样发出去的开销。
     如果哪天有人往里加了一堆说明，所有用户的每一次复盘都会变贵。 */
  const shared = grab(appSrc, 'REPLAY_SHARED_SYS') || '';
  chk('共用前缀很薄（不夹带任务说明）',
    shared.length < 200 && !/出题|JSON\s*\{/.test(shared), `${shared.length} 字`);

  // ---------------------------------------------------------- 动态：真的跑一遍
  const b = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined });
  const p = await b.newPage({ viewport: { width: 420, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);

  /* 桩：记录每一次请求，并可以指定「回空」来测重试行为。 */
  const install = async (mode) => p.evaluate((mode) => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.__reqs = [];
    window.__mode = mode;
    window.EQNative = {
      capabilities: () => JSON.stringify({ tts: false, asr: false, http: true, mic: false }),
      httpPost: async (id, url, headersJson, body) => {
        const j = JSON.parse(body);
        window.__reqs.push({ url, messages: j.messages, max_tokens: j.max_tokens,
                             hasFormat: !!j.response_format });
        if (window.__mode === 'empty') {
          // 空内容：这正是官方文档承认会偶发的那种返回
          window.__onHttp(id, JSON.stringify({
            status: 200, body: JSON.stringify({ choices: [{ message: { content: '' } }] }) }));
          return;
        }
        const all = JSON.stringify(j.messages);
        const out = /表达体检/.test(all) ? { verdict: 'ok', score_line: '整体健康' }
          : /先出题让他自己判断/.test(all)
            ? { summary: '两个人在聊在干嘛', note: '',
                questions: [{ q: '这句的效果？', options: ['字面意思', '试探', '敷衍'],
                              answer_index: 0, why: '没有潜台词' }] }
            : { score_line: '第一题判断对了', turn_point: '分水岭是那句「没干嘛」',
                readings: [], your_part: [], options: [{ move: '承接情绪', direction: '递回去' }],
                principle: '先给一句自己的' };
        window.__onHttp(id, JSON.stringify({
          status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }) }));
      },
    };
    V.native = window.EQNative;
    V.caps = { tts: false, asr: false, http: true, mic: false };
    if (typeof V.resetHttp === 'function') V.resetHttp();
    // 要有密钥才走得到请求那一步（桩会拦住真正的网络，不会真发出去）
    saveSettings({ apiKey: 'sk-test-not-real', model: 'deepseek-chat' });
  }, mode);

  console.log('\n[真实复盘：两次调用必须共用前缀（这是最大的一笔可省开销）]');
  await install('ok');
  /* 直接调那两个函数，不走界面。
     这一条要检查的是**请求的形状**（前缀一不一样），跟界面渲染没关系；
     走界面还得依赖按钮文案和视图挂载，那些一变断言就假红。 */
  const rp = await p.evaluate(async () => {
    const chat = '我：在吗\n她：嗯\n我：在干嘛呢\n她：没干嘛\n我：那早点睡\n她：嗯嗯';
    window.__reqs = [];
    await aiReplayQuestions(chat, '认识两个月');
    await aiReplayReveal(chat, [{ chosen: 'A', correct: 'A' }]);
    const rs = window.__reqs.filter((r) => /聊天记录/.test(JSON.stringify(r.messages)));
    return { n: rs.length, a: rs[0], b: rs[rs.length - 1] };
  });
  chk('出题和揭晓各发了一次（没有多发）', rp.n === 2, `${rp.n} 次`);
  const sameSys = JSON.stringify(rp.a.messages[0]) === JSON.stringify(rp.b.messages[0]);
  const sameRec = JSON.stringify(rp.a.messages[1]) === JSON.stringify(rp.b.messages[1]);
  chk('两次的 system 逐字相同', sameSys);
  chk('两次的【聊天记录】逐字相同（前缀缓存才认得出来）', sameRec,
    sameRec ? '' : '变了 → 记录会被按全价买两遍，而且不会报任何错');
  /* 顺序的判据是「记录正文只出现一次、而且在任务之前」。
     注意不能拿「任务里有没有出现『聊天记录』四个字」当判据——出题那段任务里
     本来就写着「根据聊天记录出 2-3 道题」，那句话是任务说明的一部分，
     我第一版就是这么误判的。真正要守的是**记录正文本身没有被重复发一遍**。 */
  const chatLine = '在干嘛呢';
  chk('记录正文只在记录那一条里出现（没有被复制进任务）',
    rp.a.messages[1].content.includes(chatLine) && !rp.a.messages[2].content.includes(chatLine));
  chk('记录那一条以【聊天记录】开头（前缀起点一致）',
    rp.a.messages[1].content.startsWith('【聊天记录】'));
  chk('两次仍然是两次不同的任务（没有为了省钱把功能合并掉）',
    rp.a.messages[2].content !== rp.b.messages[2].content);

  console.log('\n[空返回不许白花第二次钱（白话模式那两条路）]');
  await install('empty');
  const retry = await p.evaluate(async () => {
    // hint（接话提示）这条路本来就是 noFormat
    window.__reqs = [];
    try {
      await llmCall([{ role: 'user', content: '她说完那句话，给我一句我能直接说出口的回应' }],
        { noFormat: true, maxTokens: 1600 });
    } catch (e) { window.__err = String(e.message || e); }
    const n1 = window.__reqs.length;
    // 对照：带格式的那条路，换形状重试才有意义，应该发两次
    window.__reqs = [];
    try {
      await llmCall([{ role: 'user', content: '给我一段 JSON' }], { maxTokens: 300 });
    } catch (e) { /* 预期失败 */ }
    return { noFormatReqs: n1, withFormatReqs: window.__reqs.length,
             err: window.__err || '' };
  });
  chk('白话模式的请求失败时不重试（1 次，不是 2 次）', retry.noFormatReqs === 1,
    `${retry.noFormatReqs} 次`);
  chk('带格式的那条路仍然换形状重试（这条重试是有意义的）', retry.withFormatReqs === 2,
    `${retry.withFormatReqs} 次`);
  chk('报错文案不再声称「换过形状」', /没重试/.test(retry.err),
    retry.err.split(/\r?\n/).slice(-2).join(' | ').slice(0, 110));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' / '));

  await b.close();
  console.log(`\n结果：${fail ? '失败 ' + fail + ' 项' : '全部通过'}`);
  process.exit(fail ? 1 : 0);
})();
