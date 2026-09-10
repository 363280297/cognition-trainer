# -*- coding: utf-8 -*-
"""两件事：把默认模型换成实测快的那个（并迁移已装的旧设置）；情景直接给用户选好。

=== 第一件：实测数字驱动的模型默认值 ===

用户问「能不能像豆包一样交流」。真实请求量出来的结果：

    deepseek-v4-pro    30.65s/轮   推理 5006 字   ← App 原来的默认值
    deepseek-flash      4.63s/轮   推理 1015 字
    deepseek-chat       1.59s/轮   推理    0 字   ← 像豆包的是这个

也就是说：**对话功能本身是通的**（多轮、JSON 字段齐全、内容也像真人：
「没多久，刚到。停车是挺难的，这附近。」），但默认模型每轮要等 30 秒——
那不是对话，那是写信。豆包的体感靠的就是「说完一秒内有回应」，
所以这一项默认值就是「像不像豆包」的全部差别。

三件事必须一起做，少一件都没用：

  1. 默认值改成 deepseek-chat。
  2. **迁移已经装好的旧设置。** 用户手机上 localStorage 里已经存着
     `deepseek-v4-pro` 了——只改代码默认值对他**完全没有效果**，
     这是这次改动里最容易漏掉的一步。
  3. 设置页给一个带实测速度的模型选择，并在「一轮特别慢」时主动提示。
     因为模型可用性是会变的，写死一个名字早晚会过期；
     用实测延迟来判断「当前这个模型适不适合对话」则一直有效。

另外单独验证过：建场景（9 字段）和复盘（嵌套数组）这两个更复杂的提示词
在 deepseek-chat 上也能稳定吐合格 JSON（1.77s / 3.33s），所以换模型
不会把另外两个功能换坏。

=== 第二件：情景由 App 直接选好 ===

用户的原话：「然后情景是你直接选好的。」

原来进 AI 页要先自己写提示词、或者自己从列表里挑。现在一进去就已经**选好一个**
摆在最上面（「今天就练这个」），一个按钮开始。

选法是本地轮换 + 弱项，不花钱：按「练得最少」优先，同分时难度低的优先。
**故意不用模型现造**——那样每次打开 AI 页都要等一次请求，而大多数人打开
只是想先看看。想要新的仍然可以点「换一个」（本地换，仍然免费）或下面那两条路。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
AP = os.path.join(ROOT, 'public', 'app.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    # ==================================================================
    # 第一件：模型
    # ==================================================================
    v = io.open(VP, encoding='utf-8').read()

    v = sub(v, """const SET_KEY = 'eq-settings-v1';

function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { }
  return Object.assign({
    apiKey: '', model: 'deepseek-v4-pro',""",
            """const SET_KEY = 'eq-settings-v1';
const MIGRATED_KEY = 'eq-model-switched';

/* 实测出来的每轮耗时（真实请求，见 tools/probe_chat.py 的输出）。
   写进代码里的原因：**「像不像对话」几乎只由这一项决定**——
   同一个 App、同一个提示词，换成带推理的模型就从「一秒回一句」变成「等半分钟」。
   数字会过期，所以只用它来当参考文案和默认值；真正判断「快不快」
   靠的是运行时实测（见 noteTurnLatency），那个不会过期。 */
const MODEL_FAST = 'deepseek-chat';
const MODEL_CHOICES = [
  { id: 'deepseek-chat', name: 'deepseek-chat',
    note: '实测约 1.6 秒一轮，无推理。对话用这个。' },
  { id: 'deepseek-flash', name: 'deepseek-flash',
    note: '实测约 4.6 秒一轮（带推理）。能用，但等得出来。' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro',
    note: '实测约 30 秒一轮（推理 5000 字）。适合写内容，不适合对话。' },
];

/* 把老的默认模型改掉。
 *
 * 为什么必须有这一步：用户手机上 localStorage 里已经存了 deepseek-v4-pro。
 * **只改代码里的默认值对他一点效果都没有**——默认值只在没有存过的时候生效，
 * 而他早就存过了。所以「改了默认值但没迁移」= 什么都没改。
 *
 * 只迁移「正好等于老默认值」的那一种，用户自己手填过的其它名字不动。 */
function migrateOldModel() {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.model === 'deepseek-v4-pro') {
      s.model = MODEL_FAST;
      localStorage.setItem(SET_KEY, JSON.stringify(s));
      localStorage.setItem(MIGRATED_KEY, JSON.stringify({ from: 'deepseek-v4-pro', at: Date.now() }));
    }
  } catch (e) { /* 读不动就算了，settings() 会退回默认值 */ }
}

