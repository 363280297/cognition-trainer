# -*- coding: utf-8 -*-
"""语音对话：免提输入 + 随机场景 + 对话后复盘。

用户的原话（纠正我上一版的误解）：
  「我说的语音功能是跟之前一样的，但是你要加入一个语音输入，相当于跟大模型对话。
    是自己选择场景，或者说你随机给我一些场景，让我自己来训练，随机的。
    然后对话完之后给我评价，以及改进措施。」

拆成三件事，加上我在读代码时发现的两个真问题，一共五处改动：

A. **免提**（这是用户说的「相当于跟大模型对话」的核心）
   原来只有「按住说话」——按住才收音、松开才发。那是对讲机，不是对话：
   手不能离开屏幕，中途也不能想一下。改成说完停一下它自己发出去，
   然后自动把麦克风交回给你。

B. **随机场景**：不用写提示词，直接按你当前的弱项随机造一个。
   随机在这里不是图省事——自己选题会稳定地偏向自己已经擅长的那类，
   这是刻意练不出来的原因之一。

C. **补回「直接选一个现成场景」**：上一版我把设置页从「6 个固定场景」
   改成了「提示词输入框」，顺手把点开就进的入口删掉了。用户这次明确要
   「自己选择场景」，所以补回来。

D. **修 native onStop 漏实现**（已在 Java 侧改）：tts.stop() 不回调 onDone，
   只回调 onStop。不实现它，「她正在说」这个状态永远关不掉，
   表现是点了「打断」之后整局不动、且不报错——而浏览器里测不出来。

E. **角色提示词把「中国女性」写死了**。6 个老场景的 her 里都是女性，
   所以看不出来；但随机场景会造出男同事、男上级，那时角色和身份对不上。
   改成由 her 自己定义，并在生成场景时要求写清是谁。

不做的：不写自己的 VAD。Android 的 SpeechRecognizer 本来就在静音后自动结束
并回调 onResults，「说完停一下自动发」不需要自己判静音。
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

    # ============================================================== A0. V 状态
    s = sub(s, """const V = {
  native: (typeof EQNative !== 'undefined') ? EQNative : null,
  caps: { tts: false, asr: false, http: false, mic: false },
  waiters: {},
  seq: 0,
  asr: null,        // 当前识别回调集合
  sess: null,       // 当前陪练会话
  busy: false,
};""", """const V = {
  native: (typeof EQNative !== 'undefined') ? EQNative : null,
  caps: { tts: false, asr: false, http: false, mic: false },
  waiters: {},
  seq: 0,
  asr: null,        // 当前识别回调集合
  sess: null,       // 当前陪练会话
  busy: false,
  /* 免提对话的状态机。phase 只有四个值，界面上的按钮和提示全靠它：
   *   idle      = 等你开口
   *   listening = 麦克风开着
   *   thinking  = 她在想
   *   speaking  = 她正在出声（这时绝不能开麦克风，否则会把她自己录进去） */
  hf: true,
  phase: 'idle',
  speaking: false,
  noSpeech: 0,      // 连续几次没听到声音——用来给自动重试封顶
  ended: false,     // 这一局已经结束，不许再自动开麦
  lastDebrief: null,
};""")

    # ============================================================== A1. 设置默认值
    s = sub(s, """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
  }, s);""", """    maxTokens: 3000, rate: 1, pitch: 1, autoSpeak: true,
    handsFree: true,     // 默认免提：用户要的就是「像跟大模型对话」
  }, s);""")

    # ============================================================== A2. speak/stopSpeak
    s = sub(s, """function speak(text) {
  const st = settings();
  const style = TONE_STYLE[(V.sess && V.sess.lastTone) || '平淡'] || { rate: 1, pitch: 1 };
  const rate = style.rate * (st.rate || 1);
  const pitch = style.pitch * (st.pitch || 1);
  if (V.native && V.caps.tts) {
    V.native.speak(text, rate, pitch);
  } else if (window.speechSynthesis) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = rate; u.pitch = pitch;
      speechSynthesis.speak(u);
    } catch (e) { }
  }
}

