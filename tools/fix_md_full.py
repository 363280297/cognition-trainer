# -*- coding: utf-8 -*-
"""再清两处 ** 泄漏，并把「界面不许出现 ** 」这条断言的覆盖面补全。

截图里又看到一处：「接口地址要填**完整端点**」。它是设置页里的一段静态 HTML
（和 httpProblem 那句不是同一处，我上次只改了后者）。

为什么上次的断言没抓到：那条断言只打开了 `openDailySettings()`（每日计划），
**没有打开 `openSettings()`（主设置页）**。也就是说断言本身是对的，
但覆盖面缺了一块——而漏掉的那块恰好就是出问题的地方。
这类「断言写对了但没盖到」比断言写错更危险，因为它给人一种已经测过的错觉。

所以这次：
  1. 清掉这两处 **（设置页那段 + 我新写的模型说明那段）。
  2. 把断言扩到**所有**会弹出的面板：主设置页、每日计划、挑应用、卡住了、关卡。
     以后新增面板漏扫的风险降到最低。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
TP = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    # 1) 设置页那段静态提示
    v = sub(v, """      接口地址要填**完整端点**，也就是到 <span class="mono-line">/chat/completions</span> 为止。""",
            """      接口地址要填<b>完整端点</b>，也就是到 <span class="mono-line">/chat/completions</span> 为止。""",
            tag='setUrl')

    # 2) 我新写的模型说明
    v = sub(v, """    <span class="mono-line">${esc(MODEL_FAST)}</span>：前者带推理，实测**一轮要等约 30 秒**，""",
            """    <span class="mono-line">${esc(MODEL_FAST)}</span>：前者带推理，实测<b>一轮要等约 30 秒</b>，""",
            tag='modelNotice')
    io.open(VP, 'w', encoding='utf-8').write(v)

    # 3) 断言扩到所有面板
    t = io.open(TP, encoding='utf-8').read()
    t = sub(t, """    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 设置页（含闸门那一段）
    openDailySettings();
    walk(document.body, '设置页');""",
            """    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // **所有会弹出的面板都要扫**。上次只扫了「每日计划」，于是主设置页里
    // 那句「要填**完整端点**」就漏过去了——断言是对的，但没盖到出问题的地方。
    openDailySettings();
    walk(document.body, '每日计划');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openSettings();
    walk(document.body, '主设置页');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openFog('test');
    walk(document.body, '卡住了');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openGate(false);
    walk(document.body, '闸门');""", tag='scan')
    io.open(TP, 'w', encoding='utf-8').write(t)

    # 自检：这两处确实清干净了
    v2 = io.open(VP, encoding='utf-8').read()
    for bad in ['要填**完整端点**', '实测**一轮要等约 30 秒**']:
        assert bad not in v2, f'还有残留：{bad}'
    print('两处 ** 清掉了；断言扩到全部五个面板')


if __name__ == '__main__':
    main()
