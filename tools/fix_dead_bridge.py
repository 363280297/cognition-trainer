# -*- coding: utf-8 -*-
"""把「原生有能力但界面碰不到」这件事从提示升级成硬失败，并顺手接上三个漏掉的入口。

起因：用户问「他是不是应该会有语音包那种的？」——查下来 Java 里 `voices()`
早就写好了，**但网页侧一次都没调用过**。所以那功能一直等于不存在。

而 `tools/test_bridge.js` 里**早就有**这条检查（「Bridge 里暴露了但网页从不调用的
方法」），只是当时被写成**软提示**，理由是：

    「死方法不会导致功能坏掉，而把提示做成硬失败会让人习惯性忽略输出。」

这个理由现在被事实否掉了：死方法确实「不会让功能坏掉」，但它会让**功能不存在**——
用户要的语音包就是被它吃掉的。软提示在这件事上等于没有。

所以改成硬失败，同时留一份**写明原因的**白名单：
死代码不该被无声无息地放过，但也不该逼着人去删掉可能有意的预留。
白名单里每一条都要写「为什么保留」，读的人才能判断。

顺带把三个**我自己新加却没人调用**的方法接上（正好被这条新断言抓出来）：
  · currentVoice()    → 设置页显示「当前实际生效的音色」，
                        用来防止「选了但没生效」这种看不出来的失败
  · openTtsSettings() → 一个「打开系统语音设置」的按钮（换引擎、下语音包都在那里）
  · installVoiceData() 已经在用
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    # ---------- 1) 网页侧：接上 currentVoice 和 openTtsSettings ----------
    VP = os.path.join(ROOT, 'public', 'voice.js')
    v = io.open(VP, encoding='utf-8').read()

    v = sub(v, """      <div class="row row-2">
        <button class="ghost" onclick="loadVoices(true)">重新读取</button>
        <button class="ghost" onclick="EQNative && EQNative.installVoiceData && EQNative.installVoiceData()">去系统里下载音色</button>
      </div>""",
            """      <div class="row row-2">
        <button class="ghost" onclick="loadVoices(true)">重新读取</button>
        <button class="ghost" onclick="downloadVoices()">去系统里下载音色</button>
      </div>
      <div class="row row-2">
        <button class="ghost" onclick="openSystemTts()">打开系统语音设置</button>
      </div>
      <p class="hint" id="voiceNow" style="margin:8px 0 0"></p>""", tag='voiceButtons')

    v = sub(v, """  modelHint();
  asrHint();
  loadVoices();
}""",
            """  modelHint();
  asrHint();
  loadVoices();
}

/** 去系统里下载音色。有的引擎没有这个入口，那就退回系统语音设置。 */
function downloadVoices() {
  if (V.native && V.native.installVoiceData) { V.native.installVoiceData(); return; }
  openSystemTts();
}

/** 打开系统的文字转语音设置。换引擎、管理语音包都在那里——
 *  音色列表为空、或者想要列表里没有的嗓子，这条路是唯一出口。 */
function openSystemTts() {
  if (V.native && V.native.openTtsSettings) { V.native.openTtsSettings(); return; }
  toast('这个功能只在 Android App 里可用');
}

/** 显示**实际生效**的音色。
 *
 * 为什么需要：用户选了音色之后，如果引擎没有这个音色、或者选中的还没下载，
 * 声音会静默退回默认——界面上「已选」打着勾，听起来却是另一个嗓子。
 * 把原生当前真实用的那个名字显示出来，这种不一致就看得见了。
 * 这也是「原生有能力但界面碰不到」那一类问题的解药：让状态可见。 */
