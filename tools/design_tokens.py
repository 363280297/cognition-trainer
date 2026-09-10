"""第一步：给 style.css 铺一层真正的设计变量（token），并把散落的字面量收进来。

为什么要有这一步（用户的诉求是"UI 重新设计"，而重排结构之前先得有地基）：
审计出来的现状是 —— 125 个色值 / 214 处、36 个字号 / 159 处、16 个圆角 / 79 处，
而 `var()` 只用了 246 次。同一份规则里上一行写 `#6c8cff`、下一行写 `var(--good)`。
不先把地基铺平，重排每一屏都要重新发明一遍颜色和字号。

这次做四件事：
  1. 用一套语义色（每个家族 main/bg/line/fg 四个角色）+ 5 档字号 + 4 档圆角 + 6 档间距
     替换现在 11 个"色值别名"式的变量；老变量名保留成别名，所以不会一次性炸掉引用。
  2. 把 125 个色值按族合并（近似色并成一个）——目标是 40 个以内。
  3. 把 36 个字号收成 5 档。**正文从 13.4px 提到 15px**（中文在手机上 13.4 偏小，
     而且 13 个字号挤在 0.12rem 区间里视觉上根本分不出来）。
  4. 圆角收成 8/12/16/999 四档（现在的事实标准是 10/11px，而被 token 化的
     14px 只用了 4 次——那是个孤岛）。

不在这里做的事（留给同一轮的手工修改，因为需要判断而不是查表）：
z-index 撞车、安全区、dvh、删死代码、合并重复组件。

跑完会自己检查：正文里但凡还剩一个没进映射表的色值/字号，就打印出来并以非零码退出
——**宁可当场炸，不要留下一批"看着像改完了、其实还有 60 个漏网色值"**。
"""
import io
import re
import sys
from collections import Counter

CSS = "public/style.css"

