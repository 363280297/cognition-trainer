"""第一步：合并重复组件（**只合并、不改类名**）。

审计出的重复：
  · `.pkg-item` / `.voice-item` / `.track-item` 是三份逐字拷贝（应用选择器 / 音色列表 / 音轨列表）；
  · `.mono` 与 `.fog-hint` 是两条只差 2px 圆角和 0.02rem 字号的紫色提示条；
  · `.daily-card` 与 `.today-card` 是逐字节同款的两个类名；
  · `.tabs button` 被手工覆盖三遍，前两遍是死代码。

为什么不改类名：JS 里按名字查（`querySelector('.voice-item')`），测试里也在断言这些名字。
改名会连带改几十处，而收益只是"名字好看"。所以保留三个名字、共用一套样式。
"""
import io

CSS = "public/style.css"
s = io.open(CSS, encoding="utf-8").read()
n = 0


def one(old, new, why):
    global s, n
    assert s.count(old) == 1, f"{why}：命中 {s.count(old)} 次（应为 1）"
    s = s.replace(old, new)
    n += 1


# ---- 底部 tab：把手写覆盖折进基准规则，删掉那两组 ----
one('.tabs button b { font-size: var(--fs-sm); font-weight: 600; }',
    '.tabs button b { font-size: var(--fs-md); font-weight: 600; }', '底部 tab 主标签')
one('''.tabs button { padding: var(--sp-2) var(--sp-1) var(--sp-2); }
.tabs button b { font-size: var(--fs-sm); }
.tabs button small { font-size: var(--fs-xs); }
''', '', '死覆盖 1')
one('''.tabs button { padding: var(--sp-2) var(--sp-1) var(--sp-2); }
.tabs button b { font-size: var(--fs-md); }
.tabs button small { font-size: var(--fs-xs); }
''', '', '死覆盖 2')

# ---- 三份逐字拷贝合成一条 ----
one('''.pkg-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  gap: var(--sp-1) var(--sp-2); width: 100%; text-align: left; font: inherit;
  background: var(--panel2); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); cursor: pointer;
}
''', '''/* 列表项：应用选择器 / 音色列表 / 音轨列表 原来是三份逐字拷贝，合成一条。
   三个类名都保留（JS 和测试里按各自的名字查），只是共用同一套样式。 */
.pkg-item, .voice-item, .track-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  gap: var(--sp-1) var(--sp-2); width: 100%; text-align: left; font: inherit;
  background: var(--panel2); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); cursor: pointer;
}
''', '列表项合并')
one('''.voice-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  gap: var(--sp-1) var(--sp-2); width: 100%; text-align: left; font: inherit;
  background: var(--panel2); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); cursor: pointer;
}
''', '', 'voice-item 已并入')
one('''.track-item {
  display: grid; grid-template-columns: 1fr auto; gap: var(--sp-1) var(--sp-2); width: 100%;
  text-align: left; font: inherit; cursor: pointer;
  background: var(--panel2); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2);
}
''', '', 'track-item 已并入')

# ---- 紫色提示条 ----
one('''.mono {
  margin-top: 11px; padding: var(--sp-3) var(--sp-3); border-radius: var(--r-md);
  background: var(--purple-bg); border: 1px solid var(--purple-line); color: var(--purple-fg); font-size: var(--fs-md);
}''', '''/* 紫色提示条：.mono 是"这段话是替模型转述的"，.fog-hint 是脑雾里的说明。
   原来是两条只差 2px 圆角的规则，合成一条。 */
.mono, .fog-hint {
  background: var(--purple-bg); border: 1px solid var(--purple-line);
  border-radius: var(--r-md); padding: var(--sp-3); color: var(--purple-fg);
  font-size: var(--fs-md); margin-top: var(--sp-3);
}''', '紫色提示条合并')
one('''.fog-hint {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  background: var(--purple-bg); border: 1px solid var(--purple-line); border-radius: var(--r-md);
  padding: var(--sp-3) var(--sp-3); margin-top: 14px; font-size: var(--fs-md); color: var(--purple-fg);
}''', '.fog-hint { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }',
    'fog-hint 只留布局')

# ---- 两张同款卡片 ----
one('.daily-card { border-left: 3px solid var(--accent-line); }',
    '/* 这两张卡原来是逐字节同款的两个类名 */\n'
    '.daily-card, .today-card { border-left: 3px solid var(--accent-line); }', '卡片合并')
one('\n.today-card { border-left: 3px solid var(--accent-line); }', '', 'today-card 已并入')

io.open(CSS, "w", encoding="utf-8", newline="\n").write(s)
print(f"合并完成，共 {n} 处")
