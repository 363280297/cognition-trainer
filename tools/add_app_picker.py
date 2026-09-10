# -*- coding: utf-8 -*-
"""闸门目标应用改成「从已安装应用里挑」。

用户的原话：「闸门的设置，那个包名太麻烦了，你反正给了你应用读取的功能，
你直接读取应用，然后我告诉你选哪些就行。」

原来只有一个输入框要手打包名。手打的失败方式很难受也很隐蔽：
打错一个字母，闸门永远不触发，而界面上没有任何异常——只会让人觉得这功能没用。
现在改成：读一份有启动图标的应用清单，搜索、点选，选中的打勾。

几个刻意的取舍：

1. **手输的入口保留**，但收进「手动填包名」的折叠里。有些目标确实没有启动图标
   （双开的应用、系统隐藏的入口、用其它用户配置装的），全砍掉就等于把这条路堵死。
2. **多选，不是选一个**。用户说的是「我告诉你选哪些」——一次挑完。
3. **点一下立刻存**，不是等「完成」才提交。用户可能挑到一半接个电话就退出去了，
   等提交的写法会把已经挑的那几个全丢掉。
4. **没读到任何应用时要说清楚**，并指出手输那条路还在。返回空数组的原因可能是
   机型限制或包可见性，这时静默显示一个空列表等于让人以为坏了。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = os.path.join(ROOT, 'public', 'app.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    s = io.open(AP, encoding='utf-8').read()

    # ---------------- 设置页那一块：主入口换成挑应用 ----------------
    s = sub(s, """        <div class="plan-row" style="margin-top:10px">
          <span>包名</span>
          <input id="addPkg" type="text" placeholder="com.tencent.tmgp.sgame（王者荣耀）">
        </div>
        <div class="row"><button class="ghost" onclick="addGatePkg()">加一个</button>
          <button class="plain" onclick="toggleGate()">${g.enabled ? '关掉闸门' : '开启闸门'}</button></div>
        ${(g.packages || []).length ? `<div class="idn-list">
          ${g.packages.map((p) => `<div class="idn-item"><div class="mono-line">${esc(p)}</div>
            <div class="hint"><button class="plain tiny" onclick="dropGatePkg('${esc(p)}')">删掉</button></div></div>`).join('')}
        </div>` : '<p class="hint" style="margin-top:8px">还没加目标应用。加错包名闸门就不会触发。</p>'}""",
            """        <div class="row">
          <button class="primary" onclick="openAppPicker()">从已安装应用里挑</button>
        </div>
        <div class="row">
          <button class="plain" onclick="toggleGate()">${g.enabled ? '关掉闸门' : '开启闸门'}</button>
        </div>
        ${(g.packages || []).length ? `<div class="idn-list">
          ${g.packages.map((p) => `<div class="idn-item"><div class="mono-line">${esc(p)}</div>
            <div class="hint"><button class="plain tiny" onclick="dropGatePkg('${esc(p)}')">删掉</button></div></div>`).join('')}
        </div>` : '<p class="hint" style="margin-top:8px">还没加目标应用。</p>'}
        <details class="diag-more" style="margin-top:8px">
          <summary>手动填包名（没有启动图标的应用才需要）</summary>
          <div class="plan-row" style="margin-top:8px">
            <span>包名</span>
            <input id="addPkg" type="text" placeholder="com.tencent.tmgp.sgame">
          </div>
          <div class="row"><button class="ghost" onclick="addGatePkg()">加一个</button></div>
        </details>""", tag='gateBlock')

    # 原来那段「查包名」的说明改成对应新的做法
    s = sub(s, """        <p class="hint" style="margin-top:10px">
          查包名：设置 → 应用管理 → 找到那个游戏 → 看「应用包名」。或者连电脑后
          <span class="mono-line">adb shell pm list packages | findstr 关键词</span>
        </p>""",
            """        <p class="hint" style="margin-top:10px">
          挑应用等同于原来手填包名，只是不用去系统设置里找了。
          列表里只有**有启动图标的应用**（也就是你能从桌面点开的那些）；
          双开、隐藏入口之类的应用不在里面，那种用手动填包名。
        </p>""", tag='help')

    # ---------------- 挑应用的面板 ----------------
    s = sub(s, """function addGatePkg() {""", """/* 应用清单缓存。挑应用这个面板会被反复打开（挑一个 → 关掉 → 再挑一个），
   每次都去问一次原生没必要，而且列表长的话会有可见的延迟。 */
let PKG_LIST = null;

function openAppPicker() {
  if (!window.EQNative || !EQNative.listApps) {
    toast('这个功能只在 Android App 里可用');
    return;
  }
  const sh = document.createElement('div');
  sh.className = 'sheet open';
  sh.id = 'pkgSheet';
  sh.innerHTML = `<div class="inner" onclick="event.stopPropagation()">
    <button class="ghost" style="float:right" onclick="closePicker()">关闭</button>
    <h2 style="margin:10px 0 6px">挑要拦的应用</h2>
    <p class="hint" id="pkgCount" style="margin-bottom:10px"></p>
    <input type="text" id="pkgSearch" placeholder="搜应用名或包名"
      oninput="filterPkgs()" style="margin-bottom:10px">
    <div id="pkgList"><p class="hint">正在读取已安装的应用…</p></div>
  </div>`;
  sh.addEventListener('click', closePicker);
  document.body.appendChild(sh);

  const draw = (apps, note) => {
    const box = document.getElementById('pkgList');
    if (!box) return;
    const sel = (state.gate && state.gate.packages) || [];
    if (!apps.length) {
      box.innerHTML = `<p class="hint">${note || '没有读到任何应用。'}</p>
        <p class="hint">上面「手动填包名」那条路仍然可用。</p>`;
      updatePkgCount();
      return;
    }
    box.innerHTML = `<div class="pkg-list">${apps.map((a) => `
      <button class="pkg-item ${sel.includes(a.pkg) ? 'on' : ''}" data-pkg="${esc(a.pkg)}"
        onclick="togglePickPkg('${esc(a.pkg)}')">
        <span class="pkg-label">${esc(a.label)}</span>
        <span class="pkg-mark">${sel.includes(a.pkg) ? '已选' : ''}</span>
        <span class="pkg-pkg">${esc(a.pkg)}</span>
      </button>`).join('')}</div>`;
    updatePkgCount();
  };

  if (PKG_LIST) { draw(PKG_LIST); return; }
  try {
    // 有些机型读列表要一会儿，所以先画「正在读取」，再同步替换
    const raw = EQNative.listApps();
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch (e) { arr = []; }
    PKG_LIST = Array.isArray(arr) ? arr : [];
    draw(PKG_LIST, '没有读到任何应用——可能是这台手机限制了应用列表。');
  } catch (e) {
    draw([], '读取失败：' + (e.message || e));
  }
}

function updatePkgCount() {
  const el = document.getElementById('pkgCount');
  if (!el) return;
  const n = ((state.gate && state.gate.packages) || []).length;
  el.textContent = n ? `已经选了 ${n} 个。点一下切换选中，选完直接关掉就行。`
    : '选中的应用会在你达标之前被拦住。点一下选中。';
}

/** 只改这一行的样式，不重画整个列表——重画会丢掉滚动位置和搜索词，
    而这个列表可能有一两百项，用户正挑到一半时被弹回顶部很难受。 */
function togglePickPkg(pkg) {
  state.gate = state.gate || { enabled: false, packages: [] };
  const has = state.gate.packages.includes(pkg);
  if (has) state.gate.packages = state.gate.packages.filter((p) => p !== pkg);
  else state.gate.packages.push(pkg);
  // 挑到一半接个电话就退出去了，所以点一下立刻存，不攒到「完成」才提交
  if (state.gate.packages.length) state.gate.enabled = true;
  save();
  syncGate();
  const btn = document.querySelector(`.pkg-item[data-pkg="${pkg}"]`);
  if (btn) {
    btn.classList.toggle('on', !has);
    const m = btn.querySelector('.pkg-mark');
    if (m) m.textContent = has ? '' : '已选';
  }
  updatePkgCount();
}

function filterPkgs() {
  const el = document.getElementById('pkgSearch');
  const q = (el && el.value || '').trim().toLowerCase();
  const all = PKG_LIST || [];
  const hit = !q ? all
    : all.filter((a) => (a.label || '').toLowerCase().includes(q)
      || (a.pkg || '').toLowerCase().includes(q));
  const box = document.getElementById('pkgList');
  if (!box) return;
  if (!hit.length) { box.innerHTML = `<p class="hint">没有匹配「${esc(q)}」的应用。</p>`; return; }
  const sel = (state.gate && state.gate.packages) || [];
  box.innerHTML = `<div class="pkg-list">${hit.map((a) => `
    <button class="pkg-item ${sel.includes(a.pkg) ? 'on' : ''}" data-pkg="${esc(a.pkg)}"
      onclick="togglePickPkg('${esc(a.pkg)}')">
      <span class="pkg-label">${esc(a.label)}</span>
      <span class="pkg-mark">${sel.includes(a.pkg) ? '已选' : ''}</span>
      <span class="pkg-pkg">${esc(a.pkg)}</span>
    </button>`).join('')}</div>`;
}

/** 关掉面板并回到设置页——挑完要能立刻看见「打勾才能打开的应用」里那几条。 */
function closePicker() {
  const sh = document.getElementById('pkgSheet');
  if (sh) sh.remove();
  openDailySettings();
}

function addGatePkg() {""", tag='picker')

    io.open(AP, 'w', encoding='utf-8').write(s)

    # ---------------- CSS ----------------
    css = io.open(os.path.join(ROOT, 'public', 'style.css'), encoding='utf-8').read()
    css += """
/* ---------- 挑要拦的应用 ---------- */
.pkg-list { max-height: 56vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.pkg-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  gap: 2px 10px; width: 100%; text-align: left; font: inherit;
  background: var(--panel2); border: 1px solid var(--line); border-radius: 11px;
  padding: 10px 12px; margin-bottom: 7px; cursor: pointer;
}
.pkg-item.on { background: #1e2e26; border-color: var(--good); }
.pkg-label { font-size: .9rem; font-weight: 600; color: var(--text); }
.pkg-mark { font-size: .72rem; color: var(--good); font-weight: 600; justify-self: end; }
.pkg-pkg {
  grid-column: 1 / -1; font-size: .68rem; color: var(--dim);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
#pkgSearch {
  width: 100%; font: inherit; font-size: .88rem; color: var(--text);
  background: var(--panel2); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 12px;
}
#pkgSearch:focus { outline: none; border-color: #4a7ba8; }
"""
    io.open(os.path.join(ROOT, 'public', 'style.css'), 'w', encoding='utf-8').write(css)
    print('闸门目标改成从已安装应用里挑（保留了手动填包名的折叠入口）')


if __name__ == '__main__':
    main()
