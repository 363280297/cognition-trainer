# -*- coding: utf-8 -*-
"""修 port_ai_modules 漏掉的一处：`r.result` 这个访问器。

原来 `post()` 返回的是 `{ok: true, result: {...}}`，所以调用方写 `r.result.xxx`。
搬到 `llmCall` 之后它**直接返回解析好的对象**（`{questions: [...], ...}`），
于是 `r.result` 是 undefined —— 真实复盘一提交就报
「Cannot read properties of undefined (reading 'questions')」。

体检那一处我改对了（`renderCheckup(r.result)` → `renderCheckup(r)`），
复盘的四处漏了。这正是「改了调用但没改返回值形状」的典型漏改：
函数名换了、参数也对，只有返回值多套了一层。

测试抓出来的——`check_ai_modules.js` 里「出题这一步跑通了」那条。
所以修完之后要确认那条断言真的转绿，而不是把断言放宽。
"""
import io
import os

AP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'app.js')


def main():
    s = io.open(AP, encoding='utf-8').read()
    pairs = [
        ("    replay.questions = r.result.questions || [];", "    replay.questions = r.questions || [];"),
        ("    replay.summary = r.result.summary || '';", "    replay.summary = r.summary || '';"),
        ("    replay.note = r.result.note || '';", "    replay.note = r.note || '';"),
        ("    replay.reveal = r.result;", "    replay.reveal = r;"),
        ("    renderReplayReveal(r.result);", "    renderReplayReveal(r);"),
    ]
    for old, new in pairs:
        assert s.count(old) == 1, f'命中 {s.count(old)} 次：{old!r}'
        s = s.replace(old, new)
    io.open(AP, 'w', encoding='utf-8').write(s)
    left = s.count('r.result')
    assert left == 0, f'还有 {left} 处 r.result'
    print('五处 r.result 都改成直接用返回值了')


if __name__ == '__main__':
    main()