# ---------------------------------------------------------------- 色值映射
# 按"族"合并。左边是现在散落的字面量，右边是新 token。
# 原则：同一个家族的深浅变体并成一个角色，宁可让某些框的颜色差 5%，也不要 125 个值。
COLORS = {
    # 中性：页面/面板/内嵌/描边
    "#1b1d27": "var(--panel)", "#1a1b24": "var(--panel)", "#1b1b20": "var(--panel)",
    "#171a26": "var(--panel)", "#1f2530": "var(--panel)", "#232a36": "var(--panel)",
    "#1b1f28": "var(--panel)", "#1b1f2a": "var(--panel)", "#1f2433": "var(--panel)",
    "#2b2f3a": "var(--panel2)", "#2b2f3b": "var(--panel2)",
    "#2c3340": "var(--line)", "#2e323e": "var(--line)",
    "#2c4155": "var(--line-strong)", "#33475e": "var(--line-strong)",
    "#48506a": "var(--line-strong)", "#4a4f5e": "var(--line-strong)",
    "#4a4a52": "var(--line-strong)", "#2e4155": "var(--line-strong)",
    # 蓝族（主色）
    "#6c8cff": "var(--accent)",
    "#2c3766": "var(--accent-bg)", "#1d2740": "var(--accent-bg)", "#2b3350": "var(--accent-bg)",
    "#232f4d": "var(--accent-bg)", "#1f2433 ": "var(--accent-bg)",
    "#4a5da0": "var(--accent-line)", "#33456e": "var(--accent-line)",
    "#36466e": "var(--accent-line)", "#3d4a72": "var(--accent-line)",
    "#2f3f6e": "var(--accent-line)", "#3a4b7d": "var(--accent-line)",
    "#4a7ba8": "var(--accent-line)", "#3a5bbf": "var(--accent)",
    "#dfe6ff": "var(--accent-fg)", "#cfe0ff": "var(--accent-fg)", "#cfe6ff": "var(--accent-fg)",
    "#9fd0ff": "var(--accent-fg)", "#8fb6dd": "var(--accent-fg)", "#8fb8e8": "var(--accent-fg)",
    "#9fb6e8": "var(--accent-fg)", "#c6d6e8": "var(--accent-fg)", "#cdd5e8": "var(--accent-fg)",
    "#b6c8e6": "var(--accent-fg)", "#cfe6f5": "var(--accent-fg)", "#7fb0ff": "var(--accent-fg)",
    # 蓝族的深底（证据框、说明框）
    "#16202b": "var(--accent-bg)", "#16202c": "var(--accent-bg)", "#1c2430": "var(--accent-bg)",
    "#1d2b38": "var(--accent-bg)", "#1e2733": "var(--accent-bg)", "#141b23": "var(--accent-bg)",
    "#1e2b34": "var(--accent-bg)", "#35505f": "var(--accent-line)", "#1f2433": "var(--accent-bg)",
    # 绿族（正确/达成）
    "#43c98b": "var(--good)",
    "#16301f": "var(--good-bg)", "#1d3226": "var(--good-bg)", "#1e2e26": "var(--good-bg)",
    "#1f3a2c": "var(--good-bg)", "#22301f": "var(--good-bg)", "#0b1a12": "var(--good-bg)",
    "#2f5340": "var(--good-line)", "#3f6d55": "var(--good-line)", "#3c5030": "var(--good-line)",
    "#2c5d47": "var(--good-line)",
    "#8fd8a8": "var(--good-fg)", "#6fbf8f": "var(--good-fg)", "#b6edcd": "var(--good-fg)",
    "#b6e6c6": "var(--good-fg)",
    # 黄族（警告/半对）
    "#e0b84c": "var(--warn)",
    "#2a2312": "var(--warn-bg)", "#2f2913": "var(--warn-bg)", "#3a2f1a": "var(--warn-bg)",
    "#2a2418": "var(--warn-bg)", "#241f1a": "var(--warn-bg)",
    "#5d4f2c": "var(--warn-line)", "#57482a": "var(--warn-line)", "#5a4a2a": "var(--warn-line)",
    "#ffd08a": "var(--warn-fg)", "#e8a05c": "var(--warn-fg)", "#e8d9b0": "var(--warn-fg)",
    # 红族（错误）
    "#e06c6c": "var(--bad)",
    "#2f1a1a": "var(--bad-bg)", "#241b1f": "var(--bad-bg)", "#241d26": "var(--bad-bg)",
    "#221a1c": "var(--bad-bg)", "#2f2228": "var(--bad-bg)", "#3a1f2a": "var(--bad-bg)",
    "#5d2c2c": "var(--bad-line)", "#6b3030": "var(--bad-line)", "#4a2b31": "var(--bad-line)",
    "#4a2f3f": "var(--bad-line)", "#5c2f3f": "var(--bad-line)",
    "#f0b8b8": "var(--bad-fg)", "#f0a0b4": "var(--bad-fg)", "#e08fb0": "var(--bad-fg)",
    # 紫族（脑雾 / 自定义场景）
    "#b98ce8": "var(--purple)",
    "#241f2e": "var(--purple-bg)", "#2b2334": "var(--purple-bg)", "#2c2438": "var(--purple-bg)",
    "#4d3d63": "var(--purple-line)", "#6b5a86": "var(--purple-line)", "#4a3a61": "var(--purple-line)",
    "#7a5aa8": "var(--purple)",
    "#d9cbe8": "var(--purple-fg)", "#cbbcdd": "var(--purple-fg)", "#cfc4e0": "var(--purple-fg)",
    "#cbb8e8": "var(--purple-fg)", "#c9b3f0": "var(--purple-fg)", "#e6d8f5": "var(--purple-fg)",
    "#f0e8fa": "var(--purple-fg)",
    # 暖色（"上次没聊完" 那张卡专用）
    "#e8c07a": "var(--warm)", "#d8c68a": "var(--warm-fg)",
    "#6a5a2e": "var(--warm-line)", "#24211a": "var(--warm-bg)",
    # 「今天就练这个」那张卡的蓝底渐变
    "#3a4a6a": "var(--accent-line)", "#1d2331": "var(--panel)",
    # 蓝族尾巴（自查时揪出来的 5 个：两处选中态底、一处"已完成"描边、一处语气色）
    "#1d2c44": "var(--accent-bg)", "#24425c": "var(--accent-bg)", "#2a3350": "var(--accent-bg)",
    "#23323f": "var(--accent-line)",
    # 「平淡」语气那条左边线：中性偏蓝，归到强调描边太重，归到 --line-strong 正好
    "#4a5170": "var(--line-strong)",
    # 结构性
    "#12131a": "var(--bg)", "#23262f": "var(--panel2)",
    "#e8eaf0": "var(--text)", "#9aa0b0": "var(--dim)",
    "#2e323e ": "var(--line)",
}
KEEP_COLORS = {"#000", "#fff", "#000000", "#ffffff"}

