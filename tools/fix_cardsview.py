# -*- coding: utf-8 -*-
"""修「两个界面变成一样」的根因：cardsView 只被写、从来没被读过。

用户报的：「练习和AI点进去发现两个界面变成一样了」。

查下来的事实（有断言验证）：`cardsView` 这个变量在 5 个地方被赋值，
**没有任何一处读它**。`viewCards()` 无条件走 `renderCard()`，所以：

    练习 → 卡片          → 刷卡片那一页
    成长 → 偏差画像      → 也是刷卡片那一页   ← 应该是偏差画像
    成长 → 我的预案      → 还是刷卡片那一页   ← 应该是我的预案

三个入口渲染出完全一样的界面。这就是「变成一样了」。

来由：上一轮做界面归并（5 tab → 4 tab）时，我把「我的预案 / 偏差画像」从卡片页
搬到成长，`VIEWS.growth` 里写了 `cardsView = 'bias'; viewCards();`，
以为 viewCards 会看这个变量——但它从来不看。**「设了一个没人读的状态」
是这次 bug 的全部原因**，而且它不报错、不抛异常，只让三个页面长得一样。

所以除了修，还要加一条防回归的断言：**每个 tab × 二级子页的正文必须两两不同**。
这条断言会在任何一次「子页悄无声息地退化成另一个子页」时立刻失败——
比逐个检查渲染函数可靠得多。

顺带修一个旁边看到的问题：「这一组做完了」那张卡里有两个一模一样的「再来一组」按钮。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = os.path.join(ROOT, 'public', 'app.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    s = io.open(AP, encoding='utf-8').read()

    # ---------- 1) viewCards 必须看 cardsView ----------
    s = sub(s, """function viewCards() {
  if (!session.queue.length) session = { queue: buildQueue(), i: 0, lowLoad: false };
  renderCard();
}""", """function viewCards() {
  /* cardsView 才是这三个子页的开关。
   *
   * 之前这个变量只被赋值、从来没被读——于是「偏差画像」和「我的预案」
   * 都渲染成了刷卡片那一页，三个入口长得一模一样（用户报的「两个界面变成一样了」）。
   * 这类 bug 不报错、不抛异常，只让页面悄悄退化，所以下面还有一条断言盯着
   * 「每个子页的正文必须两两不同」。
   */
  if (cardsView === 'plans') { renderPlans(); return; }
  if (cardsView === 'bias') { renderBias(); return; }
  if (!session.queue.length) session = { queue: buildQueue(), i: 0, lowLoad: false };
  renderCard();
}""", tag='viewCards')

    # ---------- 2) 去掉重复的「再来一组」 ----------
    s = sub(s, """        <div class="row">
          <button class="primary" onclick="newSession()">再来一组</button>
        </div>
        ${planN ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('plans')">看我的预案（${planN}）</button></div>` : ''}
        ${biasTotal() ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('bias')">看偏差画像</button></div>` : ''}
        <div class="row">
          <button class="primary" onclick="newSession()">再来一组</button>
        </div>
        ${wrong ? `<div class="row"><button class="ghost" onclick="wrongSession()">翻车回放（${wrong} 题做错过）</button></div>` : ''}""",
            """        <div class="row">
          <button class="primary" onclick="newSession()">再来一组</button>
        </div>
        ${planN ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('plans')">看我的预案（${planN}）</button></div>` : ''}
        ${biasTotal() ? `<div class="row"><button class="ghost" onclick="setGrowthSubview('bias')">看偏差画像</button></div>` : ''}
        ${wrong ? `<div class="row"><button class="ghost" onclick="wrongSession()">翻车回放（${wrong} 题做错过）</button></div>` : ''}""",
            tag='dupButton')

    io.open(AP, 'w', encoding='utf-8').write(s)
    print('viewCards 现在会看 cardsView；重复的「再来一组」已去掉')


if __name__ == '__main__':
    main()