function stopSpeak() {
  if (V.native && V.caps.tts) V.native.stopSpeak();
  else if (window.speechSynthesis) speechSynthesis.cancel();
}""", """function speak(text) {
  const st = settings();
  const style = TONE_STYLE[(V.sess && V.sess.lastTone) || '平淡'] || { rate: 1, pitch: 1 };
  const rate = style.rate * (st.rate || 1);
  const pitch = style.pitch * (st.pitch || 1);
  V.speaking = true;
  setPhase('speaking');
  if (V.native && V.caps.tts) {
    V.native.speak(text, rate, pitch);
  } else if (window.speechSynthesis) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = rate; u.pitch = pitch;
      // 浏览器侧没有原生回调，得自己接上，否则「她正在说」永远不会结束
      u.onend = () => onSpeakDone();
      u.onerror = () => onSpeakDone();
      speechSynthesis.speak(u);
    } catch (e) { V.speaking = false; }
  } else {
    // 连合成都没有：当作「已经说完了」，让循环继续，不要卡在这里
    V.speaking = false;
    onSpeakDone();
  }
}

/** 她出声结束（正常说完 / 被打断 / 失败）。三种都必须走到这里，少一种循环就断。 */
function onSpeakDone() {
  if (!V.speaking && V.phase !== 'speaking') return;
  V.speaking = false;
  if (V.phase === 'speaking') setPhase('idle');
  maybeAutoListen();
}

function stopSpeak() {
  // 先自己把状态落下来再去停声音。原因：tts.stop() 在 Android 上只回调 onStop，
  // 而「不回调」和「晚回调」在界面上是分不清的——状态由声音那边负责的话，
  // 一旦回调没来，免提循环就永远停在「她正在说」，且不报错。
  V.speaking = false;
  if (V.phase === 'speaking') setPhase('idle');
  if (V.native && V.caps.tts) V.native.stopSpeak();
  else if (window.speechSynthesis) speechSynthesis.cancel();
}""")

    # ============================================================== A3. __onSpeak
    s = sub(s, """window.__onSpeak = function (state) {
  if (state === 'unavailable') toast('这台手机的语音合成不可用，只能看文字');
};""", """window.__onSpeak = function (state) {
  if (state === 'unavailable') {
    toast('这台手机的语音合成不可用，只能看文字');
    onSpeakDone();          // 也必须往前推进，否则免提在这里就停住了
    return;
  }
  if (state === 'done' || state === 'error' || state === 'stop') onSpeakDone();
};""")

    # ============================================================== A4. 状态机
    s = sub(s, """/* ---------------------------------------------------------------- 会话 */""",
            r"""/* ---------------------------------------------------------- 免提对话状态机
 *
 * 用户的原始要求：「你要加入一个语音输入，相当于跟大模型对话。」
 * 原来只有「按住说话」——按住才收音、松开才发出去。那是个对讲机，不是对话：
 * 手不能离开屏幕，中途也不能停下来想一下。
 *
 * 这里改成：**说完停一下，它自己就发出去了**，然后自动把麦克风交回给你。
 * 循环是：
 *     开始收音 → 你说话 → 系统判定你说完了 → 发出去 → 她在想
 *     → 她出声 → 她说完 → 自动开始收音（回到第一步）
 *
 * 「系统判定你说完了」这一步**不需要自己写 VAD**：Android 的 SpeechRecognizer
 * 本来就会在静音之后自动结束并回调 onResults。所以这一层只是把那个回调接起来。
 *
 * 有三件事必须专门处理，否则这个循环会立刻坏掉，而且坏得看不出来：
 *
 *  1. **绝不在她出声的时候开麦克风。** 否则她的话被自己录进去，变成她自问自答，
 *     而用户完全看不出哪里错了。所以只有收到 onSpeakDone 之后才重新收音，
 *     再等一小段——某些机型 done 会比实际尾音早到一点。
 *  2. **没听到声音不能无限重试。** 用户可能只是把手机放下了。连续几次空结果就停下，
 *     把控制权交回去，而不是让麦克风一直开着耗电。
 *  3. **必须随时能停。** 一个关不掉的麦克风比没有这个功能更糟。
 *     所以：她说话时点一下 = 打断；正在听时点一下 = 说完了，发出去。
 */
