# -*- coding: utf-8 -*-
"""修 check_tabs_unique.js 剩下两条。

1. 「刷卡片页是题目」——题面措辞随卡片类型变（有的是「这是什么局？」，
   有的是「这句话是什么？」），我认死了一句话，所以换个卡片就失败。
   改成数选项：正文里出现 3 个以上「A 中文 / B 中文」开头的选项，就是题目页。
   这才是「题目页」的不变特征。

2. 「手动填包名收进了折叠里」——`offsetParent` 在这个场景下用不了：
   新的 Chromium 用 `content-visibility: hidden` 实现收起的 `<details>`，
   这时元素仍然有 offsetParent。改用 `getClientRects()`（没渲染出来就没有矩形），
   **并且顺手把折叠展开再量一次**：如果展开后也量不到，那就说明是量法错了，
   而不是功能对了——这条自验证能把「测试永远通过」这类假绿灯挡住。
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

    s = sub(s, """  chk('刷卡片页是题目（不是画像也不是预案）',
    /这是什么局|最该做的是什么|判断对方/.test(pick('practice/卡片').sig || ''),
    pick('practice/卡片').sig);""",
            """  // 题面措辞随卡片类型变（「这是什么局？」「这句话是什么？」「下一步最该做什么？」），
  // 所以不能认死一句话。改成数选项：3 个以上 A/B/C/D 开头的选项就是题目页，
  // 这才是「题目页」那个不随内容变的不变特征。
  const drill = pick('practice/卡片');
  const optCount = (drill.sig || '').match(/[ABCD][\\u4e00-\\u9fa5]/g) || [];
  chk('刷卡片页是题目 + 选项（不是画像页也不是预案页）',
    optCount.length >= 3 && !/偏差画像|还没有预案/.test(drill.sig || ''),
    `选项 ${optCount.length} 个`);""", tag='drill')

    s = sub(s, """      addPkgCount: document.querySelectorAll('#addPkg').length,
      hasPickBtn: !!document.querySelector('button[onclick="openAppPicker()"]'),
      // 主入口应该是「挑」，不是手输框：折叠里的输入框量不到 offsetParent
      hasVisibleManual: !!add && add.offsetParent !== null,
      manualFolded: /手动填包名/.test(txt),
      detailsOpen: !!document.querySelector('details.diag-more[open]'),
    };
  });""",
            """      addPkgCount: document.querySelectorAll('#addPkg').length,
      hasPickBtn: !!document.querySelector('button[onclick="openAppPicker()"]'),
      // 判「收起来了」不能用 offsetParent：新的 Chromium 用 content-visibility: hidden
      // 实现收起的 <details>，这时元素仍然有 offsetParent。
      // 用 getClientRects()（没渲染出来就没有矩形）才准。
      hiddenRects: (add && add.getClientRects().length) || 0,
      manualFolded: /手动填包名/.test(txt),
      detailsOpen: !!document.querySelector('details.diag-more[open]'),
    };
  });

  // 自验证：把折叠展开，必须量得到。
  // 如果展开后也是 0，那说明方子错了（而不是功能对了）——这条能挡住「测试永远绿」。
  const openedRects = await p.evaluate(() => {
    const d = document.querySelector('details.diag-more');
    d.open = true;
    return document.getElementById('addPkg').getClientRects().length;
  });
  chk('展开折叠后输入框量得到（说明判隐藏的方法本身是对的）', openedRects > 0, `${openedRects} 个矩形`);""",
            tag='addpkg')

    s = sub(s, """  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && !gateUi.hasVisibleManual && !gateUi.detailsOpen,
    `折叠=${gateUi.manualFolded} 可见=${gateUi.hasVisibleManual} 展开=${gateUi.detailsOpen}`);""",
            """  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && gateUi.hiddenRects === 0 && !gateUi.detailsOpen,
    `有折叠=${gateUi.manualFolded} 收起时矩形=${gateUi.hiddenRects} 已展开=${gateUi.detailsOpen}`);""",
            tag='chk')

    io.open(TP, 'w', encoding='utf-8').write(s)
    print('两条断言已修')


if __name__ == '__main__':
    main()
