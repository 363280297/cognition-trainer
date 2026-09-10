# -*- coding: utf-8 -*-
"""网页侧：音色选择 + 试听 + 去系统下载音色，以及识别精度开关。

这一半是把 Android 那边的能力接上。几个刻意的决定：

1. **显示用的中文在网页侧拼，不在 Java 里拼。** Java 只回结构化字段
   （locale/quality/network/installed），文案由这里统一处理——和这个项目
   「UI 文案集中在网页层」的做法一致，改文案不用重编 APK。

2. **音色名对用户没有意义。** `zh-cn-x-ccc-local` 这种名字谁也看不懂，
   所以显示成「中文（中国大陆）· 需联网 · 音质 5」这样，
   真正影响「像不像真人」的就是这些字段。

3. **区分「要联网」和「已下载」。** 要联网的音色通常音质最好，
   但没网就哑；没下载的音色选了会静默退回默认——这是「选了没反应」的经典来源，
   所以两者都要标出来，并对未下载的给一个去系统下载的入口。

4. **识别精度交给用户。** 默认优先在线（更准）。要如实说这是**偏好**而不是保证：
   EXTRA_PREFER_OFFLINE 只是提示引擎，引擎可以不听。写死成保证就是撒谎。

5. **试听要能还原。** 试听会临时切音色，试完必须切回用户原来选的，
   否则「试了几个音色之后声音变了」会变成一个说不清的 bug。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    # ---------- 1) 设置默认值 ----------
    v = sub(v, """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    handsFree: true,     // 默认免提：用户要的就是「像跟大模型对话」
  }, s);""",
            """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    handsFree: true,     // 默认免提：用户要的就是「像跟大模型对话」
    voice: '',           // 空 = 自动（用系统默认那个中文音色）
    asrOffline: false,   // 默认优先在线识别：更准。见 startListen 的说明
  }, s);""", tag='defaults')

    # ---------- 2) listen 要把模式传下去 ----------
    v = sub(v, """    V.native.listen();
  } else {""",
            """    // 把识别模式传下去。默认优先在线——离线中文识别的模型小得多，
    // 长句子错得更多，而 AI 对话本来就必须联网，强制离线换不来任何东西。
    V.native.listen(!!settings().asrOffline);
  } else {""", tag='listenArg')

    # ---------- 3) 启动时把已保存的音色应用上 ----------
    v = sub(v, """/* 载入时就跑一次迁移，而不是等用户打开设置页——否则他会先经历几次 30 秒的等待。 */
migrateOldModel();""",
            """/* 载入时就跑一次迁移，而不是等用户打开设置页——否则他会先经历几次 30 秒的等待。 */
migrateOldModel();

/* 把存着的音色应用上。放在载入时做：原生那边 TTS 初始化是异步的，
   所以这里失败一次没关系——真正的合成之前原生会再确认一次（见 applyVoice）。 */
function applyVoiceSetting() {
  if (!V.native || !V.native.setVoice) return;
  try { V.native.setVoice(settings().voice || ''); } catch (e) { }
}
applyVoiceSetting();""", tag='applyBoot')

    # ---------- 4) 设置页：声音那一块 ----------
    v = sub(v, """    <label class="field"><span>语速 ${''}<input type="range" id="setRate" min="0.7" max="1.4" step="0.05" value="${s.rate}"></span></label>
    <label class="field"><span>音调 <input type="range" id="setPitch" min="0.7" max="1.4" step="0.05" value="${s.pitch}"></span></label>""",
            """    ${V.native ? `<div class="field"><span>对方的声音（音色）</span>
      <div id="voiceBox" class="voice-box"><p class="hint">正在读取这台手机上的中文音色…</p></div>
      <div class="row row-2">
        <button class="ghost" onclick="loadVoices(true)">重新读取</button>
        <button class="ghost" onclick="EQNative && EQNative.installVoiceData && EQNative.installVoiceData()">去系统里下载音色</button>
      </div>
      <p class="hint" style="margin:8px 0 0">
        音色来自这台手机自己的语音合成引擎（不同手机差别很大，有的还带好几个音色）。
        「像不像真人」几乎全靠它——所以这几个音色都值得试听一遍再定。
        要更好的只能换成云端语音合成，那需要另外的服务和密钥。
      </p>
    </div>` : ''}
    <label class="field"><span>语速 ${''}<input type="range" id="setRate" min="0.7" max="1.4" step="0.05" value="${s.rate}"></span></label>
    <label class="field"><span>音调 <input type="range" id="setPitch" min="0.7" max="1.4" step="0.05" value="${s.pitch}"></span></label>
    ${V.native ? `<div class="field"><span>语音识别（听你说话）</span>
      <div class="chips">
        <button class="chip-btn ${s.asrOffline ? '' : 'on'}" onclick="setAsrMode(false)">优先在线（更准）</button>
        <button class="chip-btn ${s.asrOffline ? 'on' : ''}" onclick="setAsrMode(true)">只用离线（不联网）</button>
      </div>
      <p class="hint" style="margin:8px 0 0" id="asrHint"></p>
      <div class="row"><button class="ghost" onclick="testAsr()">说一句话试试识别</button></div>
    </div>` : ''}""", tag='voiceUi')

    # ---------- 5) 音色面板的逻辑 ----------
    v = sub(v, """  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
  previewEndpoint();
  modelHint();
}""",
            """  sh.addEventListener('click', closeSheet);
  document.body.appendChild(sh);
  previewEndpoint();
  modelHint();
  asrHint();
  loadVoices();
}

