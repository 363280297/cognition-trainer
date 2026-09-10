# -*- coding: utf-8 -*-
"""修 heredoc 把 \\n 吃成真换行导致的语法错误。

第三十三次踩同一个坑了：在这个环境里用 bash heredoc 写 `\\n`，
反斜杠会被吃掉，于是 JS 源文件里出现了**字符串跨行的真换行**，
直接 SyntaxError。可靠的写法只有 Write 工具或 Edit 工具。

这次坏的是三处 `console.log('` 后面断行。用 Edit 修，不再碰 heredoc。
"""
import io
import os

TP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'check_voice_pack.js')


def main():
    s = io.open(TP, encoding='utf-8').read()
    # 坏掉的形态：console.log(' 后面跟一个真换行
    bad = "console.log('\n"
    good = "console.log('\\n"
    n = s.count(bad)
    assert n == 2, f'期望 2 处，实得 {n}'
    s = s.replace(bad, good)
    io.open(TP, 'w', encoding='utf-8').write(s)
    print(f'修好 {n} 处被吃掉的换行转义')


if __name__ == '__main__':
    main()
