"""第一步的结构修补：层级、安全区、浮层高度。

这三件事都是审计里揪出来的**真硬伤**，不是审美问题：
  1. z-index 撞车：toast 与 pop-sheet 同为 60（谁盖谁看 DOM 顺序），
     而闸门 80 又让 toast 永远看不见——闸门里的按钮点出提示，提示被自己盖住。
  2. 顶部没有安全区：`.top` 是 sticky 的，刘海机上会顶进状态栏（`viewport-fit=cover`
     已经开了，但一个 `env(safe-area-inset-top)` 都没写）。
  3. 浮层高度用 `vh`：iOS 上地址栏算进去，抽屉底部被工具栏压住；补 `dvh`。
     另外 `.sheet .inner` 和 `.pop-in` 没算底部安全区，而闸门算了——三个底部浮层两套策略。
  4. `.audio-fab` 的 bottom 按 `env()` 走，而 body 为它预留的 170px 是死数：
     安全区 34px 的机型上浮标落在 156~194px，正好顶穿预留。
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


# ---- 1) 层级：全部走 token ----
one('position: sticky; top: 0; z-index: 20;',
    'position: sticky; top: 0; z-index: var(--z-top);', '顶栏')
one('position: fixed; inset: 0; z-index: 50; display: none;',
    'position: fixed; inset: 0; z-index: var(--z-sheet); display: none;', '设置浮层')
one('position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;',
    'position: fixed; left: 0; right: 0; bottom: 0; z-index: var(--z-tab);', '底部导航')
one('opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; z-index: 60;',
    'opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; z-index: var(--z-toast);',
    'toast（原来 60，跟 pop-sheet 撞）')
one('bottom: calc(74px + env(safe-area-inset-bottom)); z-index: 40;',
    'bottom: calc(74px + env(safe-area-inset-bottom)); z-index: var(--z-fab);', '卡住了浮标')
one('bottom: calc(122px + env(safe-area-inset-bottom)); z-index: 40;',
    'bottom: calc(122px + env(safe-area-inset-bottom)); z-index: var(--z-fab);', '声音浮标')
one('position: fixed; inset: 0; z-index: 80;',
    'position: fixed; inset: 0; z-index: var(--z-gate);', '闸门')
one('display: flex; align-items: flex-end; z-index: 60;',
    'display: flex; align-items: flex-end; z-index: var(--z-pop);', '"!"弹窗')

# ---- 2) 顶部安全区 ----
one('''  position: sticky; top: 0; z-index: var(--z-top);
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-3) var(--sp-4) var(--sp-2);''',
    '''  position: sticky; top: 0; z-index: var(--z-top);
  display: flex; align-items: center; justify-content: space-between;
  /* 顶部安全区：铺之前这里一个 env() 都没有，刘海机上顶栏会顶进状态栏 */
  padding: calc(var(--sp-3) + env(safe-area-inset-top)) var(--sp-4) var(--sp-2);''',
    '顶栏安全区')

# ---- 3) body 底部预留跟着安全区走 ----
one('  padding-bottom: 170px;\n  min-height: 100vh;',
    '  padding-bottom: calc(170px + env(safe-area-inset-bottom));\n  min-height: 100vh;',
    'body 预留（原来写死 170px，浮标却按 env() 算）')

# ---- 4) 浮层高度补 dvh ----
one('  max-height: 88vh; overflow-y: auto;',
    '  max-height: 88vh; max-height: 88dvh; overflow-y: auto;', '抽屉高度')
one('  width: 100%; max-height: 72vh; overflow-y: auto;',
    '  width: 100%; max-height: 72vh; max-height: 72dvh; overflow-y: auto;', '"!"弹窗高度')

# ---- 5) 两个底部浮层补底部安全区 ----
one('padding: var(--sp-4) var(--sp-4) var(--sp-6);\n  max-width: 720px; margin: 0 auto;',
    'padding: var(--sp-4) var(--sp-4) calc(var(--sp-6) + env(safe-area-inset-bottom));\n'
    '  max-width: 720px; margin: 0 auto;', '抽屉底部安全区')
one('background: var(--panel); border-radius: var(--r-lg) var(--r-lg) 0 0; '
    'padding: var(--sp-4) var(--sp-4) var(--sp-5);',
    'background: var(--panel); border-radius: var(--r-lg) var(--r-lg) 0 0;\n'
    '  padding: var(--sp-4) var(--sp-4) calc(var(--sp-5) + env(safe-area-inset-bottom));',
    '"!"弹窗底部安全区')

io.open(CSS, "w", encoding="utf-8", newline="\n").write(s)
print(f"结构修补完成，共 {n} 处")
