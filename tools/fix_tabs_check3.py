# -*- coding: utf-8 -*-
"""用 checkVisibility() 判「收起来了」。

探到的事实（tools/diag_details.js 的输出）：
  insideDetails=true, detailsOpen=false, rect=345x49, clientRects=1,
  checkVisibility({checkVisibilityCSS:true}) = false

也就是说：收起的 `<details>` 里的元素**仍然有布局盒子**，
`getBoundingClientRect()` / `getClientRects()` 都会报出尺寸，
只有 `checkVisibility()` 说它没渲染。

原因：新 Chromium 用 `content-visibility: hidden` 实现收起的 details，
而 content-visibility 影响的是绘制，不影响布局盒子的存在。
所以量「有没有显示出来」这件事，`checkVisibility()` 才是对的 API。

**结论：折叠功能本身是对的**（用户看到的确实是收起的），
前面两条失败都是我在用错的方法量。这一条值得记下来——
如果当时偷懒把断言删掉，就会既不知道自己错了、也不知道功能其实没问题。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TP = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    s = io.open(TP, encoding='utf-8').read()

    s = sub(s, """      // 判「收起来了」不能用 offsetParent：新的 Chromium 用 content-visibility: hidden
      // 实现收起的 <details>，这时元素仍然有 offsetParent。
      // 用 getClientRects()（没渲染出来就没有矩形）才准。
      hiddenRects: (add && add.getClientRects().length) || 0,""",
            """      // 判「收起来了」只有 checkVisibility() 准。
      // 收起的 <details> 用的是 content-visibility: hidden——它影响绘制、
      // 不影响布局盒子，所以 offsetParent 和 getClientRects() 都照样报值
      // （实测：收起的输入框 rect 是 345x49、clientRects 是 1）。
      visible: add && add.checkVisibility
        ? add.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        : null,""", tag='visible')

    s = sub(s, """  // 自验证：把折叠展开，必须量得到。
  // 如果展开后也是 0，那说明方子错了（而不是功能对了）——这条能挡住「测试永远绿」。
  const openedRects = await p.evaluate(() => {
    const d = document.querySelector('details.diag-more');
    d.open = true;
    return document.getElementById('addPkg').getClientRects().length;
  });
  chk('展开折叠后输入框量得到（说明判隐藏的方法本身是对的）', openedRects > 0, `${openedRects} 个矩形`);""",
            """  // 自验证：展开之后必须判为可见。
  // 如果收起和展开都判 false，那是方法坏了、而不是功能对了——这条挡住假绿灯。
  const openedVisible = await p.evaluate(() => {
    const d = document.querySelector('details.diag-more');
    d.open = true;
    const add = document.getElementById('addPkg');
    return add.checkVisibility ? add.checkVisibility({ checkVisibilityCSS: true }) : null;
  });
  chk('展开折叠后判为可见（说明判可见性的方法本身是对的）',
    openedVisible === true, String(openedVisible));""", tag='selfcheck')

    s = sub(s, """  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && gateUi.hiddenRects === 0 && !gateUi.detailsOpen,
    `有折叠=${gateUi.manualFolded} 收起时矩形=${gateUi.hiddenRects} 已展开=${gateUi.detailsOpen}`);""",
            """  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && gateUi.visible === false && !gateUi.detailsOpen,
    `有折叠=${gateUi.manualFolded} 收起时可见=${gateUi.visible} 已展开=${gateUi.detailsOpen}`);""",
            tag='chk')

    io.open(TP, 'w', encoding='utf-8').write(s)
    print('改用 checkVisibility 判可见性')


if __name__ == '__main__':
    main()