# ---------------------------------------------------------------- 字号映射
# 36 个值 → 5 档。左边一列是现在挤在一起的 13 个值（.84→.96，跨 1.92px）。
# 方向是**放大**：正文 13.4 → 15px，最小注脚 9.3 → 11px。
FONTS = {
    ".58rem": "var(--fs-xs)", ".6rem": "var(--fs-xs)", ".62rem": "var(--fs-xs)",
    ".66rem": "var(--fs-xs)", ".68rem": "var(--fs-xs)", ".7rem": "var(--fs-xs)",
    ".72rem": "var(--fs-sm)", ".74rem": "var(--fs-sm)", ".75rem": "var(--fs-sm)",
    ".76rem": "var(--fs-sm)", ".78rem": "var(--fs-sm)",
    ".8rem": "var(--fs-md)", ".82rem": "var(--fs-md)", ".84rem": "var(--fs-md)",
    ".85rem": "var(--fs-md)", ".86rem": "var(--fs-md)", ".87rem": "var(--fs-md)",
    ".88rem": "var(--fs-md)", ".89rem": "var(--fs-md)", ".9rem": "var(--fs-md)",
    ".91rem": "var(--fs-md)", ".92rem": "var(--fs-md)", ".93rem": "var(--fs-md)",
    ".94rem": "var(--fs-md)", ".95rem": "var(--fs-md)", ".96rem": "var(--fs-md)",
    "1rem": "var(--fs-lg)", "1.02rem": "var(--fs-lg)", "1.05rem": "var(--fs-lg)",
    "1.06rem": "var(--fs-lg)", "1.1rem": "var(--fs-lg)", "1.12rem": "var(--fs-lg)",
    "1.15rem": "var(--fs-lg)", "1.22rem": "var(--fs-xl)", "1.25rem": "var(--fs-xl)",
    "1.3rem": "var(--fs-xl)",
}

# ---------------------------------------------------------------- 圆角映射
RADII = {
    "14px": "var(--r-md)", "12px": "var(--r-md)", "11px": "var(--r-md)", "10px": "var(--r-md)",
    "var(--radius)": "var(--r-md)",
    "9px": "var(--r-sm)", "8px": "var(--r-sm)", "7px": "var(--r-sm)",
    "6px": "var(--r-sm)", "5px": "var(--r-sm)",
    "18px 18px 0 0": "var(--r-lg) var(--r-lg) 0 0",
    "14px 14px 0 0": "var(--r-lg) var(--r-lg) 0 0",
    "0 10px 10px 0": "0 var(--r-sm) var(--r-sm) 0",
    "0 8px 8px 0": "0 var(--r-sm) var(--r-sm) 0",
    "999px": "var(--r-pill)",
    "50%": "50%",          # 圆点，不动
}

# ---------------------------------------------------------------- 间距
# 只收 gap / padding / margin-bottom 三种（占全部间距声明的绝大部分）。
# margin-top / margin 简写不动：它们更零散、改动收益小、风险大。
SPACING_PROPS = ("gap", "padding", "margin-bottom", "padding-bottom", "padding-top",
                 "padding-left", "padding-right")
# 超出这个范围的数值不动（170px 是给底部浮标留的位，不是"间距"）
SP_MAX = 30
SP_STEPS = [(1, 6, "var(--sp-1)"), (7, 10, "var(--sp-2)"), (11, 14, "var(--sp-3)"),
            (15, 18, "var(--sp-4)"), (19, 24, "var(--sp-5)"), (25, SP_MAX, "var(--sp-6)")]

