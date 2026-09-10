# -*- coding: utf-8 -*-
"""修用户报的两个 bug，外加诊断时暴露的两个健壮性问题。

用户报的：
  「偶尔 ai 界面还是会显示练习界面的内容」
  「AI 界面，我点了开始说，他没有用。然后我打字说出了，然后显示模型返回内容为空」

=== 一、「点了 AI 却看到别的页面」

诊断的结论是：**子页状态是全局的、跨 tab 保留的**。
`cardsView` / `practiceSubview` / `aiSubview` / `growthSubview` 都是模块级变量，
切走再切回来会保留上一次的位置。所以：

  · 去过「成长 → 我的预案」之后 `cardsView='plans'`，
    再点「练习」tab（practiceSubview 还是 'cards'），`viewCards()` 会去渲染预案页
  · 去过「AI → 真实复盘」之后点 AI tab，看到的是复盘，不是场景对话

前一条是**内容跑到别的 tab 下面**（真串台），后一条是**停在非默认子页**
（用户会觉得「今天没见过的 AI 界面」，也就是他说的「偶尔还有练习界面的内容」）。

修法：**点底部 tab 时把它重置到默认子页**。这是主流 App 的做法，
而且它把「子页状态属于谁」这件事说清楚了——属于这一次浏览，不属于整个 App。
点进来永远看到那一路的第一个页面，想深入再用页内的二级切换。

顺带修 `answerCard`：答题时如果页面已经被切走，它会写进不存在的节点并抛异常
（诊断里抓到的 `Cannot set properties of null`）。改成先确认元素在，不在就安静退出。

=== 二、「点了开始说没用」

`micTap()` → `autoListen()`，而 `autoListen` 在三种情况下**直接 return，一个字都不说**：
  · 没有原生桥（`!V.native`）
  · 这台手机没有语音识别（`!V.caps.asr`）
  · `V.ended`（这一局已结束）
点了没反应、又不报错，是比报错更糟的体验——用户只能反复点。
现在每一种都给出原因，并指出「下面可以直接打字」这条退路。

=== 三、「模型返回内容为空」

`llmCall` 里那句 `if (!content.trim()) throw new Error('模型返回了空内容，再试一次')`
**只说了一半**：它没说为什么、也没说怎么办，而且把服务端返回的原文丢掉了。
带推理的模型最容易出这种情况——推理 token 和正文共用 max_tokens，
额度被推理吃光时 content 就是空的（`reasoning_content` 反而是满的）。
所以现在：
  · 把原始返回（截断）一起报出来，便于判断到底发生了什么
  · 如果 `reasoning_content` 非空而 content 为空，直接指出「这是带推理的模型，
    额度被推理吃光了」，并给出该换成哪个模型
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = os.path.join(ROOT, 'public', 'app.js')
VP = os.path.join(ROOT, 'public', 'voice.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    a = io.open(AP, encoding='utf-8').read()

    # ---------------- 1) 点 tab 重置子页 ----------------
    a = sub(a, """function go(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0 });
  VIEWS[tab]();
  injectSubnav(tab);   // 二级切换条统一在这里加，渲染函数不用各自关心
}""",
            """/* 每一路 tab 的默认子页。点底部 tab 时回到这里。
 *
 * 为什么必须重置：四个子页状态（practiceSubview / aiSubview / growthSubview /
 * cardsView）都是模块级变量，**切走再切回来会保留上次的位置**。于是出现过
 * 「去过成长→我的预案，再点练习，练习下面渲染出的是预案页」这种串台，
 * 以及「点 AI 看到的不是场景对话」这种困惑。
 *
 * 让子页状态属于「这一次浏览」而不是「整个 App」，行为就唯一了：
 * 点进来永远是这一路的第一个页面，想深入用页内的二级切换。
 * 需要「回到我刚才那页」的场景本来就不存在——四个 tab 的内容各自独立。 */
const TAB_HOME = {
  today: null,          // 今天页没有二级子页
  practice: 'cards',
  ai: 'voice',
  growth: 'stages',
};

