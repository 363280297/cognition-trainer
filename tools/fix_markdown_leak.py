# -*- coding: utf-8 -*-
"""修「** 直接显示给用户看」的问题，并加一条断言防止再犯。

起因：我在闸门设置里写了一句 `列表里只有**有启动图标的应用**`。那句在一个
`.hint` 段落里、没有走 rich()，于是界面上真的显示出了两个星号。

顺着查发现不是只有我这一处：`httpProblem()` 里也有一句
`检查接口地址是不是**完整端点**`，而它的输出是走 `setOut.textContent`
（纯文本！）显示的——所以那两颗星号从 2.13 起就一直在设置页上露着。

根因是这个 App 有**两套文本通道**，而它们的规则相反：
  · `rich()` 走 innerHTML：内容里的 **重点** 会变成粗体（内容文件里写了 100 多处）
  · `textContent`：原样显示，** 就是两个星号
写文本时很容易挑错通道，而挑错了不报错、只是难看，所以没人会发现。

修法：凡是进 textContent 的文案，一律不带 ** 标记（改用「」引号或直接写）。
凡是进 innerHTML 的，可以继续用 ** 也可以直接写 <b>。

并且加一条断言扫**真实渲染出来的界面文本**：任何地方出现 `**` 就算失败。
这条比逐个检查写法可靠——它不关心你走的哪条通道。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    # ---------- app.js：我新写的那句（走 innerHTML，直接用 <b>）----------
    ap = os.path.join(ROOT, 'public', 'app.js')
    a = io.open(ap, encoding='utf-8').read()
    a = sub(a, """          列表里只有**有启动图标的应用**（也就是你能从桌面点开的那些）；""",
            """          列表里只有<b>有启动图标的应用</b>（也就是你能从桌面点开的那些）；""", tag='gateHelp')
    a = sub(a, """    <div id="pkgList"><p class="hint">正在读取已安装的应用…</p></div>""",
            """    <div id="pkgList"><p class="hint">正在读取已安装的应用…</p></div>""", tag='noop')
    io.open(ap, 'w', encoding='utf-8').write(a)

    # ---------- voice.js：走 textContent 的那句，去掉星号 ----------
    vp = os.path.join(ROOT, 'public', 'voice.js')
    v = io.open(vp, encoding='utf-8').read()
    v = sub(v, """      + '检查接口地址是不是**完整端点**，而不是域名或者 /anthropic 那种基础地址。';""",
            """      // 这句是走 setOut.textContent（纯文本）显示的，所以不能带 ** 标记——
      // 带了就会在设置页上原样显示两个星号。这类文案一律不用 markdown。
      + '检查接口地址是不是「完整端点」，而不是域名或者 /anthropic 那种基础地址。';""",
            tag='httpProblem')
    io.open(vp, 'w', encoding='utf-8').write(v)

    # ---------- 断言：真实渲染的文本里不许出现 ** ----------
    tp = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')
    t = io.open(tp, encoding='utf-8').read()
    t = sub(t, """  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));""",
            """  // 这条盯的是「** 露给用户看」。这个 App 有两条文本通道：
  //   rich() 走 innerHTML（** 会变粗体）／textContent 原样显示（** 就是两个星号）。
  // 挑错通道不报错、只是难看，所以直接扫渲染结果，不关心用的哪条通道。
  console.log('\\n[不许把 markdown 标记显示给用户]');
  const ast = await p.evaluate(() => {
    const bad = [];
    const scan = (label, text) => {
      const m = String(text || '').match(/\\*\\*[^*\\n]{1,40}\\*\\*/);
      if (m) bad.push(label + '：' + m[0].slice(0, 40));
    };
    const walk = (root, label) => {
      if (!root) return;
      scan(label, root.textContent);
      root.querySelectorAll('*').forEach((el) => {
        [...el.childNodes].forEach((n) => {
          if (n.nodeType === 3 && /\\*\\*/.test(n.nodeValue)) bad.push(label + '：节点文本 ' + n.nodeValue.trim().slice(0, 30));
        });
      });
    };
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 设置页（含闸门那一段）
    openDailySettings();
    walk(document.body, '设置页');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 挑应用面板
    window.EQNative = { listApps: () => JSON.stringify([{ label: '王者荣耀', pkg: 'com.tencent.tmgp.sgame' }]) };
    PKG_LIST = null;
    openAppPicker();
    walk(document.body, '挑应用面板');
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    // 四个 tab 的正文
    ['today', 'practice', 'ai', 'growth'].forEach((tab) => walk((go(tab), document.body), 'tab:' + tab));
    return [...new Set(bad)];
  });
  chk('界面上没有露出来的 ** 标记', ast.length === 0, ast.slice(0, 3).join(' | '));

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));""",
            tag='assert')
    io.open(tp, 'w', encoding='utf-8').write(t)
    print('textContent 通道里的 ** 已清掉；并加了「界面不许出现 ** 」的断言')


if __name__ == '__main__':
    main()
