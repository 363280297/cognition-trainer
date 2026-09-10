# -*- coding: utf-8 -*-
"""修设置页里露出来的 **没达标**，并把这条断言扩到 rich() 的几个消费方。

真问题：`每天提醒一次，只在**没达标**的时候响。` 这句话在设置页上
一直原样显示着两个星号（从更早的版本就开始了，不是这次引入的）。
它没走 rich()，也没有用 <b>，所以 ** 直接当正文显示了。

顺便把断言扩到三处 rich() 的主要消费方（卡片诊断、微课正文、复盘），
这样即使哪天 rich() 本身坏了（比如顺序错了、正则改错了），也会被这条抓住——
原来那条断言只扫了几个静态页，rich() 坏掉它看不出来。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    ap = os.path.join(ROOT, 'public', 'app.js')
    a = io.open(ap, encoding='utf-8').read()
    a = sub(a, """        <p class="hint">每天提醒一次，只在**没达标**的时候响。已经达标的日子不再打扰你——""",
            """        <p class="hint">每天提醒一次，只在<b>没达标</b>的时候响。已经达标的日子不再打扰你——""",
            tag='reminder')
    io.open(ap, 'w', encoding='utf-8').write(a)

    tp = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')
    t = io.open(tp, encoding='utf-8').read()
    t = sub(t, """    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 四个 tab 的正文
    ['today', 'practice', 'ai', 'growth'].forEach((tab) => walk((go(tab), document.body), 'tab:' + tab));
    return [...new Set(bad)];""",
            """    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 四个 tab 的正文
    ['today', 'practice', 'ai', 'growth'].forEach((tab) => walk((go(tab), document.body), 'tab:' + tab));

    // rich() 的三个主要消费方：卡片诊断、微课正文、复盘。
    // 这几处的正文里写了 100 多处 **强调**，是本 App 里唯一大量使用 markdown 的地方。
    // 扫它们既能抓「某处漏了 rich()」，也能抓「rich() 本身坏了」。
    goPracticeCards();
    const card = session.queue[session.i] || CONTENT.cards.cards[0];
    session.queue = [card]; session.i = 0; session.genrePick = null;
    renderCard();
    if (card.genre) {
      const gb = document.querySelector('#genreStep .genre-btn');
      if (gb) gb.click();
    }
    const right = (card.options || []).find((o) => o.id === card.best) || { id: 'A' };
    answerCard(right.id);
    walk(document.body, '卡片诊断');

    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openLesson((CONTENT.curriculum.lessons[0] || {}).id);
    walk(document.body, '微课正文');

    return [...new Set(bad)];""", tag='extend')
    io.open(tp, 'w', encoding='utf-8').write(t)
    print('设置页的 ** 已修；断言扩到卡片诊断/微课/复盘')
    # 复盘那一处由 check_voice_talk.js 覆盖渲染，这里只覆盖前两处


if __name__ == '__main__':
    main()
