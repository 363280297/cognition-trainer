# -*- coding: utf-8 -*-
"""把「语音陪练」改成「场景对话」：先给提示词，再由模型建造场景。

用户的要求：「AI 对话那个引入语音对话吧，就像一些大模型一样。」
追问「你想要随便聊的自由对话，还是围绕某个场景练的对话？」之后他选了后者：
「语音功能选后者，先给提示词，然后建造一个场景。」

看代码之后发现：**对话引擎其实已经在了**——原有的「语音陪练」不是念台词，
它本来就是「按住说话 → 模型演她 → 每轮告诉你她心里在想什么」，
带轮次、温度条、追问计数。真正缺的只有他点出来的那一步：
**场景原来是写死的 6 个，不能从自己的提示词生成。**

所以这个改动很小、也很集中：
  1. 场景来源从「6 个固定场景」改成「提示词 → 模型生成场景」，
     形状沿用 scenarios.json 里那套字段（title/her/her_state/opening/goal/trap），
     所以下面那套对话机制一行都不用动。
  2. 那 6 个老场景不浪费，变成一键填入的**示例提示词**。
  3. startSession 接受「场景对象」或「id」，两条路都能走。

不做的：没有改成「随便聊」的开放聊天。理由写在 buildScenario 的注释里——
那是一个聊天机器人，和这个 App 要在半秒内做对动作的训练目标不是一回事。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, 'public', 'voice.js')


def main():
    with io.open(P, encoding='utf-8') as f:
        s = f.read()

    # ---------- 1) startSession 接受对象或 id ----------
    old = """async function startSession(scId) {
  const sc = (CONTENT.scenarios.scenarios || []).find((x) => x.id === scId);
  if (!sc) return;"""
    new = """async function startSession(scOrId) {
  // 两条路都走：老场景按 id 查，新建的场景直接把对象传进来。
  const sc = typeof scOrId === 'string'
    ? (CONTENT.scenarios.scenarios || []).find((x) => x.id === scOrId)
    : scOrId;
  if (!sc) return;"""
    assert s.count(old) == 1, s.count(old)
    s = s.replace(old, new)

    # ---------- 2) 建场景 + 新的设置页 ----------
    SETUP = r'''
/* ============================================================ 场景对话
 *
 * 用户的要求：「先给提示词，然后建造一个场景。」
 *
 * 这里的取舍值得写下来：他要的是**围绕一个场景练**，不是「随便聊」。
 * 两者的区别不是界面，是训练目标：
 *   - 开放聊天里模型会配合你、会顺着你说，你练的是「聊得下去」；
 *   - 场景对话里模型**有立场、有未说出口的期待、也会因为你的失分而降温**，
 *     你练的是「在具体情况下做对那一个动作」。
 * 这个 App 的全部内容都指向后者，所以这里不做开放聊天——那等于换了一个产品。
 *
 * 场景的形状沿用 data/scenarios.json 那套字段，一字不改，
 * 这样下面那套对话机制（轮次、温度、追问计数、复盘）完全不用动。
 */

/** 一键填入的示例提示词。老的 6 个场景不浪费，转成提示词的写法。 */
const SCENE_SEEDS = [
  '刚认识两周，第一次单独约出来，我想练「让她说得比我多」',
  '同事在群里当着大家的面否了我的方案，我想练一句不软不硬的回应',
  '朋友连着三周找我倒同一件苦水，我想练「听住但不做垃圾桶」',
  '我妈又拿我和别人家孩子比，我想练不吵架但把话说清楚',
  '伴侣说「算了，随便吧」，我想练听出她真正要的是什么',
  '我想退掉一个总是占我便宜的饭局邀约，但不想把关系弄僵',
];

async function buildScenario(prompt) {
  const s = settings();
  if (!s.apiKey && V.native) throw new Error('还没填 API 密钥：点下面的「⚙ 设置」填一次就行');
  if (!String(prompt || '').trim()) throw new Error('先写一句你想练什么');

  const sys = `你在给一个情商训练 App 建造「对话练习场景」。
用户会给你一句他想练的东西，你要把它变成一个具体的、可以马上开口的对话场景。

严格要求：
1. 场景必须**具体**：有确切的关系、场合、以及此刻正在发生的事。不要写成泛泛的咨询建议。
2. 对方必须有**自己的立场和一个没说出口的期待**——这是这个练习的核心。
   如果对方只是配合你，这个场景就没有训练价值。
3. opening 是对方说的**第一句话**，要是口语、要能直接说出口，不超过 40 字。
4. difficulty 是 1–3 的整数（对方越不配合、越需要你察言观色就越高）。
5. 全部用中文口语，不要书面腔，不要写油腻话术。
6. 不要写成「你要如何如何」的教程，只描述场景本身。

只输出 JSON，字段固定为：
{"title":"场景标题，12字以内","stage":"关系阶段，4-6字","difficulty":2,
 "her":"对方是谁：年龄/身份/性格/你们的关系和当前位置",
 "her_state":"对方此刻真实的感受，以及他最在意什么（这句话会作为内心活动展示给用户）",
 "opening":"对方开口说的第一句话",
 "goal":"用户这一局的目标，一句",
 "trap":"这一局最常见的错法，一句"}`;

  const out = await llmCall([
    { role: 'system', content: sys },
    { role: 'user', content: '我想练：' + String(prompt).trim() },
  ], 0.85);

  const sc = {
    id: 'gen-' + Date.now(),
    title: String(out.title || '练习场景').slice(0, 24),
    stage: String(out.stage || '日常'),
    difficulty: Math.min(3, Math.max(1, parseInt(out.difficulty, 10) || 2)),
    her: String(out.her || ''),
    her_state: String(out.her_state || ''),
    opening: String(out.opening || '').slice(0, 80),
    goal: String(out.goal || ''),
    trap: String(out.trap || ''),
  };
  // 开场白是这套机制的地基，缺了就没法开始——宁可报错，也不要造一个空场景
  if (!sc.opening.trim()) throw new Error('场景生成得不完整（缺开场白），再试一次');
  return sc;
}

function renderTalkSetup() {
  const s = settings();
  const noKey = V.native && !s.apiKey;
  $('#view').innerHTML = `
    <div class="card">
      <h2>场景对话</h2>
      <p class="hint" style="margin-top:8px">
        AI 演对方，你开口说话。<b>先给一句提示词说明你想练什么</b>，
        它会把这个提示词造成一个具体的场景——包括对方是谁、此刻在发生什么、
        以及他嘴上没说但心里在意的东西。每一轮他答完，都会告诉你
        <b>他心里其实在想什么</b>：这是这个 App 里唯一让你「当场回应」，
        而不是从四个选项里挑一个的练习。
      </p>
      ${!V.native ? `<p class="warnbox" style="margin:12px 0">
        你现在是在电脑浏览器里打开，没有手机的原生语音桥，所以识别和合成会降级：
        <b>直接打字代替说话</b>，对方的声音用浏览器语音。装到手机上就是真的语音对话。
      </p>` : ''}
      ${V.native && !V.caps.asr ? `<p class="warnbox" style="margin:12px 0">
        这台手机没有可用的语音识别引擎，下面可以打字对话。
      </p>` : ''}
      ${noKey ? `<p class="warnbox" style="margin:12px 0">
        还没填 API 密钥，建不了场景也对话不了。
        <button class="plain" style="margin-left:6px" onclick="openSettings()">去填</button>
      </p>` : ''}
      <label class="field" style="margin-top:12px"><span>你想练什么</span>
        <textarea id="scenePrompt" class="review-input" rows="3"
          placeholder="例：同事在群里否了我的方案，我想练一句不软不硬的回应"></textarea></label>
      <div class="row">
        <button class="primary" id="buildBtn" onclick="buildAndStart()">建造这个场景</button>
      </div>
      <div id="sceneMsg" class="hint" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="label" style="margin-bottom:10px">或者点一个示例，填进上面再改</div>
      <div class="seed-list">
        ${SCENE_SEEDS.map((x, i) => `<button class="seed" onclick="useSeed(${i})">${esc(x)}</button>`).join('')}
      </div>
    </div>

    <div class="row"><button class="ghost" onclick="openSettings()">⚙ 设置（API 密钥 / 语速）</button></div>`;
}

function useSeed(i) {
  const el = document.getElementById('scenePrompt');
  if (el) { el.value = SCENE_SEEDS[i] || ''; el.focus(); }
}

async function buildAndStart() {
  const el = document.getElementById('scenePrompt');
  const btn = document.getElementById('buildBtn');
  const msg = document.getElementById('sceneMsg');
  const prompt = el ? el.value : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在建造…'; }
  if (msg) msg.textContent = '正在把这个提示词变成场景…';
  try {
    const sc = await buildScenario(prompt);
    if (btn) { btn.disabled = false; btn.textContent = '建造这个场景'; }
    await startSession(sc);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '建造这个场景'; }
    if (msg) msg.innerHTML = '<b>没建成：</b>' + esc(e.message || String(e));
  }
}
'''
    anchor = "function renderPractice() {"
    assert s.count(anchor) == 1
    s = s.replace(anchor, SETUP + "\n" + anchor)

    # ---------- 3) 设置页里那个「无会话」分支换成建场景 ----------
    i = s.find("function renderPractice() {")
    j = s.find("\n  const sc = V.sess.sc;", i)
    assert i > 0 and j > i
    s = s[:i] + """function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }
""" + s[j:]
    # 去掉原来那行残留的 `const sc = V.sess.sc;` 之后的重复
    s = s.replace("""function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }
  const sc = V.sess.sc;""", """function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }
  const sc = V.sess.sc;""")

    with io.open(P, 'w', encoding='utf-8') as f:
        f.write(s)
    print('场景对话已就位')


if __name__ == '__main__':
    main()