function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { }
  return Object.assign({
    apiKey: '', model: MODEL_FAST,""", tag='settings')

    v = sub(v, """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    handsFree: true,     // 默认免提：用户要的就是「像跟大模型对话」
  }, s);""",
            """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    handsFree: true,     // 默认免提：用户要的就是「像跟大模型对话」
  }, s);""", tag='noop2')

    # 迁移的调用点：boot 时跑一次
    v = sub(v, """function probeNative() {
  if (!V.native) return;
  try { V.caps = JSON.parse(V.native.capabilities()); } catch (e) { }
}""",
            """function probeNative() {
  if (!V.native) return;
  try { V.caps = JSON.parse(V.native.capabilities()); } catch (e) { }
}

/* 载入时就跑一次迁移，而不是等用户打开设置页——否则他会先经历几次 30 秒的等待。 */
migrateOldModel();""", tag='boot')

    # 换过模型的说明
    v = sub(v, """/* 上次用 404 自动回退过的话，在这里说明白。""",
            """/* 把「老默认模型被换掉」这件事说明白。
 *
 * 用户手上那台手机存的是 deepseek-v4-pro，一轮要等三十秒。
 * 我们替他换成了快的——**换了就必须说**：不讲的话他下次看设置页会发现
 * 跟自己记忆里不一样（或者更可能：他根本不知道慢是因为模型）。
 * 说清楚原因和数字，他才能自己判断要不要换回去。 */
function modelSwitchedNotice() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(MIGRATED_KEY) || 'null'); } catch (e) { }
  if (!o || !o.from) return '';
  return `<p class="warnbox" style="margin:0 0 12px">
    模型已经从 <span class="mono-line">${esc(o.from)}</span> 换成了
    <span class="mono-line">${esc(MODEL_FAST)}</span>：前者带推理，实测**一轮要等约 30 秒**，
    拿来做语音对话太慢了（而且推理 token 和正文共用 max_tokens，长一点还会被截断）。
    想要换回去，点下面那个名字就行。
  </p>`;
}

/* 上次用 404 自动回退过的话，在这里说明白。""", tag='notice')

    # 设置页：模型改成「带实测速度的选择」
    v = sub(v, """    <label class="field"><span>模型</span>
      <input type="text" id="setModel" value="${esc(s.model)}"></label>""",
            """    <div class="field"><span>模型</span>
      <div class="chips" style="margin-bottom:8px">
        ${MODEL_CHOICES.map((m) => `<button class="chip-btn ${s.model === m.id ? 'on' : ''}"
          onclick="chooseModel('${m.id}')">${esc(m.name)}</button>`).join('')}
      </div>
      <input type="text" id="setModel" value="${esc(s.model)}" oninput="modelHint()">
      <p class="hint" id="modelHint" style="margin:6px 0 0"></p>
    </div>
    ${modelSwitchedNotice()}""", tag='modelUi')

    v = sub(v, """  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
  previewEndpoint();
}""",
            """  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
  previewEndpoint();
  modelHint();
}

/** 选模型。点了名字就填进输入框，并把这个模型的实测速度写在下面——
 *  用户唯一需要知道的事就是「这个一轮要等多久」。 */
function chooseModel(id) {
  const el = document.getElementById('setModel');
  if (el) el.value = id;
  document.querySelectorAll('.chips .chip-btn').forEach((b) => {
    b.classList.toggle('on', b.textContent.trim() === id);
  });
  modelHint();
}

function modelHint() {
  const el = document.getElementById('setModel');
  const out = document.getElementById('modelHint');
  if (!out) return;
  const v = (el && el.value || '').trim();
  const hit = MODEL_CHOICES.find((m) => m.id === v);
  if (hit) { out.textContent = hit.note; return; }
  out.textContent = v
    ? '这个名字不在实测列表里。如果一轮要等很久，多半是带推理的模型——换成 '
      + MODEL_FAST + ' 会快很多。'
    : '';
}""", tag='chooseModel')

    # ==================================================================
    # 运行时延迟自检（不依赖写死的模型名，所以永远有效）
    # ==================================================================
    v = sub(v, """    setHerThinking(true);
    const o = await llmCall(
      [{ role: 'system', content: llmSystem(V.sess.sc) }, ...V.sess.history], 0.9);""",
            """    setHerThinking(true);
    const t0 = Date.now();
    const o = await llmCall(
      [{ role: 'system', content: llmSystem(V.sess.sc) }, ...V.sess.history], 0.9);
    V.lastTurnMs = Date.now() - t0;""", tag='timing')

    v = sub(v, """  } finally {
    setHerThinking(false);
    V.busy = false;
  }
}""",
            """  } finally {
    setHerThinking(false);
    V.busy = false;
    noteTurnLatency();
  }
}

