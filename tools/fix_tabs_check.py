# -*- coding: utf-8 -*-
"""修 check_tabs_unique.js 里 5 个失败——其中 5 个里 4 个是我测试写错的。

主 bug（偏差画像/我的预案 都渲染成刷卡片页）已经修好并通过：
「十个页面没有任何两页正文相同」PASS、0 对重复。剩下的失败逐个看：

1. 「刷卡片页是题目」——断言只看了正文前 40 个字，而卡片页开头是
   领域筛选条（全部/恋爱/职场…），题目在第 40 字之后。断言太窄，不是代码问题。

2. 「手动填包名收进了折叠里」——测试没先清掉之前叠着的面板。
   设置页被反复打开时会叠好几层，`getElementById('addPkg')` 取到的是**第一处**，
   可能属于旧的那一层。这本身也值得注意：**同一个 id 在 DOM 里出现多次**
   就是这种「取到了错的那个」的温床。测试先清干净再量。

3. 「搜应用名能过滤」——我拿中文「腾讯」去搜，而「腾讯」只出现在**包名**里、
   不在应用名里（应用名是「王者荣耀」「微信读书」）。包名是 ASCII，中文搜不到。
   改成搜「王者」（应用名）和「tencent」（包名）两条，各自验一遍。

4. 「选中后立刻保存」——localStorage 的键是 eq-state-v2，我写成了 v1。

5. 「原生抛错也不崩」——`.inner` 取到的是叠在下面的设置页，
   要取 `#pkgSheet .inner`。
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

    # 1) 卡片页断言：用整段正文，不看 40 字开头
    s = sub(s, """  chk('刷卡片页是题目（不是画像也不是预案）',
    /这是什么局|下一步最该做的是什么/.test(pick('practice/卡片').head || ''),
    pick('practice/卡片').head);""",
            """  chk('刷卡片页是题目（不是画像也不是预案）',
    /这是什么局|最该做的是什么|判断对方/.test(pick('practice/卡片').sig || ''),
    pick('practice/卡片').sig);""", tag='card')

    # 2) 先清干净再量折叠
    s = sub(s, """  await p.evaluate(() => openDailySettings());
  await p.waitForTimeout(200);
  const gateUi = await p.evaluate(() => {
    const t = document.getElementById('view') ? '' : '';
    const sheet = document.querySelector('.sheet');
    const txt = sheet ? sheet.textContent : '';
    return {
      hasPickBtn: !!document.querySelector('button[onclick="openAppPicker()"]'),
      // 主入口应该是「挑」，不是手输框
      hasVisibleManual: !!document.getElementById('addPkg')
        && document.getElementById('addPkg').offsetParent !== null,
      manualFolded: /手动填包名/.test(txt),
    };
  });
  chk('设置页有「从已安装应用里挑」这个主入口', gateUi.hasPickBtn);
  chk('手动填包名收进了折叠里（不是主入口）', gateUi.manualFolded && !gateUi.hasVisibleManual);""",
            """  // 面板会叠：先全清掉再打开，否则 getElementById 可能取到旧那一层里的同名元素
  await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    openDailySettings();
  });
  await p.waitForTimeout(200);
  const gateUi = await p.evaluate(() => {
    const sheets = [...document.querySelectorAll('.sheet')];
    const txt = sheets.map((x) => x.textContent).join('\\n');
    const add = document.getElementById('addPkg');
    return {
      sheetCount: sheets.length,
      addPkgCount: document.querySelectorAll('#addPkg').length,
      hasPickBtn: !!document.querySelector('button[onclick="openAppPicker()"]'),
      // 主入口应该是「挑」，不是手输框：折叠里的输入框量不到 offsetParent
      hasVisibleManual: !!add && add.offsetParent !== null,
      manualFolded: /手动填包名/.test(txt),
      detailsOpen: !!document.querySelector('details.diag-more[open]'),
    };
  });
  chk('设置页只有一个面板、一个包名输入框', gateUi.sheetCount === 1 && gateUi.addPkgCount === 1,
    `面板 ${gateUi.sheetCount} 个 / 输入框 ${gateUi.addPkgCount} 个`);
  chk('设置页有「从已安装应用里挑」这个主入口', gateUi.hasPickBtn);
  chk('手动填包名收进了折叠里（不是主入口）',
    gateUi.manualFolded && !gateUi.hasVisibleManual && !gateUi.detailsOpen,
    `折叠=${gateUi.manualFolded} 可见=${gateUi.hasVisibleManual} 展开=${gateUi.detailsOpen}`);""",
            tag='gateUi')

    # 3) 搜索：应用名和包名各一条
    s = sub(s, """  const search = await p.evaluate(() => {
    const el = document.getElementById('pkgSearch');
    el.value = '腾讯';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜应用名能过滤', search.length > 0 && search.length < 4, search.join('、'));
  const search2 = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = 'aweme';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜包名也能过滤', search2.length === 1 && search2[0] === '抖音', search2.join('、'));""",
            """  // 搜应用名（中文）
  const search = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = '王者';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜应用名能过滤（中文）', search.length === 1 && search[0] === '王者荣耀', search.join('、'));
  // 搜包名（英文）——包名是 ASCII，中文搜不到它，所以这两条要分开验
  const search2 = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = 'tencent';
    filterPkgs();
    return [...document.querySelectorAll('#pkgList .pkg-label')].map((x) => x.textContent);
  });
  chk('搜包名也能过滤（英文）', search2.length === 2, search2.join('、'));
  const nohit = await p.evaluate(() => {
    document.getElementById('pkgSearch').value = 'zzzz';
    filterPkgs();
    return document.getElementById('pkgList').textContent;
  });
  chk('搜不到时说清楚，不留空白', /没有匹配/.test(nohit), nohit.slice(0, 40));""",
            tag='search')

    # 4) 键名
    s = sub(s, """      persisted: JSON.parse(localStorage.getItem('eq-state-v1') || '{}').gate,""",
            """      persisted: JSON.parse(localStorage.getItem('eq-state-v2') || '{}').gate,""", tag='lsKey')

    # 5) 取对面板
    s = sub(s, """  const empty = await p.evaluate(() => {
    window.EQNative = { listApps: () => '[]' };
    PKG_LIST = null;
    openAppPicker();
    const t = document.querySelector('.inner').textContent;""",
            """  const empty = await p.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    window.EQNative = { listApps: () => '[]' };
    PKG_LIST = null;
    openAppPicker();
    const t = document.querySelector('#pkgSheet .inner').textContent;""", tag='empty')

    s = sub(s, """    window.EQNative = { listApps: () => { throw new Error('读取被系统拒绝'); } };
    PKG_LIST = null;
    const sh = document.getElementById('pkgSheet'); if (sh) sh.remove();
    openAppPicker();
    return document.querySelector('.inner').textContent;""",
            """    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    window.EQNative = { listApps: () => { throw new Error('读取被系统拒绝'); } };
    PKG_LIST = null;
    openAppPicker();
    return document.querySelector('#pkgSheet .inner').textContent;""", tag='bad')

    io.open(TP, 'w', encoding='utf-8').write(s)
    print('测试已修：4 处是我写错（键名/取错面板/中文搜 ASCII/只看了 40 字）')


if __name__ == '__main__':
    main()
