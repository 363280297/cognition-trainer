# -*- coding: utf-8 -*-
"""把内容/AI 文本的 esc() 统一改成 rich()，并修一条写得太脆的断言。

=== 一、真 bug：`**` 会露给用户看 ===

跑测试时随机翻到一张卡，诊断里显示着 `**明确提问**`——两个星号被原样印出来了。
顺着查是所有「用 esc() 渲染的自由文本字段」都有这个毛病，而且是**选择性**的：

    app.js:1098   esc(picked.why)      ← 你选错那条的解释：星号露出来
    app.js:1108   rich(correctOpt.why) ← 正确那条的解释：星号变粗体
    app.js:1095   esc(picked.text)
    app.js:1557   esc(r.face_value)    ← 同一张卡上面一行是 rich(r.quote)

也就是说**同一张卡里两行一个对一个错**，说明这不是有意的规则，是漏改。
最讽刺的是出问题的恰好是「你选错的那条为什么错」——用户最需要看的那段。

`rich()` 就是 `esc()` 加一次安全的 `**`→`<b>`（先转义再替换，不可能引入 XSS），
所以用它**永远不会比 esc() 差**。于是统一改成 rich()：
一条规则（内容文本一律走 rich）比逐个字段判断可靠得多，
而逐个判断正是当初漏掉的原因。

=== 二、测试写脆了：刷卡片页那条断言 ===

「刷卡片页是题目 + 选项」原来数正文里 A/B/C/D 开头的选项，要求 ≥3 个。
但**卡片是随机抽的**，而带判局（genre）的卡片会故意把四个选项先藏起来
（那正是这个 App 的核心设计：先判断这是什么局，再选动作）。
所以抽到判局卡时这条必然失败——`check_tabs_unique` 因此时好时坏。

改成直接问 DOM：判局步骤或选项区在不在。
顺便把设计不变式也断言上：**判局在的时候选项必须是藏起来的**。
这比数文字可靠，而且测的是真正重要的那条规则（而不是一句文案恰好长什么样）。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


# 自由文本字段：esc( 改成 rich(
AP_PAIRS = [
    ("${esc(picked.text || '')}", "${rich(picked.text || '')}"),
    ("${esc(picked.why || '')}", "${rich(picked.why || '')}"),
    ("${esc(o.why || '')}", "${rich(o.why || '')}"),
    ("${esc(cfg.why || '')}", "${rich(cfg.why || '')}"),
    ("${esc(idn.why_this_form)}", "${rich(idn.why_this_form)}"),
    ("${esc(idn.why_evidence)}", "${rich(idn.why_evidence)}"),
    ("${esc(idn.rule)}", "${rich(idn.rule)}"),
    ("${esc(r.face_value)}", "${rich(r.face_value)}"),
    ("${esc(r.possible)}", "${rich(r.possible)}"),
    ("${esc(r.signals)}", "${rich(r.signals)}"),
    ("${esc(replay.summary)}", "${rich(replay.summary)}"),
    ("${esc(replay.note)}", "${rich(replay.note)}"),
    ("${esc(sig.problem)}", "${rich(sig.problem)}"),
    ("${esc(res.why_greasy)}", "${rich(res.why_greasy)}"),
]

VOICE_PAIRS = [
    ("${esc(o.inner || '')}", "${rich(o.inner || '')}"),
    ("${esc(o.rating_why || '')}", "${rich(o.rating_why || '')}"),
    ("${esc(worst.inner || '')}", "${rich(worst.inner || '')}"),
    ("${esc(worst.rating_why || '')}", "${rich(worst.rating_why || '')}"),
    ("${esc(n.note)}", "${rich(n.note)}"),
]


def main():
    for fname, pairs in [('public/app.js', AP_PAIRS), ('public/voice.js', VOICE_PAIRS)]:
        p = os.path.join(ROOT, fname)
        s = io.open(p, encoding='utf-8').read()
        done = 0
        for old, new in pairs:
            n = s.count(old)
            if n == 0:
                print(f'  跳过（没这处，可能已改过）：{fname} {old[:46]}')
                continue
            s = s.replace(old, new)
            done += n
        io.open(p, 'w', encoding='utf-8').write(s)
        print(f'  {fname}：{done} 处改成 rich()')

    # 断言：内容字段不再用 esc 渲染
    a = io.open(os.path.join(ROOT, 'public/app.js'), encoding='utf-8').read()
    for field in ['picked.why', 'picked.text', 'o.why', 'idn.rule', 'r.face_value', 'r.possible']:
        assert f'esc({field}' not in a, f'{field} 还在用 esc'
    v = io.open(os.path.join(ROOT, 'public/voice.js'), encoding='utf-8').read()
    for field in ['o.inner', 'o.rating_why', 'worst.inner']:
        assert f'esc({field}' not in v, f'{field} 还在用 esc'

    # ---------------- 修那条脆断言 ----------------
    TP = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')
    t = io.open(TP, encoding='utf-8').read()
    t = sub(t, """  // 题面措辞随卡片类型变（「这是什么局？」「这句话是什么？」「下一步最该做什么？」），
  // 所以不能认死一句话。改成数选项：3 个以上 A/B/C/D 开头的选项就是题目页，
  // 这才是「题目页」那个不随内容变的不变特征。
  const drill = pick('practice/卡片');
  const optCount = (drill.sig || '').match(/[ABCD][\\u4e00-\\u9fa5]/g) || [];
  chk('刷卡片页是题目 + 选项（不是画像页也不是预案页）',
    optCount.length >= 3 && !/偏差画像|还没有预案/.test(drill.sig || ''),
    `选项 ${optCount.length} 个`);""",
            """  /* 刷卡片页必须问 DOM，不能数文字。
   *
   * 原来数正文里 A/B/C/D 开头的选项（要求 ≥3 个）。但**卡片是随机抽的**，
   * 而带判局的卡片会故意先把四个选项藏起来——先判断「这是什么局」再选动作，
   * 这正是这个 App 的核心设计。所以抽到判局卡时那条断言必然失败，
   * 于是 check_tabs_unique 时好时坏。
   * 改成直接问 DOM，并把设计不变式也一起断言上：判局在时选项必须藏着。 */
  const drillDom = await p.evaluate(() => {
    const opts = document.getElementById('opts');
    return {
      hasGenre: !!document.getElementById('genreStep'),
      hasOpts: !!opts,
      optsVisible: !!(opts && opts.getBoundingClientRect().height > 0),
      cardsView,
    };
  });
  chk('刷卡片页是题目页（判局步骤或选项区在）',
    (drillDom.hasGenre || drillDom.hasOpts) && drillDom.cardsView === 'drill',
    JSON.stringify(drillDom));
  chk('判局在的时候选项是藏起来的（这是设计，不是 bug）',
    !drillDom.hasGenre || !drillDom.optsVisible,
    `判局=${drillDom.hasGenre} 选项可见=${drillDom.optsVisible}`);""", tag='drill')
    io.open(TP, 'w', encoding='utf-8').write(t)
    print('断言改成问 DOM，并加上「判局时选项必须藏着」')


if __name__ == '__main__':
    main()