/* ---------------------------------------------------------- 音色（语音包）
 *
 * 用户问：「他是不是应该会有语音包那种的？发出类似真人的声音。」
 *
 * 在 Android 上这就是系统合成引擎自带的音色列表：Google、讯飞、华为、小米
 * 各不一样，有的引擎一个中文音色都没有、有的有十几个，质量差别很大。
 * 而且很多音色是**可下载的数据包**——装完之后列表里会多出来，那就是「语音包」。
 *
 * 所以这里不做音色包（那等于往安装包里塞几十 MB，质量还不如系统自带的），
 * 而是把系统里的音色列出来、能试听、能引导去下载。
 */
let VOICE_LIST = null;

function voiceLabel(v) {
  // 音色名（zh-cn-x-ccc-local）对用户没有意义，翻成人能判断的东西
  const loc = /CN|Hans/i.test(v.locale || '') ? '中文（中国大陆）'
    : /TW|Hant/i.test(v.locale || '') ? '中文（台湾）'
      : /HK/i.test(v.locale || '') ? '中文（香港）' : (v.locale || '中文');
  const bits = [loc];
  if (v.network) bits.push('需联网');
  else bits.push('可离线');
  if (v.quality >= 500) bits.push('音质很高');
  else if (v.quality >= 400) bits.push('音质高');
  else if (v.quality >= 300) bits.push('音质中');
  return bits.join(' · ');
}

async function loadVoices(force) {
  const box = document.getElementById('voiceBox');
  if (!box) return;
  if (!V.native || !V.native.voices) {
    box.innerHTML = '<p class="hint">这个功能只在 Android App 里可用。</p>';
    return;
  }
  if (!VOICE_LIST || force) {
    box.innerHTML = '<p class="hint">正在读取…</p>';
    try {
      const raw = V.native.voices();
      VOICE_LIST = JSON.parse(raw || '[]');
      if (!Array.isArray(VOICE_LIST)) VOICE_LIST = [];
    } catch (e) {
      VOICE_LIST = [];
    }
  }
  renderVoices();
}

function renderVoices() {
  const box = document.getElementById('voiceBox');
  if (!box) return;
  const cur = settings().voice || '';
  // 排个序：已下载的、可离线的、音质高的排前面——用户最可能选的是这些
  const list = (VOICE_LIST || []).slice().sort((a, b) => {
    if (!!a.installed !== !!b.installed) return a.installed ? -1 : 1;
    if (!!a.network !== !!b.network) return a.network ? 1 : -1;
    return (b.quality || 0) - (a.quality || 0);
  });
  if (!list.length) {
    box.innerHTML = `<p class="hint">这台手机的语音引擎没有中文音色。
      点下面的「去系统里下载音色」，或者在系统的「文字转语音」设置里换一个引擎
      （Google 语音服务、讯飞语记之类都带中文音色）。</p>`;
    return;
  }
  const rows = [`<button class="voice-item ${cur === '' ? 'on' : ''}" onclick="chooseVoice('')">
      <span class="voice-name">自动（推荐）</span>
      <span class="voice-meta">用系统默认的中文音色</span>
    </button>`];
  list.forEach((v) => {
    const mark = cur === v.name ? '已选' : (v.installed ? '' : '未下载');
    rows.push(`<button class="voice-item ${cur === v.name ? 'on' : ''}"
        onclick="chooseVoice('${esc(v.name)}')">
        <span class="voice-name">${esc(voiceLabel(v))}</span>
        <span class="voice-mark">${esc(mark)}</span>
        <span class="voice-meta">${esc(v.name)}</span>
      </button>`);
  });
  box.innerHTML = `<div class="voice-list">${rows.join('')}</div>
    <div class="row"><button class="ghost" onclick="previewVoice()">试听一下（用当前选的音色）</button></div>`;
}

