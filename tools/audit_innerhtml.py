"""断言：**不可信来源**的字符串，插进 innerHTML 前必须过 esc() / rich()。

为什么写这个：GPT 评审（2026-09-11）说「AI 返回内容或 OCR 文本如果走 innerHTML，
提示注入就可能进一步调用 addJavascriptInterface，读本地状态甚至拿到 API key」。
这条**可验证**，所以查了，结论是**不成立**：这个项目里模型输出的每一个渲染点都过了
`rich()`（它内部先 `esc()`），OCR 的文字是写进 `<textarea>.value`（不是 HTML），
所以那条攻击链目前没有入口。

但查的过程中确认了一件真事，也因此把这个检查留了下来：
WebView 里挂着 `addJavascriptInterface`（桥能发任意 HTTPS），**所以「能不能注入 HTML」
就是「能不能读走密钥」**。这类问题一旦在某次改动里破掉，不会有任何报错——
所以用一条静态断言钉住，而不是靠自觉。

第一版写成了"扫所有 innerHTML 插值"，报出 200 多条，绝大多数是本文件里的常量拼接——
**一个刷屏的检查等于没有检查**（真出问题时会被淹掉，这是这个项目反复踩到的）。
所以收紧成：只盯**已知的不可信来源**。名单要加就加在下面，别放宽判据。

用法：py -3 tools/audit_innerhtml.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ['public/app.js', 'public/voice.js']

# 只列真正不可信的来源。
#
# 匹配方式很关键：这些名字**必须是成员访问**（`o.inner`、`d.verdict`、`f.say`），
# 因为模型输出的字段都是从解析出来的对象上取的。裸标识符不算——
# 第一版把裸名字也算上，于是两个误报：
#   · `${inner}`  —— 那是 `fogShell(inner)` 的参数，装的是本文件拼好的 HTML，
#                    跟模型字段 `o.inner`（对方心里在想什么）只是重名；
#   · `label`     —— 那是设置页分区标题的静态数组，和设备给的应用名 `a.label` 也是重名。
# 这类重名一定会持续出现（`say`/`one`/`signal`/`tone`/`summary` 都是常用词），
# 所以判据定成「带点的成员访问」，宁可漏报也不刷屏。
UNTRUSTED = [
    # —— 模型输出 ——
    'reply', 'inner', 'say', 'verdict', 'pattern', 'keeps', 'one', 'score_line',
    'how_to_reply', 'if_they_say', 'what_it_means', 'you_say', 'watch_out',
    'situation', 'avoid', 'summary', 'reasoning', 'her_state', 'opening', 'trap',
    'rating_why', 'temp_delta', 'tone', 'cue', 'settle',
    # —— 设备给的字符串（应用可以把自己命名成 <img onerror=...>）——
    'label', 'pkg', 'name',
    # —— 异常 ——
    'message',
]
SAFE = re.compile(r'\b(esc|rich)\s*\(')
# 这几个也算安全，各有明确理由（别再加"看起来没事"的，要能说出为什么）：
#   · `VERDICT_LABEL[item.verdict]` —— 模型的值只当**键**用，插进 HTML 的是静态表里那一项；
#   · `nextAction(p).label` —— `nextAction()` 是本地函数，返回值全是写死的按钮文案；
#   · `slug(o.tone)` —— slug() 把非中文/字母的字符全删掉（连空格和引号都不留），
#     拿它当 CSS 类名，产不出 `<` `>` `"` `'` `&`。
SAFE_CALL = re.compile(r'(VERDICT_LABEL\s*\[|nextAction\s*\(|\bslug\s*\()')
MEMBER = re.compile(r'\.\s*(' + '|'.join(re.escape(n) for n in UNTRUSTED) + r')\b')


def templates_after(text, start):
    i = text.find('`', start)
    if i < 0:
        return ''
    j, depth = i + 1, 0
    while j < len(text):
        c = text[j]
        if c == '\\':
            j += 2
            continue
        if c == '$' and j + 1 < len(text) and text[j + 1] == '{':
            depth += 1
            j += 2
            continue
        if c == '}' and depth:
            depth -= 1
            j += 1
            continue
        if c == '`' and depth == 0:
            return text[i + 1:j]
        j += 1
    return ''


def main():
    hits = []
    for f in FILES:
        src = (ROOT / f).read_text(encoding='utf-8')
        for m in re.finditer(r'(innerHTML\s*\+?=\s*|outerHTML\s*=\s*'
                             r'|insertAdjacentHTML\([^,]+,\s*)', src):
            tpl = templates_after(src, m.end())
            if not tpl:
                continue
            line0 = src[:m.start()].count('\n') + 1
            for im in re.finditer(r'\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', tpl):
                expr = im.group(1)
                if SAFE.search(expr) or SAFE_CALL.search(expr):
                    continue
                mm = MEMBER.search(expr)
                if mm:
                    hits.append((f, line0, expr.strip()[:90], mm.group(1)))

    print('=' * 74)
    print('不可信字符串插进 innerHTML 且未转义（应为 0）')
    print('=' * 74)
    if not hits:
        print('  0 处。模型输出 / 设备字符串的每个渲染点都过了 esc() 或 rich()。')
    for f, line, expr, name in hits:
        print(f'  ! {f}:{line}  ${{{expr}}}   ← 命中不可信来源「{name}」')
    print()
    print(f'检查了 {len(FILES)} 个文件；不可信来源名单 {len(UNTRUSTED)} 个。')
    print('这一条盯的是「模型输出→HTML→桥→密钥」这条链的入口，一旦有入口就是真漏洞。')
    print(f'结果：{"有 " + str(len(hits)) + " 处未转义" if hits else "全部通过（0 处未转义）"}')
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