function go(tab) {
  currentTab = tab;
  const home = TAB_HOME[tab];
  if (home) {
    if (tab === 'practice') { practiceSubview = home; cardsView = 'drill'; }
    else if (tab === 'ai') { aiSubview = home; }
    else if (tab === 'growth') { growthSubview = home; }
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0 });
  VIEWS[tab]();
  injectSubnav(tab);   // 二级切换条统一在这里加，渲染函数不用各自关心
}""", tag='go')

    # ---------------- 2) answerCard 别炸 ----------------
    a = sub(a, """function answerCard(chosen) {
  clearCardTimer();
  const card = session.queue[session.i];""",
            """function answerCard(chosen) {
  clearCardTimer();
  /* 页面可能已经被切走了。这道题本来是「用户点了选项之后又立刻切 tab」：
     下面的代码会去写 #opts / #fb，那些节点已经不在，于是抛
     `Cannot set properties of null (setting 'innerHTML')`——
     一个用户看不见、但会打断当前页面的未捕获异常。 */
  if (!document.getElementById('opts')) return;
  const card = session.queue[session.i];
  if (!card) return;""", tag='answerCard')
    io.open(AP, 'w', encoding='utf-8').write(a)

    # ---------------- 3) micTap 不许静默 ----------------
    v = io.open(VP, encoding='utf-8').read()
    v = sub(v, """function micTap() {
  if (!V.sess || V.ended) return;
  if (V.phase === 'speaking') { stopSpeak(); maybeAutoListen(); return; }   // 打断她
  if (V.phase === 'listening') { stopListen(); return; }                   // 说完了 → 系统会把结果发回来
  if (V.busy || V.phase === 'thinking') return;
  autoListen();
}""",
            """function micTap() {
  /* 这里原来在四种情况下 `return` 得干干净净——**一个字都不说**。
     点了没反应又不报错，比报错更糟：用户只能反复点，也不知道该换什么办法。
     所以每一种「不能开始听」的原因都要讲出来，并指向打字那条退路。 */
  const say = (t) => { renderTurnHint(t); toast(t); };
  if (!V.sess) { say('先开始一局再说话。'); return; }
  if (V.ended) { say('这一局已经结束了，回上面重新开一局。'); return; }
  if (V.phase === 'speaking') { stopSpeak(); maybeAutoListen(); return; }   // 打断她
  if (V.phase === 'listening') { stopListen(); return; }                   // 说完了 → 系统会把结果发回来
  if (V.busy || V.phase === 'thinking') return;                            // 她在想，稍等
  if (!V.native || !V.caps.asr) {
    say('这台手机没有可用的语音识别引擎，用下面的输入框打字吧。');
    return;
  }
  if (V.caps.mic === false) {
    say('麦克风权限没给。可以在系统的应用设置里打开，或者直接用下面打字。');
    return;
  }
  autoListen();
}""", tag='micTap')

    # ---------------- 4) 空内容要说清楚 ----------------
    v = sub(v, """  if (!String(content).trim()) throw new Error('模型返回了空内容，再试一次');""",
            """  /* content 为空时只说「再试一次」是不够的：用户既不知道原因，也不知道要不要改什么。
   *
   * 最常见的原因是**带推理的模型把 max_tokens 吃光了**——推理 token 和正文
   * 共用这个额度，推理写满时 content 就是空的，而 reasoning_content 是满的。
   * 所以这里把原始返回带上，并在能判断时直接给出该怎么做。 */
  if (!String(content).trim()) {
    const reason = (ch0 && ch0.message && ch0.message.reasoning_content) || '';
    const head = String(res.body || '').slice(0, 200);
    if (reason) {
      throw new Error('模型只返回了推理、没有正文——多半是带推理的模型把 '
        + (budget || s.maxTokens) + ' 的额度用光了。'
        + '换 ' + MODEL_FAST + ' 这类不带推理的模型通常就好了（设置页可以换）。\\n'
        + '服务端返回：' + head);
    }
    throw new Error('模型返回了空内容。'
      + '再试一次；如果一直这样，检查一下设置里的模型名。\\n服务端返回：' + head);
  }""", tag='empty')
    io.open(VP, 'w', encoding='utf-8').write(v)
    print('四件事都改了：点 tab 重置子页、answerCard 不炸、micTap 不再静默、空返回说清楚')


if __name__ == '__main__':
    main()