/** 选音色。点一下立刻存 + 立刻应用，这样「试听」听到的就是刚点的那个。 */
function chooseVoice(name) {
  saveSettings({ voice: name || '' });
  applyVoiceSetting();
  VOICE_LIST = VOICE_LIST || [];
  renderVoices();
  const v = (VOICE_LIST || []).find((x) => x.name === name);
  if (v && !v.installed) {
    toast('这个音色还没下载，多半发不出声。点「去系统里下载音色」装上再用。');
  }
}

/* 试听。
 *
 * 必须**先把当前选的音色转发过去**再出声：用户点「试听」时可能刚改了选择
 * 但还没点保存，试听要听到的是他刚选的那个，否则这个按钮等于没用。
 * 这里不额外做「试完还原」——因为 chooseVoice 已经把选择存下来了，
 * 试听用的就是正式生效的音色，不存在「试听污染」。
 */
function previewVoice() {
  applyVoiceSetting();
  const st = settings();
  speak('你好，我是今天的练习对象。你现在听到的就是这个音色的声音。');
  setTimeout(() => { try { st; } catch (e) { } }, 0);
}

function setAsrMode(offline) {
  saveSettings({ asrOffline: !!offline });
  document.querySelectorAll('.chips .chip-btn').forEach((b) => {
    const t = b.textContent.trim();
    if (/优先在线|只用离线/.test(t)) {
      b.classList.toggle('on', offline ? /只用离线/.test(t) : /优先在线/.test(t));
    }
  });
  asrHint();
}

function asrHint() {
  const el = document.getElementById('asrHint');
  if (!el) return;
  el.textContent = settings().asrOffline
    ? '只用离线识别：不联网，但离线中文模型明显小，长句子和口语更容易错。'
      + '注意这里只是「偏好」——引擎自己可以不听。'
    : '优先在线识别：更准，尤其长句子。反正对话本身就要联网，所以这里没有额外代价。'
      + '这只是「偏好」，不是保证：引擎有权自己决定用哪个。';
}

/** 识别自检：录一句，把识别结果原样显示出来（不做任何加工）。
 *  这样用户能自己判断「识别准不准」，而不是靠感觉。 */
function testAsr() {
  const out = document.getElementById('setOut');
  if (out) out.textContent = '正在听…说一句话看看';
  if (!V.native || !V.caps.asr) {
    if (out) out.textContent = '这台手机没有可用的语音识别。';
    return;
  }
  startListen(
    (p) => { if (out && p && p !== '…') out.textContent = '在听：' + p; },
    (text) => {
      if (out) {
        out.textContent = text
          ? `识别结果：「${text}」\n（模式：${settings().asrOffline ? '只用离线' : '优先在线'}；`
            + `字数 ${String(text).length}。如果明显不对，试着切到「优先在线」）`
          : '没听清，再说一次。';
      }
    },
    (msg) => { if (out) out.textContent = msg === 'NO_ASR' ? '这台手机没有语音识别。' : msg; }
  );
}""", tag='voiceLogic')

    # ---------- 6) 保存设置时把音色应用上 ----------
    v = sub(v, """  saveSettings({
    apiKey: g('setKey'), model: g('setModel') || 'deepseek-v4-pro',""",
            """  saveSettings({
    apiKey: g('setKey'), model: g('setModel') || MODEL_FAST,""", tag='saveModelDefault')

    v = sub(v, """  if (norm.bad) toast(norm.bad);""",
            """  applyVoiceSetting();     // 音色可能刚改过，存完立刻生效
  if (norm.bad) toast(norm.bad);""", tag='applyAfterSave')

    io.open(VP, 'w', encoding='utf-8').write(v)

    # ---------- CSS ----------
    c = io.open(os.path.join(ROOT, 'public', 'style.css'), encoding='utf-8').read()
    c += """
/* ---------- 音色（语音包） ---------- */
.voice-list { max-height: 44vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.voice-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  gap: 2px 10px; width: 100%; text-align: left; font: inherit;
  background: var(--panel2); border: 1px solid var(--line); border-radius: 11px;
  padding: 10px 12px; margin-bottom: 7px; cursor: pointer;
}
.voice-item.on { background: #1e2e26; border-color: var(--good); }
.voice-name { font-size: .88rem; font-weight: 600; color: var(--text); }
.voice-mark { font-size: .72rem; color: var(--good); font-weight: 600; justify-self: end; }
.voice-meta {
  grid-column: 1 / -1; font-size: .68rem; color: var(--dim);
  font-family: ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere;
}
"""
    io.open(os.path.join(ROOT, 'public', 'style.css'), 'w', encoding='utf-8').write(c)
    print('网页侧：音色可挑/可试听/可下载，识别模式可选')


if __name__ == '__main__':
    main()