const EMPTY_ASR = /没听清|没听到声音|没听到|NO_ASR/;
const MAX_NO_SPEECH = 3;
const LISTEN_GAP_MS = 350;   // 她说完到开麦之间的间隔，防止录进她自己的尾音

function setPhase(p) {
  V.phase = p;
  renderTalkBar();
}

function phaseLabel() {
  if (V.phase === 'thinking') return '她在想怎么回你…';
  if (V.phase === 'speaking') return '她在说';
  if (V.phase === 'listening') return '在听你说';
  return V.hf ? '该你说了' : '按住下面的按钮说话';
}

function micLabel() {
  if (V.phase === 'thinking') return '她在想…';
  if (V.phase === 'speaking') return '打断她';
  if (V.phase === 'listening') return '说完了，发出';
  return '开始说';
}

/** 只改状态条的文字和按钮，不重渲染整个页面——重渲染会把聊天记录清掉。
 *  打字那条路和只读渲染（比如复盘页）下这些元素不存在，所以要能空转。 */
function renderTalkBar() {
  const card = document.getElementById('talkCard');
  if (!card) return;
  card.classList.toggle('hf-on', !!V.hf);
  const t = document.getElementById('phaseText');
  const d = document.getElementById('phaseDot');
  const l = document.getElementById('micLabel');
  const b = document.getElementById('micBtn');
  if (t) t.textContent = phaseLabel();
  if (d) d.className = 'phase-dot ' + V.phase;
  if (l) l.textContent = micLabel();
  if (b) {
    b.className = 'mic-big ' + V.phase;
    b.disabled = V.phase === 'thinking';
  }
}

function maybeAutoListen() {
  if (!V.hf || !V.sess || V.ended) return;
  if (!V.native || !V.caps.asr) return;
  if (V.busy || V.phase === 'speaking' || V.phase === 'thinking') return;
  if (V.phase === 'listening') return;
  setTimeout(() => {
    if (!V.hf || !V.sess || V.ended || V.busy) return;
    if (V.phase === 'speaking' || V.phase === 'listening') return;
    autoListen();
  }, LISTEN_GAP_MS);
}

function autoListen() {
  if (!V.sess || V.ended) return;
  if (!V.native || !V.caps.asr) return;
  stopSpeakForListen();
  setPhase('listening');
  renderTurnHint('在听…说完停一下就行');
  startListen(
    (partial) => renderTurnHint(partial && partial !== '…' ? partial : '在听…'),
    (text) => {
      if (text && text.trim()) {
        V.noSpeech = 0;
        setPhase('idle');
        renderTurnHint('');
        userSaid(text);
      } else {
        onNoSpeech();
      }
    },
    (msg) => {
      if (!msg || msg === 'NO_ASR') {
        // 这台机器没有识别引擎。这不是错误，是能力缺失，直接停掉免提并说清楚。
        pauseHandsFree('这台手机没有语音识别，用下面的输入框打字吧');
        return;
      }
      if (EMPTY_ASR.test(msg)) { onNoSpeech(); return; }
      // 权限、引擎忙、网络：这些重试没用，说清楚并停手（别让麦克风一直开着）
      setPhase('idle');
      renderTurnHint(msg);
      pauseHandsFree(msg);
    }
  );
}

/** 开麦之前一定先闭嘴。stopSpeak 会顺手把 phase 落回 idle，所以要放前面调用。 */
function stopSpeakForListen() {
  if (V.speaking) stopSpeak();
}

function onNoSpeech() {
  V.noSpeech = (V.noSpeech || 0) + 1;
  setPhase('idle');
  if (V.noSpeech >= MAX_NO_SPEECH) {
    // 只是这一局先停，不写进设置：用户可能只是刚走开，下次进来还该是免提
    V.hf = false;
    renderTalkBar();
    renderTurnHint('连着几次没听到声音，先把免提关了。点「免提」可以再开。');
    return;
  }
  renderTurnHint('没听到声音，还在听…（点「开始说」可以重新收）');
  maybeAutoListen();
}

/** 停掉免提。persist=true 时写进设置——只在「重试也没用」的原因上这么做
 *  （没有识别引擎、没有麦克风权限），否则每次进来都会白开一次麦克风。 */