/* 一轮特别慢时主动说一句。
 *
 * 为什么不写死模型名来判断：模型可用性是会变的（今天是这三个，下个月未必），
 * 而「这一轮实测等了几秒」永远是真的。所以判断依据是**实测延迟**，
 * 建议里才提具体的模型名。这样即使以后模型改名，这条提示也还有效。
 *
 * 阈值 8 秒：正常一轮 1~2 秒，带推理的 5 秒起、往往十几秒以上。
 * 8 秒足够区分，又不会因为偶尔的网络抖动误报。 */
function noteTurnLatency() {
  const ms = V.lastTurnMs || 0;
  if (!ms || ms < 8000) return;
  if (V.latencyWarned) return;      // 一局只提醒一次，不刷屏
  V.latencyWarned = true;
  const cur = settings().model;
  const box = document.getElementById('turnHint');
  const secs = (ms / 1000).toFixed(1);
  const msg = `刚才这一轮等了 ${secs} 秒。当前模型 ${cur} 大概是带推理的——`
    + `换成 ${MODEL_FAST} 一轮大约 1.6 秒，对话会顺得多。`;
  if (box) box.textContent = msg;
  toast(msg);
}""", tag='latency')

    v = sub(v, """  V.noSpeech = 0;
  V.phase = 'idle';
  V.speaking = false;
  V.lastDebrief = null;""",
            """  V.noSpeech = 0;
  V.phase = 'idle';
  V.speaking = false;
  V.lastDebrief = null;
  V.lastTurnMs = 0;
  V.latencyWarned = false;""", tag='reset')

    # ==================================================================
    # 第二件：情景直接选好
    # ==================================================================
    v = sub(v, """function renderTalkSetup() {
  const s = settings();
  const noKey = V.native && !s.apiKey;
  $('#view').innerHTML = `""",
            """/* ---------------------------------------------------- 直接给你选好的情景
 *
 * 用户的原话：「然后情景是你直接选好的。」
 * 原来进 AI 页要先自己写提示词、或者自己从六个里挑。现在一进去就已经选好一个
 * 摆在最上面，一个按钮开始。
 *
 * 选法：**本地轮换 + 弱项，不花钱**。按「练得最少」优先，同分时难度低的优先。
 * 故意不用模型现造——那样每次打开 AI 页都要等一次请求、花一次钱，
 * 而大多数人打开只是想先看一眼。想要新的可以点「换一个」（本地换，仍然免费），
 * 或者走下面那两条路。
 */
let dailySceneId = null;

/** 练得最少的优先；同分时难度低的优先（别一上来就给最难的，那样容易劝退）。 */
function dailySceneCandidates() {
  const list = (CONTENT.scenarios.scenarios || []).slice();
  const done = (state.scenes || {});
  return list.sort((a, b) => {
    const da = done[a.id] || 0, db = done[b.id] || 0;
    if (da !== db) return da - db;
    const fa = Number(a.difficulty) || 2, fb = Number(b.difficulty) || 2;
    if (fa !== fb) return fa - fb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function pickDailyScene() {
  const cands = dailySceneCandidates();
  if (!cands.length) return null;
  if (dailySceneId && cands.some((x) => x.id === dailySceneId)) {
    return cands.find((x) => x.id === dailySceneId);
  }
  dailySceneId = cands[0].id;
  return cands[0];
}

/** 换一个：在候选里往后挪一位。本地操作，不发请求、不花钱。 */
function nextDailyScene() {
  const cands = dailySceneCandidates();
  if (cands.length < 2) { toast('只有这一个现成情景，下面可以自己写一个'); return; }
  const i = Math.max(0, cands.findIndex((x) => x.id === dailySceneId));
  dailySceneId = cands[(i + 1) % cands.length].id;
  renderTalkSetup();
}

/** 这个情景练过几次。用来做轮换，也让用户看见「这个练过了」。 */
function sceneDoneN(id) { return ((state.scenes || {})[id]) || 0; }

function dailySceneCard() {
  const sc = pickDailyScene();
  if (!sc) return '';
  const n = sceneDoneN(sc.id);
  return `<div class="card daily-scene">
    <div class="label" style="margin-bottom:8px">今天就练这个</div>
    <h2 style="margin-bottom:6px">${esc(sc.title)}</h2>
    <div class="daily-meta">
      <span class="tag">${esc(sc.stage || '')}</span>
      <span class="tag">难度 ${esc(String(sc.difficulty || ''))}</span>
      ${n ? `<span class="tag">练过 ${n} 次</span>` : '<span class="tag tag-good">没练过</span>'}
    </div>
    <p class="hint" style="margin:10px 0 0">${esc((sc.her || '').slice(0, 70))}</p>
    <p class="hint" style="margin:8px 0 0">对方会先开口：「${esc(sc.opening || '')}」</p>
    <div class="row row-1" style="margin-top:12px">
      <button class="primary" onclick="startSession('${esc(sc.id)}')">开始这一局</button>
    </div>
    <div class="row row-2">
      <button class="ghost" onclick="nextDailyScene()">换一个情景</button>
      <button class="ghost" onclick="randomStart()">按弱项现造一个</button>
    </div>
  </div>`;
}

function renderTalkSetup() {
  const s = settings();
  const noKey = V.native && !s.apiKey;
  $('#view').innerHTML = `
    ${dailySceneCard()}""", tag='daily')

    # 建场景那张卡改成「自己挑/自己写」，不再是页面主角
    v = sub(v, """    <div class="card">
      <h2>场景对话</h2>
      <p class="hint" style="margin-top:8px">
        AI 演对方，你开口说话。<b>先给一句提示词说明你想练什么</b>，""",
            """    <div class="card">
      <h2>自己出一个题</h2>
      <p class="hint" style="margin-top:8px">
        AI 演对方，你开口说话。<b>先给一句提示词说明你想练什么</b>，""", tag='cardTitle')

    io.open(VP, 'w', encoding='utf-8').write(v)

    # ==================================================================
    # app.js：记录情景练过几次
    # ==================================================================
    a = io.open(AP, encoding='utf-8').read()
    a = sub(a, """  state = Object.assign({
    answers: [], plans: [], bias: {}, stats: { answered: 0, correct: 0, wrongIds: [] },""",
            """  state = Object.assign({
    answers: [], plans: [], bias: {}, stats: { answered: 0, correct: 0, wrongIds: [] },
    // 每个现成情景练过几次。只用来做「今天就练这个」的轮换——
    // 少了它，那个推荐会一直推同一个，用户点两次就再也不想看推荐了。
    scenes: {},""", tag='stateScenes')
    io.open(AP, 'w', encoding='utf-8').write(a)

    # endSession 里记一笔
    v = io.open(VP, encoding='utf-8').read()
    v = sub(v, """  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;""",
            """  // 只在真实结束时记一笔（结束页可能被反复渲染，但 endSession 只走一次）
  if (!V.ended && s.sc && !/^gen-/.test(s.sc.id)) {
    state.scenes = state.scenes || {};
    state.scenes[s.sc.id] = (state.scenes[s.sc.id] || 0) + 1;
    save();
  }
  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;""", tag='record')
    io.open(VP, 'w', encoding='utf-8').write(v)

    # CSS
    c = io.open(os.path.join(ROOT, 'public', 'style.css'), encoding='utf-8').read()
    c += """
/* ---------- 今天就练这个 ---------- */
.daily-scene { border: 1px solid #3a4a6a; background: linear-gradient(180deg, #1d2331, #1b1d27); }
.daily-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.daily-meta .tag {
  font-size: .72rem; color: var(--dim);
  background: var(--panel2); border: 1px solid var(--line);
  border-radius: 999px; padding: 3px 9px;
}
.daily-meta .tag-good { color: #8fd8a8; border-color: #2f5340; background: #1d3226; }
"""
    io.open(os.path.join(ROOT, 'public', 'style.css'), 'w', encoding='utf-8').write(c)
    print('模型默认值改成 deepseek-chat + 迁移旧设置 + 情景直接选好')


if __name__ == '__main__':
    main()
