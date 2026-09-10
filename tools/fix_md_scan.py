# -*- coding: utf-8 -*-
"""把「界面不许出现 ** 」这条断言改成只看真正渲染出来的文本节点。

第一版扫 `document.body.textContent`，结果凭空报了一堆错：离线单文件版把
**所有 JS 和内容 JSON 都内联在 `<script>` 里**，于是源码注释里的 `**重点**`
和 cards.json 的 note 字段全被当成了界面文本。

这是个典型的「断言本身写错了」——它测的是「文档里有没有星号」，
而我要测的是「用户眼睛能不能看到星号」。改成只看非 script/style 元素的
**直接文本节点**，正好就是屏幕上那些字。这样内联的代码和数据自然排除在外。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TP = os.path.join(ROOT, 'tools', 'check_tabs_unique.js')

OLD = """  const ast = await p.evaluate(() => {
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
    };"""

NEW = """  const ast = await p.evaluate(() => {
    const bad = [];
    /* 只看**非 script/style 元素的直接文本节点**——那才是屏幕上出现的字。
       不能扫 document.body.textContent：离线单文件版把所有 JS 和内容 JSON 都内联在
       <script> 里，源码注释和 cards.json 的 note 都带 **，会被当成界面文本误报
       （我第一版就是这么写错的）。 */
    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const walk = (root, label) => {
      if (!root) return;
      root.querySelectorAll('*').forEach((el) => {
        if (SKIP[el.tagName]) return;
        [...el.childNodes].forEach((n) => {
          if (n.nodeType !== 3) return;
          const m = String(n.nodeValue).match(/\\*\\*[^*\\n]{1,40}\\*\\*/);
          if (m) bad.push(label + ' <' + el.tagName.toLowerCase() + '>：' + m[0].slice(0, 30));
        });
      });
    };"""


def main():
    s = io.open(TP, encoding='utf-8').read()
    assert s.count(OLD) == 1, s.count(OLD)
    s = s.replace(OLD, NEW)
    io.open(TP, 'w', encoding='utf-8').write(s)
    print('断言改成只看渲染出来的文本节点')


if __name__ == '__main__':
    main()
