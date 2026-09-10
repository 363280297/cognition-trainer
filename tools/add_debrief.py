# -*- coding: utf-8 -*-
"""对话之后的「评价 + 改进措施」。

用户的原话：「然后对话完之后给我评价，以及改进措施。」

现在的结束页有：接住了几次 / 没接住几次 / 温度 / 提了几个问题 / 最该回头看的
一句 / 逐轮记录。这些都是**统计**，不是评价——统计是你自己看出来的，
评价是有人替你点破。用户要的是后者。

所以这里加一次模型调用，把整段对话交给它，让它给：
  · 整体评价（像教练，不像鼓励师）
  · 一个反复出现的模式
  · 做对的、要保持的
  · 要改的动作 + **下一次可以这么说**的原话示例
  · 下一局只盯这一件事

三条硬约束写进提示词里，因为这类输出最容易烂成鸡汤：
  1. 必须引用他真正说过的原话（所以 A 步里把 userText 记进了每轮记录）
  2. 不许恭维；整体不好就直说
  3. 每条改进必须是一个具体动作 + 一句原话示例，不许「多倾听」这种没法执行的

顺带修一个真 bug：
「再来一局」原来传的是 `s.sc.id`，而随机生成的场景 id 是 `gen-...`，
`startSession` 按 id 查是查不到的——于是按钮**点了没反应，也不报错**。
改成直接用当前场景对象。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, 'public', 'voice.js')


def sub(s, old, new, n=1):
    assert s.count(old) == n, f'期望命中 {n} 次，实得 {s.count(old)} 次：{old[:80]!r}'
    return s.replace(old, new)


def main():
    with io.open(P, encoding='utf-8') as f:
        s = f.read()

    # ---- startSession：清掉上一局的收尾状态 ----
    s = sub(s, """  V.sess = {
    sc, turn: 0, maxTurn: 8,
    temp: sc.temp0 || 50,""", """  V.ended = false;
  V.noSpeech = 0;
  V.phase = 'idle';
  V.speaking = false;
  V.lastDebrief = null;
  V.sess = {
    sc, turn: 0,
    temp: sc.temp0 || 50,""")

    # ---- endSession：标记结束、停掉麦克风、加复盘卡 ----
    s = sub(s, """function endSession() {
  const s = V.sess;
  if (!s) return;
  stopSpeak();
  const log = s.log;""", """function endSession() {
  const s = V.sess;
  if (!s) return;
  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;
  V.hf = false;
  stopSpeak();
  stopListen();
  const log = s.log;""")

    s = sub(s, """    ${askReport(s)}

    ${worst ? `<div class="card">""", """    ${askReport(s)}

    <div class="card">
      <h3>这一局的复盘</h3>
      <div id="debriefBody" class="hint" style="margin-top:8px">正在生成…</div>
    </div>

    ${worst ? `<div class="card">""")

    s = sub(s, """    <div class="row">
      <button class="primary" onclick="startSession('${s.sc.id}')">再来一局</button>
      <button class="ghost" onclick="V.sess=null;renderPractice()">换场景</button>
    </div>`;
  window.scrollTo({ top: 0 });
}""", """    <div class="row">
      <button class="primary" onclick="replaySession()">再来一局</button>
      <button class="ghost" onclick="randomStart()">随机换一个</button>
      <button class="ghost" onclick="V.sess=null;renderTalkSetup()">自己挑</button>
    </div>`;
  window.scrollTo({ top: 0 });
  fillDebrief();
}

/** 再来一局。必须用场景对象而不是 id：随机生成的场景 id 是 gen-…，
 *  按 id 查不到，原来的写法会让这个按钮点了没反应、也不报错。 */
function replaySession() {
  const sc = V.sess && V.sess.sc;
  if (sc) startSession(sc);
}

/* ---------------------------------------------------------------- 复盘 */

async function makeDebrief(sess) {
  if (!sess.log.length) throw new Error('这一局没聊几句，没什么可复盘的');
  const lines = sess.log.map((o, i) => {
    const r = [
      `第 ${i + 1} 轮`,
      `他说：「${o.userText || '（没说话）'}」`,
      `他回：「${o.reply || ''}」`,
      `他心里的想法：${o.inner || '（没给）'}`,
      `给他的分：${o.rating || '平'}${o.rating_why ? '——' + o.rating_why : ''}`,
    ];
    return r.join('\\n');
  }).join('\\n\\n');

  const sys = [
    '你在给一次「对话练习」做复盘。用户是成年男性，在练怎么把话说对。',
    '他要的是**能用的东西**，不是鼓励。把他当成一个请你帮忙看录像的熟人。',
    '',
    '硬性要求：',
    '1. **必须基于记录里他真正说过的话**，并引用原话（加引号）。',
    '   引用原话比抽象评价有用得多，也不容易显得像套话。',
    '2. **不要恭维。** 如果整体不好就直接说不好；如果只有一处做得好，',
    '   就只说那一处，不要为了让他舒服而凑出三条优点。',
    '3. 每条改进必须是**一个具体动作**，并给出「下一次可以这么说」的原话示例。',
    '   不许写「多倾听」「要有同理心」「注意分寸」这类正确但没法执行的话。',
    '4. 不要编造记录里没有的内容。不要评价对方这个人——对方是模型演的，不是真人，',
    '   评价他等于在评价题目。',
    '5. 中文口语。不要鸡汤腔，不要排比句，不要小标题。',
    '',
    '只输出 JSON：',
    '{',
    '  "verdict": "整体评价，2-3 句，像教练不像鼓励师",',
    '  "pattern": "他这一局反复出现的一个模式，一句话点破（也可以是好的）",',
    '  "keeps": ["下一局要保持的，0-3 条，每条 30 字以内"],',
    '  "fixes": [{"act":"要改的动作，20 字以内",',
    '             "say":"下一次可以这么说（给一句原话）",',
    '             "why":"为什么这样更好，40 字以内"}],',
    '  "one": "下一局只盯这一件事，一句话"',
    '}',
  ].join('\\n');

  const sc = sess.sc;
  const user = [
    `场景：${sc.title}`,
    `对方是谁：${sc.her || ''}`,
    `对方嘴上没说的：${sc.her_state || ''}`,
    `他这一局的目标：${sc.goal || ''}`,
    `这个场景最常见的错法：${sc.trap || ''}`,
    '',
    '对话记录：',
    lines,
    '',
    `最后对方的温度：${sess.temp}（起点 50，越低越疏远）`,
    `他这一局提了 ${sess.asked || 0} 个问题，其中 ${sess.followUps || 0} 个是追问。`,
  ].join('\\n');

  return await llmCall([{ role: 'system', content: sys }, { role: 'user', content: user }], 0.7);
}

async function fillDebrief() {
  const box = document.getElementById('debriefBody');
  if (!box || !V.sess) return;
  box.innerHTML = '正在按你说过的原话生成复盘…（会多花一次模型调用）';
  try {
    const d = await makeDebrief(V.sess);
    V.lastDebrief = d;
    box.innerHTML = renderDebrief(d);
  } catch (e) {
    box.innerHTML = `<b>复盘没生成出来：</b>${esc(e.message || String(e))}
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="fillDebrief()">再试一次</button>
      </div>`;
  }
}

function renderDebrief(d) {
  const keeps = (d.keeps || []).filter(Boolean);
  const fixes = (d.fixes || []).filter((f) => f && f.act);
  return `
    ${d.verdict ? `<p class="deb-verdict">${rich(d.verdict)}</p>` : ''}
    ${d.pattern ? `<div class="deb-pattern"><b>反复出现的模式 · </b>${rich(d.pattern)}</div>` : ''}
    ${keeps.length ? `<div class="deb-block">
      <div class="deb-h">做对了，下一局保持</div>
      <ul class="deb-list">${keeps.map((k) => `<li>${rich(k)}</li>`).join('')}</ul>
    </div>` : ''}
    ${fixes.length ? `<div class="deb-block">
      <div class="deb-h">要改的地方</div>
      ${fixes.map((f) => `<div class="deb-fix">
        <div class="deb-act">${esc(f.act || '')}</div>
        ${f.say ? `<div class="deb-say">下一次可以这么说：「${esc(f.say)}」</div>` : ''}
        ${f.why ? `<div class="hint" style="margin-top:6px">${rich(f.why)}</div>` : ''}
      </div>`).join('')}
    </div>` : ''}
    ${d.one ? `<div class="deb-one">下一局只盯这一件事：<b>${rich(d.one)}</b></div>` : ''}`;
}""")

    with io.open(P, 'w', encoding='utf-8') as f:
        f.write(s)
    print('voice.js：对话后复盘 已就位')


if __name__ == '__main__':
    main()
