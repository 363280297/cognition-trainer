# -*- coding: utf-8 -*-
"""删掉现实任务，并给关卡 4 换一个不依赖它的判据。

用户的原话：「还有限时任务那个，我感觉没必要，直接删掉吧。」
（澄清后确认指的是「现实任务」。）

删掉的东西：
  - stages.json 里的 assignments（7 个任务）
  - app.js 里的 offerAssignment / checkIn / assignmentCard / assignmentPool / followThrough
  - 今天页的现实任务卡、成长页的对账次数与执行率

必须处理的一件事：**关卡 4 的门槛原本就是建立在现实任务上的**
（gate.type = followThrough）。直接删掉会让那一关无法判定（或者永远过不去）。
所以换成一个在 App 内也测得到、而且是真的技能的判据：读局卡那一步
（「这是什么局」）的准确率。理由：做得多不等于判得准，而判局是后面所有动作的前提。

一句必须留下的话：现实任务是这个 App 里**唯一**把练习牵到屏幕外面的东西。
删掉之后，那个位置只剩「今日第三人称复盘」——而迁移研究说得很清楚，
只在抽离场景里练是不泛化的。这一点写进 note 和 boundary，不扩写成说教。
"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, 'data', 'stages.json')


def main():
    with io.open(P, encoding='utf-8') as f:
        d = json.load(f)

    if 'assignments' in d:
        n = len(d.pop('assignments') or [])
        print('删掉 assignments：%d 个任务' % n)

    for s in d['stages']:
        if s['id'] == 4:
            s['capability'] = '你能先看清这是哪种局，再决定出什么牌，而且判得住'
            s['why'] = (
                '知道该怎么做和真的做到之间隔着一道坎，有量化的估计：只加强意图，'
                '行为只移动 d=.36（Webb & Sheeran）。补上 if-then 计划能到 d=.43–.65'
                '（Gollwitzer & Sheeran 2006；Sheeran 等 2024）。'
                '但计划写在那里不等于发生了——所以这一关的判定不是「你写了多少条计划」，'
                '而是**你有没有真的先判局再出牌**：读局卡那一步（这是什么局）答得对不对。'
                '做得多不等于判得准，而判局是后面所有动作的前提。')
            s['gate'] = {'type': 'genreAcc', 'n': 20, 'pct': 70}
            s['gateText'] = '读局卡判局满 20 次，且判局准确率 ≥ 70%'
            s['sub'] = '先看清这是什么局'
        if s['id'] == 5:
            s['gateText'] = '连续 30 天有练习记录'

    # 天花板声明里那句「在任务里的对账」——那个功能没了，话就不能留着
    b = d.get('boundary') or {}
    for k, v in list(b.items()):
        if isinstance(v, str) and '对账' in v:
            b[k] = v.replace('你在屏幕前的选择和你在任务里的对账',
                             '你在屏幕前的选择和你在复盘里写下的东西')
            print('  改 boundary.%s' % k)
        elif isinstance(v, list):
            for i, x in enumerate(v):
                if isinstance(x, str) and '对账' in x:
                    b[i] = x.replace('你在屏幕前的选择和你在任务里的对账',
                                     '你在屏幕前的选择和你在复盘里写下的东西')
                    print('  改 boundary.%s[%d]' % (k, i))

    d['note'] = (d.get('note', '').rstrip() +
                 ' 现实任务于 2.13 版按用户要求删除。它原本是这个 App 里唯一把练习'
                 '牵到屏幕外面的东西——删掉之后，那个位置只剩「今日第三人称复盘」。'
                 '这一点值得记在这儿：迁移研究里，只在抽离场景里练是不泛化的'
                 '（Berler 等 1982），所以要泛化就得靠复盘写真实发生过的事。')

    with io.open(P, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print('stages.json 已更新：关卡 4 -> genreAcc，关卡 5 文案已改')


if __name__ == '__main__':
    main()