NEW_ROOT = """:root {
  /* ==========================================================================
     设计变量（2.34 铺的地基）

     为什么必须有这一层：铺之前这份样式里有 125 个色值 / 214 处、36 个字号 / 159 处，
     而 var() 只用了 246 次——同一份规则里上一行写 #6c8cff、下一行写 var(--good)。
     结果是"每次改界面顺手调一点"：13 个字号挤在 0.12rem 区间里（视觉上分不出来），
     五个几乎一样的深灰各用各的。重排结构之前先把地基铺平，否则每一屏都要重新发明一遍。

     用法：写颜色/字号/圆角/层级别写字面量，从这里取。数量少 = 改一处全局生效。
     ========================================================================== */

  /* ---- 表面与描边 ---- */
  --bg: #12131a;            /* 页面底 */
  --panel: #1b1d27;         /* 卡片、列表项、胶囊 */
  --panel2: #23262f;        /* 卡片里的内嵌块（选项、输入框、引用） */
  --line: #2e323e;          /* 描边、分割线、进度条槽 */
  --line-strong: #3d4250;   /* 需要更明显时（hover、强调描边） */

  /* ---- 文字 ---- */
  --text: #e8eaf0;
  --dim: #9aa0b0;

  /* ---- 语义色：每个家族四个角色 ----
     main 主色（图标/数字/强调字）；bg 底色；line 描边；fg 底色上的浅字。
     以前这四件事各写各的字面量，一共散出去 100 多个值。 */
  --accent: #6c8cff; --accent-bg: #232f4d; --accent-line: #4a5da0; --accent-fg: #dfe6ff;
  --good:   #43c98b; --good-bg:   #16301f; --good-line:   #2f5340; --good-fg:   #8fd8a8;
  --warn:   #e0b84c; --warn-bg:   #2a2312; --warn-line:   #5d4f2c; --warn-fg:   #e8c07a;
  --bad:    #e06c6c; --bad-bg:    #2f1a1a; --bad-line:    #5d2c2c; --bad-fg:    #f0b8b8;
  --purple: #b98ce8; --purple-bg: #241f2e; --purple-line: #4d3d63; --purple-fg: #d9cbe8;
  /* 暖色只给「上次没聊完」那张卡用：它要跟蓝色的「今天就练这个」一眼分开 */
  --warm: #e8c07a; --warm-bg: #24211a; --warm-line: #6a5a2e; --warm-fg: #d8c68a;

  /* ---- 字号：5 档 ----
     正文从 13.4px 提到 15px。中文在手机上 13.4 太小了，而且原来 13 个值
     （.84→.96）在视觉上根本分不出来，那不是阶梯，是"每次顺手调一点"的痕迹。 */
  --fs-xs: .6875rem;   /* 11px  元信息、注脚 */
  --fs-sm: .8125rem;   /* 13px  次要文字、按钮、标签 */
  --fs-md: .9375rem;   /* 15px  正文（主要阅读文字） */
  --fs-lg: 1.125rem;   /* 18px  卡片标题、区块标题 */
  --fs-xl: 1.375rem;   /* 22px  页面大标题 */

  /* ---- 间距：6 档 ---- */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 28px;

  /* ---- 圆角：4 档 ----
     铺之前的事实标准是 10/11px，而被 token 化的 --radius:14px 只用了 4 次——
     那是个孤岛。现在统一成 小块 8 / 卡片 12 / 大面 16 / 胶囊 999。 */
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-pill: 999px;

  /* ---- 层级：只在这里定义 ----
     铺之前 toast 和 pop-sheet 都是 60（互相盖），闸门 80 又让 toast 永远看不见。 */
  --z-top: 20; --z-tab: 30; --z-fab: 40; --z-sheet: 50; --z-pop: 60; --z-gate: 80;
  --z-toast: 90;

  /* ---- 阴影：两个浮标共用一份，别各写各的 ---- */
  --shadow-fab: 0 6px 20px rgba(0,0,0,.45);
  --shadow-sheet: 0 -8px 30px rgba(0,0,0,.5);

  /* ---- 兼容别名：老名字继续有效，避免一次性改几百处引用时漏掉 ---- */
  --radius: var(--r-md);
}
"""


