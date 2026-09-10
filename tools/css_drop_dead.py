"""删掉 2.31 删语音输入、以及更早删「现实任务对账」时留下的死样式。

为什么不靠"看着像没人用"：这个项目的规矩是**每个类名都真的去 public/ 里数一遍引用**，
数为 0 才删。这个脚本自己数一遍，不引用外部结论。

为什么用花括号配对而不是正则：@keyframes 和跨行的选择器用 `^sel {.*?}$` 会漏
（上一版就漏了 `@keyframes pdc`，而且断言当场拦住了半截写入）。
"""
import io
import re
import sys

CSS = "public/style.css"
JS = ["public/app.js", "public/voice.js", "public/index.html"]

# 只删这些选择器的整块规则（类名 → 为什么是死的）
DEAD = {
    ".talk-row": "语音时代的行容器",
    ".ptt": "按住说话", ".ptt.on": "按住说话", ".ptt:disabled": "按住说话",
    ".phase-line": "免提状态条", ".phase-pill": "免提状态条", ".phase-dot": "免提状态条",
    ".phase-dot.listening": "免提状态条", ".phase-dot.thinking": "免提状态条",
    ".phase-dot.speaking": "免提状态条",
    ".hf-toggle": "免提开关", ".hf-toggle:active": "免提开关",
    ".hf-only, .ptt-only": "免提/按住二选一", ".v-talk.hf-on .hf-only": "免提",
    ".mic-big": "大麦克风键", ".mic-big.idle": "大麦克风键", ".mic-big.listening": "大麦克风键",
    ".mic-big.speaking": "大麦克风键", ".mic-big.thinking": "大麦克风键",
    ".mic-big:disabled": "大麦克风键",
    ".his-btn": "历史里没人用的按钮",
    ".assign-card": "已删的现实任务对账", ".assign-ask": "已删的现实任务对账",
    ".assign-btns": "已删的现实任务对账", ".assign-btns .primary, .assign-btns .ghost": "已删的现实任务对账",
}
DEAD_KEYFRAMES = ["@keyframes pd", "@keyframes pdc"]


def block_end(s, i):
    """从规则开头的 '{' 位置，返回配对 '}' 的下标（+1）。"""
    depth = 0
    while i < len(s):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("花括号没配对")


def find_block(s, sel):
    """找一个选择器的规则块。返回 (start, end)；找不到返回 None。"""
    pat = re.compile(r"(?m)^" + re.escape(sel) + r"\s*\{")
    m = pat.search(s)
    if not m:
        return None
    return m.start(), block_end(s, s.index("{", m.start()))


def refs(cls):
    """这个类名在 public/ 里被引用几次（去掉点号，按整词数）。"""
    word = cls.lstrip(".").split()[0].split(":")[0]
    n = 0
    for f in JS:
        try:
            n += len(re.findall(r"\b" + re.escape(word) + r"\b", io.open(f, encoding="utf-8").read()))
        except FileNotFoundError:
            pass
    return n


def main():
    s = io.open(CSS, encoding="utf-8").read()
    before = s.count("\n")
    removed, skipped = [], []

    for sel, why in DEAD.items():
        n = refs(sel)
        if n:
            skipped.append(f"{sel}（{why}）—— 还有 {n} 处引用，**没删**")
            continue
        got = find_block(s, sel)
        if not got:
            skipped.append(f"{sel}（{why}）—— CSS 里找不到这块")
            continue
        a, b = got
        while b < len(s) and s[b] == "\n":
            b += 1
        s = s[:a] + s[b:]
        removed.append(f"{sel}（{why}）")

    for kf in DEAD_KEYFRAMES:
        got = find_block(s, kf)
        if not got:
            skipped.append(f"{kf} —— 找不到")
            continue
        a, b = got
        while b < len(s) and s[b] == "\n":
            b += 1
        s = s[:a] + s[b:]
        removed.append(kf)

    io.open(CSS, "w", encoding="utf-8", newline="\n").write(s)
    print(f"删掉 {len(removed)} 块死规则，文件 {before} → {s.count(chr(10))} 行")
    for r in removed:
        print("  删 " + r)
    for k in skipped:
        print("  跳过 " + k)
    if skipped:
        sys.exit(1)


if __name__ == "__main__":
    main()
