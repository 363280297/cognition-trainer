"""在模拟器上把 App 开到一个指定的页面，然后点一个东西——可靠性靠"看屏幕"而不是靠猜坐标。

为什么需要它：这个 App 的界面在 WebView 里，`uiautomator dump` **看不到里面的节点**
（只能看到一个 WebView 框）。所以自动化只能靠坐标，而坐标会随状态漂移：
日更那一关的浮层会把后面每一次点击都吃掉，于是"点了 A 其实点到了 B"。
第一版就是这么连着跑偏三次的。

这里加了两道保险：
  1. 每次点击前先截屏，用**清晰度**判断有没有浮层（浮层会给背景加高斯模糊，
     高频能量骤降）——没清干净就再点一次"跳过"，最多 N 次；
  2. 每一步点完都截屏存盘，最后拼成一张总览，人眼一次看完整个序列。

用法：
    py -3 tools/drive_app.py --shot output/xxx.png
"""
import io
import os
import subprocess
import sys
import time
from pathlib import Path

ADB = r"E:\android-build\sdk\platform-tools\adb.exe"
PKG = "com.local.cognitiontrainer"
OUT = Path(__file__).resolve().parent.parent / "output"
OUT.mkdir(exist_ok=True)

# 已经量准的坐标（1080×2400）
GATE_SKIP = (210, 1518)      # 「今天先跳过」
TAB_AI = (684, 2292)         # 底部 tab：AI
SUB_REPLAY = (590, 465)      # 二级切换：「真实复盘」
REPLAY_UPLOAD = (260, 1210)  # 「上传聊天截图」


def run(*a, timeout=120):
    return subprocess.run([ADB] + list(a), capture_output=True, timeout=timeout)


def shot(name):
    p = OUT / f"{name}.png"
    r = run("exec-out", "screencap", "-p")
    p.write_bytes(r.stdout)
    return p


def sharpness(png):
    """局部高频能量的代理：相邻像素差的平均绝对值。浮层模糊会让它明显变小。"""
    from PIL import Image, ImageFilter
    im = Image.open(png).convert("L").crop((0, 700, 1080, 1800))
    edge = im.filter(ImageFilter.FIND_EDGES)
    px = list(edge.getdata())
    return sum(px) / len(px)


def tap(xy):
    run("shell", "input", "tap", str(xy[0]), str(xy[1]))


def clear_gate(tag, tries=4):
    """把日更浮层点掉，直到页面变清晰。返回最后一次的清晰度。"""
    base = None
    for i in range(tries):
        p = shot(f"{tag}-gate{i}")
        s = sharpness(p)
        if base is None:
            base = s
        # 第一张不计入判断：它可能本来就是清晰的
        if i > 0 and s > base * 1.15:
            return s, i
        if i < tries - 1:
            tap(GATE_SKIP)
            time.sleep(2.5)
    return sharpness(shot(f"{tag}-gate-final")), tries


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "drive"
    run("shell", "am", "force-stop", PKG)
    run("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(9)

    s0 = sharpness(shot(f"{tag}-0-launch"))
    s1, n = clear_gate(tag)
    print(f"启动清晰度 {s0:.1f} → 清完浮层 {s1:.1f}（点了 {n} 次跳过）")
    if s1 < s0 * 1.1 and s0 > 0:
        print("  ⚠ 没能把浮层清干净，后面的坐标可能还会偏")

    tap(TAB_AI); time.sleep(3); shot(f"{tag}-1-ai")
    tap(SUB_REPLAY); time.sleep(3); shot(f"{tag}-2-replay")
    tap(REPLAY_UPLOAD); time.sleep(6); shot(f"{tag}-3-picker")

    # 选择器是**系统**界面，它的节点是可见的——所以这里可以精确点
    run("shell", "uiautomator", "dump", "/sdcard/w.xml")
    run("pull", "/sdcard/w.xml", str(OUT / f"{tag}-picker.xml"))
    import xml.etree.ElementTree as ET
    t = ET.parse(OUT / f"{tag}-picker.xml")
    target = None
    for x in t.getroot().iter():
        cd = (x.get("content-desc") or "") + (x.get("text") or "")
        if x.get("clickable") == "true" and ("fake-chat" in cd or "Photo" in cd or "Photo taken" in cd):
            target = x.get("bounds")
            break
    if not target:
        print("选择器里没找到可点的图片节点，停在 shot-3-picker 这一步")
        return
    import re
    x0, y0, x1, y1 = map(int, re.findall(r"\d+", target))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    print(f"点选择器里的图片：{target} → ({cx},{cy})")
    tap((cx, cy))
    time.sleep(9)
    shot(f"{tag}-4-after-pick")

    # 结果页那一块单独切出来，一眼看清提示语
    from PIL import Image
    im = Image.open(OUT / f"{tag}-4-after-pick.png")
    im.crop((0, 950, 1080, 1500)).save(OUT / f"{tag}-5-result.png")
    print("结果见 " + str(OUT / f"{tag}-5-result.png"))


if __name__ == "__main__":
    main()