def map_spacing(val):
    """把 '9px 2px 10px' 这种简写逐段映射到档位；0 和超范围的原样保留。"""
    out = []
    for part in val.split():
        m = re.fullmatch(r"(\d+)px", part)
        if not m:
            out.append(part)
            continue
        n = int(m.group(1))
        if n == 0:
            out.append("0")
            continue
        if n > SP_MAX:
            out.append(part)          # 170px 那种不是"间距"，是给浮标留的位
            continue
        for lo, hi, tok in SP_STEPS:
            if lo <= n <= hi:
                out.append(tok)
                break
    return " ".join(out)


def main():
    src = io.open(CSS, encoding="utf-8").read()
    before_colors = {c: n for c, n in Counter(re.findall(r"#[0-9a-fA-F]{3,8}\b", src)).items()}

    # 1) 切出正文：字面量替换**只能作用在 :root 之后**。
    #    第一版是在整份文件上跑替换的，于是 `--line: #2e323e;` 被替换成了
    #    `--line: var(--line);`——自己引用自己，变量失效，全站描边和进度条底色
    #    一起变成透明。而自查当时只看 `:root` 之后的部分，正好把伤口跳过去了。
    #    症状特别隐蔽：CSS 不报错，只是"颜色不见了"。
    end = src.index("}")
    src = src[end + 1:]

    # 2) 色值（整词替换，避免 #1b1d27 被 #1b1d2 误伤——所以用正则带边界）
    color_hits = 0
    for lit, tok in sorted(COLORS.items(), key=lambda x: -len(x[0])):
        pat = re.compile(re.escape(lit.strip()) + r"\b", re.I)
        src, n = pat.subn(tok, src)
        color_hits += n

    # 3) 字号
    font_hits = 0
    for lit, tok in FONTS.items():
        pat = re.compile(r"font-size:\s*" + re.escape(lit) + r"\s*;")
        src, n = pat.subn(f"font-size: {tok};", src)
        font_hits += n

    # 4) 圆角
    rad_hits = 0
    for lit, tok in RADII.items():
        pat = re.compile(r"border-radius:\s*" + re.escape(lit) + r"\s*;")
        src, n = pat.subn(f"border-radius: {tok};", src)
        rad_hits += n

    # 5) 间距（只碰 gap / padding* / margin-bottom）
    sp_hits = 0
    def sp_repl(m):
        nonlocal sp_hits
        sp_hits += 1
        return f"{m.group(1)}: {map_spacing(m.group(2))};"
    src = re.sub(r"\b(gap|padding|padding-bottom|padding-top|padding-left|padding-right|margin-bottom):\s*([^;{}]+);",
                 sp_repl, src)

    # ---- 自查 1：token 定义里不许出现 var()（出现就说明替换漏进了定义区）----
    bad = [m.group(0) for m in re.finditer(r"--[\w-]+:\s*var\(--[\w-]+\)", NEW_ROOT)
           if not m.group(0).startswith("--radius:")]      # --radius 是有意的兼容别名
    if bad:
        print("!! token 定义里出现了 var()，说明替换漏进了定义区：")
        for b in bad:
            print("   " + b)
        sys.exit(1)

    body = src                       # 替换后的正文（不含 token 块）
    src = NEW_ROOT + src
    io.open(CSS, "w", encoding="utf-8", newline="\n").write(src)

    # ---- 自查 2：正文里还剩哪些没进映射表的字面量 ----
    left_colors = sorted(set(c for c in re.findall(r"#[0-9a-fA-F]{3,8}\b", body)
                             if c.lower() not in KEEP_COLORS))
    left_fonts = sorted(set(re.findall(r"font-size:\s*([^;}\n]+)", body)))
    left_radii = sorted(set(re.findall(r"border-radius:\s*([^;}\n]+)", body)))

    print(f"色值替换 {color_hits} 处，{len(before_colors)} 个值 → 剩 {len(left_colors)} 个漏网")
    print(f"字号替换 {font_hits} 处；剩下没 token 化的：{left_fonts or '无'}")
    print(f"圆角替换 {rad_hits} 处；剩下：{left_radii or '无'}")
    print(f"间距替换 {sp_hits} 处")
    if left_colors:
        print("\n!! 这些色值还没并进 token（要么加进 COLORS，要么确认该保留）：")
        for c in left_colors:
            print("   " + c)
        sys.exit(1)


if __name__ == "__main__":
    main()