function showCurrentVoice() {
  const el = document.getElementById('voiceNow');
  if (!el) return;
  if (!V.native || !V.native.currentVoice) { el.textContent = ''; return; }
  let real = '';
  try { real = V.native.currentVoice() || ''; } catch (e) { real = ''; }
  const want = settings().voice || '';
  if (!real) { el.textContent = '这台手机没有报告正在使用的音色。'; return; }
  if (want && want !== real) {
    el.innerHTML = `<b>注意：设置里选的是 ${esc(want)}，实际生效的是 ${esc(real)}</b>`
      + '——多半是这个音色没下载、或者被引擎忽略了。可以先试听一下确认。';
  } else {
    el.textContent = '当前实际生效的音色：' + real + '（自动 = 系统默认那个）';
  }
}""", tag='currentVoice')

    # 锚点不要跨那条长长的破折号分隔线：星号数量对不上就会 0 命中，
    # 而这里又不是那条线的内容。用 modelHint 那一段当锚点，唯一且短。
    v = sub(v, """  modelHint();
  asrHint();
  loadVoices();
}""",
            """  modelHint();
  asrHint();
  loadVoices();
  showCurrentVoice();
}""", tag='callCurrent')

    # 选完音色之后也刷新一下「实际生效」
    v = sub(v, """  VOICE_LIST = VOICE_LIST || [];
  renderVoices();
  const v = (VOICE_LIST || []).find((x) => x.name === name);""",
            """  VOICE_LIST = VOICE_LIST || [];
  renderVoices();
  // 切过去是异步的，稍等一下再读「实际生效」，否则读到的还是切换前的值
  setTimeout(showCurrentVoice, 300);
  const v = (VOICE_LIST || []).find((x) => x.name === name);""", tag='refreshNow')
    io.open(VP, 'w', encoding='utf-8').write(v)

    # ---------- 2) test_bridge：软提示改成硬失败 + 白名单 ----------
    TP = os.path.join(ROOT, 'tools', 'test_bridge.js')
    t = io.open(TP, encoding='utf-8').read()

    t = sub(t, """/* ---------- 6) 反向检查：Bridge 里暴露了但网页从不调用的一般是死代码 ---------- */
const unused = [...exposed].filter((m) => !called.has(m));
// 这条只是卫生提示，不判失败：死方法不会导致功能坏掉，
// 而把提示做成硬失败会让人习惯性忽略输出。真正会导致线上炸的是上面那条。
console.log(`  提示  Bridge 里网页没调用的方法（可清理，不影响功能）：${unused.length ? unused.join(', ') : '无'}`);""",
            """/* ---------- 6) 反向检查：Bridge 里暴露了但网页从不调用的，判失败 ----------
 *
 * 这一条原来只是**软提示**，理由是「死方法不会导致功能坏掉」。
 * 那个理由被事实否掉了：用户问「是不是应该有语音包那种的」——
 * 查下来 Java 里的 voices() 早就写好了，**而网页侧一次都没调用过**，
 * 所以那功能一直等于不存在。死方法确实不会让功能坏掉，它会让功能不存在。
 *
 * 所以改成硬失败。白名单里每一条都写明「为什么保留」——
 * 读的人要能自己判断该不该删，而不是看到一堆名字就跳过。 */
const KNOWN_UNUSED = {
  httpGet: '和 httpPost 成对留着的取数入口，目前只有一个调用点用 POST。'
    + '删掉它会让「取数」这条路整个消失，而它已经过桥的静态检查、没有维护成本。',
  deepBlockStatus: '深度拦截的状态查询。现在设置页是靠 probeRoot + 存下来的开关自己算的，'
    + '所以这个查询没被用上；但它是「显示真实状态」的正式入口，'
    + '以后要让设置页显示原生侧真实状态时会用到（这一版的 currentVoice 正是同类补课）。',
  openAppSettings: '跳到本应用的系统设置页。目前没有入口调用它——'
    + '如果以后要引导用户去开权限，这是标准的落点。',
};
const unused = [...exposed].filter((m) => !called.has(m));
const unexpected = unused.filter((m) => !KNOWN_UNUSED[m]);
t('Bridge 里没有「网页永远碰不到」的方法（死能力等于功能不存在）',
  unexpected.length === 0,
  unexpected.length
    ? `没人调用：${unexpected.join(', ')}  ← 要么给它一个入口，要么写明为什么保留`
    : (unused.length ? `只有白名单里这几个：${unused.join(', ')}` : '全部有调用点'));
for (const m of unused) {
  if (KNOWN_UNUSED[m]) console.log(`    白名单  ${m}：${KNOWN_UNUSED[m].slice(0, 46)}…`);
}""", tag='unusedHard')
    io.open(TP, 'w', encoding='utf-8').write(t)
    print('接上 currentVoice / openTtsSettings；「碰不到的原生能力」改成硬失败')


if __name__ == '__main__':
    main()