function pauseHandsFree(msg, persist) {
  V.hf = false;
  V.phase = 'idle';
  if (persist) saveSettings({ handsFree: false });
  renderTalkBar();
  renderTurnHint(msg || '');
}

function setHandsFree(on) {
  V.hf = !!on;
  V.noSpeech = 0;
  saveSettings({ handsFree: V.hf });
  renderTalkBar();
  if (V.hf) {
    if (!V.native || !V.caps.asr) {
      pauseHandsFree('这台手机没有语音识别，用下面的输入框打字吧', true);
      return;
    }
    renderTurnHint('免提已开。说完停一下，它自己会发出去。');
    maybeAutoListen();
  } else {
    stopListen();
    renderTurnHint('已切回按住说话。');
  }
}

/** 那个大按钮。四种状态四种含义，必须一眼能看出点下去会发生什么。 */
function micTap() {
  if (!V.sess || V.ended) return;
  if (V.phase === 'speaking') { stopSpeak(); maybeAutoListen(); return; }   // 打断她
  if (V.phase === 'listening') { stopListen(); return; }                   // 说完了 → 系统会把结果发回来
  if (V.busy || V.phase === 'thinking') return;
  autoListen();
}

/* ---------------------------------------------------------------- 会话 */""")

    # ============================================================== A5. nextTurn 记账 + 自动续听
    s = sub(s, """    V.sess.turn++;
    V.sess.lastTone = o.tone || '平淡';
    const d = Number(o.temp_delta) || 0;
    V.sess.temp = Math.max(0, Math.min(100, Number(o.temp) || (V.sess.temp + d)));
    o.temp = V.sess.temp;
    V.sess.history.push({ role: 'assistant', content: o.reply });
    V.sess.log.push(o);
    showHerTurn(o);
    if (settings().autoSpeak) speak(o.reply);
  } catch (e) {""", """    V.sess.turn++;
    V.sess.lastTone = o.tone || '平淡';
    const d = Number(o.temp_delta) || 0;
    V.sess.temp = Math.max(0, Math.min(100, Number(o.temp) || (V.sess.temp + d)));
    o.temp = V.sess.temp;
    // 把用户**自己的原话**记进这一轮的记录里。以前只存了模型给的 signal（「他这句
    // 发出了什么信号」），于是复盘时想引用他说过的词只能靠模型转述——
    // 引用原话和转述在教练这件事上差别很大，前者才是可执行的。
    o.userText = userText || '';
    V.sess.history.push({ role: 'assistant', content: o.reply });
    V.sess.log.push(o);
    showHerTurn(o);
    if (settings().autoSpeak) speak(o.reply);
    else onSpeakDone();      // 静音模式下没有「说完」这个事件，得自己推进循环
  } catch (e) {""")

    # ============================================================== A6. userSaid 收尾
    s = sub(s, """  pushBubble('me', t);
  renderTurnHint('');
  updateAskMeter();
  await nextTurn(t);
}""", """  pushBubble('me', t);
  renderTurnHint('');
  updateAskMeter();
  setPhase('idle');
  stopListen();               // 结果已经拿到了，别让麦克风继续开着
  await nextTurn(t);
}""")

    # ============================================================== A7. 会话界面
    s = sub(s, """    <div class="card v-talk" id="talkCard">
      <div class="talk-row">
        <button class="ptt" id="pttBtn"
          onmousedown="pttDown()" onmouseup="pttUp()" onmouseleave="pttUp()"
          ontouchstart="event.preventDefault();pttDown()" ontouchend="event.preventDefault();pttUp()">
          <span id="pttLabel">按住说话</span>
        </button>
      </div>
      <div class="type-row">
        <input type="text" id="typeIn" placeholder="也可以直接打字（说不出话时用）" onkeydown="if(event.key==='Enter')sendTyped()">
        <button class="primary" style="width:auto;padding:10px 16px" onclick="sendTyped()">发出</button>
      </div>
      <div class="hint" id="turnHint" style="margin-top:8px"></div>
      <div class="ask-meter" id="askMeter"></div>
    </div>`;
  updateAskMeter();
}""", """    <div class="card v-talk" id="talkCard">
      <div class="phase-line">
        <span class="phase-pill"><i class="phase-dot" id="phaseDot"></i><span id="phaseText"></span></span>
        <button class="hf-toggle" id="hfBtn" onclick="setHandsFree(!V.hf)"></button>
      </div>

      <!-- 免提：说完停一下自动发。两种模式都渲染出来、用 class 切显示，
           而不是按模式重渲染——重渲染会把已经聊过的记录清掉。 -->
      <div class="hf-only">
        <button class="mic-big" id="micBtn" onclick="micTap()">
          <span id="micLabel">开始说</span>
        </button>
      </div>
      <div class="ptt-only talk-row">
        <button class="ptt" id="pttBtn"
          onmousedown="pttDown()" onmouseup="pttUp()" onmouseleave="pttUp()"
          ontouchstart="event.preventDefault();pttDown()" ontouchend="event.preventDefault();pttUp()">
          <span id="pttLabel">按住说话</span>
        </button>
      </div>

      <div class="type-row">
        <input type="text" id="typeIn" placeholder="也可以直接打字（说不出话时用）" onkeydown="if(event.key==='Enter')sendTyped()">
        <button class="primary" style="width:auto;padding:10px 16px" onclick="sendTyped()">发出</button>
      </div>
      <div class="hint" id="turnHint" style="margin-top:8px"></div>
      <div class="ask-meter" id="askMeter"></div>
    </div>`;
  updateAskMeter();

  /* 进来就该能开口，不用先点一下。
   * 但有一个例外：这一局的**开场白还在合成中**（speak 里 phase=speaking），
   * 那时开麦会把她自己的声音录进去，所以交给 onSpeakDone 去续。 */
  const hb = document.getElementById('hfBtn');
  if (hb) hb.textContent = V.hf ? '免提：开' : '免提：关';
  renderTalkBar();
  if (V.hf) maybeAutoListen();
}""")

    # ============================================================== 老场景补回 + 随机 + 复盘
    s = sub(s, """function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }""", """function renderPractice() {
  if (!V.sess) { renderTalkSetup(); return; }""")

    # ---- 设置页：补回直接选场景 + 随机按钮 ----
    s = sub(s, """      <div class="row">
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
}""", """      <div class="row">
        <button class="primary" id="buildBtn" onclick="buildAndStart()">建造这个场景</button>
        <button class="ghost" id="randBtn" onclick="randomStart()">随机来一个</button>
      </div>
      <div id="sceneMsg" class="hint" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="label" style="margin-bottom:4px">现成的场景，点开就练</div>
      <p class="hint" style="margin-bottom:10px">
        这几个是打磨过的固定场景。随机那个是现造的，每次不一样。
      </p>
      <div class="seed-list">
        ${(CONTENT.scenarios.scenarios || []).map((x) => `<button class="seed preset" onclick="startSession('${esc(x.id)}')">
          <b>${esc(x.title)}</b><span class="seed-meta">${esc(x.stage)} · 难度 ${esc(String(x.difficulty))}</span></button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="label" style="margin-bottom:4px">没有想法？点一条填进上面再改</div>
      <div class="seed-list">
        ${SCENE_SEEDS.map((x, i) => `<button class="seed" onclick="useSeed(${i})">${esc(x)}</button>`).join('')}
      </div>
    </div>

    <div class="row"><button class="ghost" onclick="openSettings()">⚙ 设置（API 密钥 / 语速）</button></div>`;
}

/* ------------------------------------------------------------ 随机场景
 *
 * 用户的原话：「或者说你随机给我一些场景，让我自己来训练，随机的。」
 *
 * 随机在这里不是图省事。**自己选题会稳定地偏向自己已经擅长的那类**——
 * 练得舒服，但练不到短板上。所以随机的池子由零件拼出来（谁 / 在哪 / 要干什么 /
 * 难在哪 / 最容易怎么错），再叠上你当前的偏差画像（biasFocus），
 * 让随机出来的东西偏向你的弱项，而不是均匀随机。
 *
 * 这样做还有个好处：模型不会因为「提示词太短」而反复生成同一种场景——
 * 零件每次都不同。
 */
const RANDOM_PARTS = {
  who: ['同事', '刚认识不久的人', '处了半年的对象', '老同学', '家里长辈', '朋友带来的新朋友',
        '健身房的熟人', '你的上级', '邻居', '相亲对象'],
  where: ['微信群里', '当面一对一', '饭桌上还有别人在场', '电话里', '刚见面等电梯的时候',
          '深夜发消息', '很多人一起的时候'],
  goal: ['把一件不好开口的事说清楚，但不伤关系', '接住对方的情绪，而不是急着解决问题',
         '在不翻脸的前提下把界限说清楚', '让话题别停在这里，而且不许硬找话说',
         '听出对方嘴上没说但真正想要的是什么', '对方越说越冷，想办法把局面弄回来'],
  hard: ['对方正在情绪上，不太配合', '有第三个人在场，你要顾面子', '这件事以前提过一次，对方不太高兴',
         '时间很紧，必须当场给答复', '对方话很少，多数时候只回一两个字'],
  wrong: ['急着讲道理、给方案', '为了不冷场硬找话题', '随口打圆场把事盖过去',
          '一直道歉或一直解释', '只回「嗯」「好的」这类最省事的话'],
};

function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomPrompt() {
  const focus = (typeof biasFocus === 'function') ? biasFocus() : [];
  const parts = [
    `关系是「${pickOne(RANDOM_PARTS.who)}」，场合是「${pickOne(RANDOM_PARTS.where)}」。`,
    `我要练的是：${pickOne(RANDOM_PARTS.goal)}。`,
    `难度来源：${pickOne(RANDOM_PARTS.hard)}。`,
    `我最容易犯的错：${pickOne(RANDOM_PARTS.wrong)}。`,
  ];
  if (focus.length) {
    // 把弱项喂进去，让随机不是均匀随机
    parts.push(`另外，我最近的答题数据里，「${focus.join('」「')}」这类误读出现得最多，` +
               `请让这个场景正好需要避开它。`);
  }
  parts.push('（这是随机生成的题目，请换一个和常见套路不同的具体情境。）');
  return parts.join('');
}

async function randomStart() {
  const btn = document.getElementById('randBtn');
  const msg = document.getElementById('sceneMsg');
  if (btn) { btn.disabled = true; btn.textContent = '正在随机…'; }
  if (msg) msg.textContent = '正在按你的弱项随机造一个场景…';
  try {
    const sc = await buildScenario(randomPrompt());
    if (btn) { btn.disabled = false; btn.textContent = '随机来一个'; }
    await startSession(sc);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '随机来一个'; }
    if (msg) msg.innerHTML = '<b>没建成：</b>' + esc(e.message || String(e));
  }
}""")

    # ---- 场景生成：要求写清是谁（性别/身份由 her 决定） ----
    s = sub(s, """6. 不要写成「你要如何如何」的教程，只描述场景本身。""",
            """6. 不要写成「你要如何如何」的教程，只描述场景本身。
7. her 里必须写清对方是谁、**是男是女**（年龄/身份/性格/你们的关系）。
   扮演者会照 her 来演，写不清就会演错人。""")

    # ---- 角色提示词：去掉写死的性别 ----
    s = sub(s, """    '你在做一个「语音陪练」：你扮演一位中国女性，用户在练习和她对话。你要演得像个真人，不要像个老师。',
    '',
    '【你的角色】',""", """    // 这里原来写的是「你扮演一位中国女性」。6 个老场景的 her 里都是女性，所以看不出来；
    // 但随机场景会造出男同事、男上级，那时角色的身份和这个写死的性别对不上。
    // 现在性别由 her 决定——role 里不再重复。
    '你在做一个「语音陪练」：你扮演下面这个角色，用户在练习和他/她对话。你要演得像个真人，不要像个老师。',
    '',
    '【你的角色（性别、年龄、身份都在这里面，照它演）】',""")

    with io.open(P, 'w', encoding='utf-8') as f:
        f.write(s)
    print('voice.js：免提 + 随机场景 + 现成场景入口 已就位')


if __name__ == '__main__':
    main()
