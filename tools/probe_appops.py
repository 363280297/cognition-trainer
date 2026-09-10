"""量一次「一个普通应用到底能看到多少别的东西」，再逐个 appops 关掉重量。

为什么要这个脚本（而不是直接写功能）：
   认知训练要加的「应用隔离」靠 appops。op 名字能不能被 appops 接受，命令行能验；
   但「接受了之后**真的拦住了吗**」命令行看不出来——那得有一个真以普通应用身份
   运行的进程去调 PackageManager / UsageStatsManager 才知道。
   这个项目有条规矩（写在 RootGate.java 里）：绝不能让「以为有保护、实际没有」
   的状态存在。所以先量，再决定哪个开关敢摆到设置页上。

用法：
    py -3 tools/probe_appops.py            # 完整跑：装探针 → 基线 → 逐项关 → 重测 → 还原
    py -3 tools/probe_appops.py --keep     # 跑完不卸载探针（留着手动玩）

产出：一张对照表，直接告诉我们每个 appop 值不值得做成开关。
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(r"E:\android-build")
APP = ROOT / "probe-app"
BUILD = ROOT / "probe-out"
SDK = ROOT / "sdk"
BT = SDK / "build-tools" / "34.0.0"
ANDROID_JAR = SDK / "platforms" / "android-34" / "android.jar"
JDK = ROOT / "jdk"
KEYSTORE = ROOT / "debug.keystore"
ADB = SDK / "platform-tools" / "adb.exe"
PKG = "com.local.eqprobe"
SRC = Path(__file__).resolve().parent / "probe_apk"

env = os.environ.copy()
env["JAVA_HOME"] = str(JDK)
env["PATH"] = str(JDK / "bin") + os.pathsep + env["PATH"]


def run(cmd, label=None, allow_fail=False):
    if label:
        print(f"\n--- {label} ---")
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                       env=env, errors="replace")
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    if r.returncode != 0 and not allow_fail:
        print(out[-3000:])
        sys.exit(f"!! 失败 (exit {r.returncode}): {' '.join(str(c) for c in cmd[:3])}")
    return out


def adb(*args, allow_fail=True):
    return run([ADB] + list(args), allow_fail=allow_fail)


def bat(tool):
    return ["cmd", "/c", str(tool)]


# ---------------------------------------------------------------- 构建探针
def build():
    if BUILD.exists():
        shutil.rmtree(BUILD)
    for d in ("gen", "obj", "dex"):
        (BUILD / d).mkdir(parents=True, exist_ok=True)
    if APP.exists():
        shutil.rmtree(APP)
    APP.mkdir(parents=True)
    shutil.copy(SRC / "AndroidManifest.xml", APP / "AndroidManifest.xml")
    shutil.copytree(SRC / "java", APP / "src")

    # 没有资源。aapt2 link 只给 manifest + android.jar 也能出 base.apk。
    run([BT / "aapt2.exe", "link",
         "-o", BUILD / "base.apk",
         "-I", ANDROID_JAR,
         "--manifest", APP / "AndroidManifest.xml",
         "--java", BUILD / "gen",
         "--min-sdk-version", "26", "--target-sdk-version", "34"],
        "aapt2 link（探针）")

    java_srcs = sorted(str(p) for p in (APP / "src").rglob("*.java"))
    r_java = BUILD / "gen" / PKG.replace(".", "/") / "R.java"
    if r_java.exists():
        java_srcs.append(str(r_java))
    run([JDK / "bin" / "javac.exe", "-encoding", "UTF-8", "--release", "11",
         "-classpath", str(ANDROID_JAR), "-d", BUILD / "obj"] + java_srcs,
        "javac（探针）")

    classes = [str(p) for p in (BUILD / "obj").rglob("*.class")]
    run(bat(BT / "d8.bat") + ["--lib", str(ANDROID_JAR), "--min-api", "26",
                              "--output", str(BUILD / "dex")] + classes,
        "d8（探针）")

    unsigned = BUILD / "unsigned.apk"
    shutil.copy(BUILD / "base.apk", unsigned)
    with zipfile.ZipFile(unsigned, "a") as z:
        z.write(BUILD / "dex" / "classes.dex", "classes.dex")
    aligned = BUILD / "aligned.apk"
    run([BT / "zipalign.exe", "-f", "-p", "4", unsigned, aligned], "zipalign（探针）")
    out = BUILD / "eqprobe.apk"
    if not KEYSTORE.exists():
        sys.exit("!! 找不到 E:\\android-build\\debug.keystore（先跑一次 build_apk.py）")
    run(bat(BT / "apksigner.bat") + ["sign", "--ks", str(KEYSTORE),
                                     "--ks-pass", "pass:android", "--key-pass", "pass:android",
                                     "--min-sdk-version", "26", "--out", str(out), str(aligned)],
        "apksigner（探针）")
    return out


# ---------------------------------------------------------------- 量一次
FIELDS = [
    "installedPackages", "installedApplications", "其中系统应用", "QUERY_ALL_PACKAGES权限",
    "指定包可见性",
    "用量统计条数", "queryUsageStats 里有前台时长的", "切换事件条数",
    "getRunningAppProcesses", "其中别的 UID 的进程", "getRunningTasks",
    "MediaProjectionManager", "captureIntent",
    "系统里已启用的无障碍服务",
    "A-读应用", "B-用量统计", "C-运行进程", "D-截屏", "E-无障碍",
    "/proc 条目总数", "/proc 里纯数字目录", "/proc 里能读出 cmdline 的",
    "/proc 里读到自己的", "/proc 里读到**别的**进程的名字", "/proc 别的进程样例",
    "FLAG_STOPPED", "自己的退出历史条数", "别家的退出历史条数",
    "F-/proc", "G-停止标志", "H-退出历史",
]
# 这些是"被拦住"的标记，出现即算变化
BLOCK_MARK = "被拦住"


def measure(label):
    """重启探针、抓 logcat、把数字读回来。"""
    adb("shell", "am", "force-stop", PKG)
    adb("logcat", "-c")
    adb("shell", "am", "start", "-n", f"{PKG}/.EqProbe")
    run([str(ADB), "shell", "sleep", "2"], allow_fail=True)
    log = adb("logcat", "-d", "-s", "EQPROBE")
    vals = {}
    for line in log.splitlines():
        m = re.search(r"EQPROBE\s*:\s*([^=]+)=(.*)$", line)
        if m:
            vals[m.group(1).strip()] = m.group(2).strip()
    print(f"\n[{label}]")
    for f in FIELDS:
        if f in vals:
            print(f"    {f:34s} {vals[f]}")
    return vals


# ---------------------------------------------------------------- 各项 appop
# 只测我们真打算做成开关的那些。mode 用 deny（"不允许"）。
TRIALS = [
    ("读到别的应用", "QUERY_ALL_PACKAGES"),
    ("后台在跑什么（用量统计）", "GET_USAGE_STATS"),
    ("后台运行", "RUN_ANY_IN_BACKGROUND"),
    ("从后台弹界面", "SYSTEM_ALERT_WINDOW"),
    ("截屏录屏", "PROJECT_MEDIA"),
    ("剪贴板", "READ_CLIPBOARD"),
]


def set_op(op, mode="deny"):
    """关掉一个 op。返回 (是否真的生效, appops get 的原话)。

    有几种写法：`appops set <pkg>` 和 `appops set --uid <pkg>`。
    实测 SYSTEM_ALERT_WINDOW 用前者写不进去（get 回来还是 default），
    所以两种都试，记下哪种有效——不然会出现"界面上显示已关、其实没关"。
    """
    adb("shell", "appops", "set", PKG, op, mode)
    got = adb("shell", "appops", "get", PKG, op).strip()
    if "Unknown operation" in got:
        return None, got
    if f"{op}: {mode}" in got:
        return "包名", got
    adb("shell", "appops", "set", "--uid", PKG, op, mode)
    got2 = adb("shell", "appops", "get", PKG, op).strip()
    if f"{op}: {mode}" in got2:
        return "--uid", got2
    return False, got2


def main():
    keep = "--keep" in sys.argv
    print("=" * 70)
    print("appops 效果实测（探针 App，不是认知训练的一部分）")
    print("=" * 70)

    apk = build()
    print(f"\n--- 安装探针 ---\n{adb('install', '-r', str(apk), allow_fail=False)}")

    base = measure("基线：什么限制都没有")

    results = []
    for title, op in TRIALS:
        adb("shell", "appops", "reset", PKG)
        how, got = set_op(op)
        if how is None:
            print(f"\n[{title}] appops 不认 op 名 {op} —— 做不了开关")
            results.append((title, op, None, None, None))
            continue
        if how is False:
            print(f"\n[{title}] 写了但没生效（{got.splitlines()[0] if got else '空'}）—— 做不了开关")
            results.append((title, op, False, None, None))
            continue
        v = measure(f"{title} → 用 `appops set {'--uid ' if how == '--uid' else ''}"
                    f"{PKG} {op} deny` 写进去了（{how}）")
        results.append((title, op, how, got, v))

    adb("shell", "appops", "reset", PKG)
    print("\n" + "=" * 70)
    print("结论")
    print("=" * 70)
    usable = []
    for title, op, how, got, v in results:
        if how is None:
            print(f"  {op:24s} ✗ op 名系统不认")
            continue
        if how is False:
            print(f"  {op:24s} ✗ 写不进去（系统不接受 deny）")
            continue
        diffs = []
        for k in base:
            if k == "done":
                continue
            a, b = base.get(k), v.get(k)
            if a == b:
                continue
            blocked = b and BLOCK_MARK in str(b)
            diffs.append(f"{'【拦住了】' if blocked else ''}{k}: {a} → {b}")
        if diffs:
            usable.append(op)
            print(f"  {op:24s} ✓ 有效（{title}）")
            for d in diffs:
                print(f"        {d}")
        else:
            print(f"  {op:24s} ✗ 数字一个都没变 —— 在这个安卓版本上等于没有保护")
            print(f"        （op 确实写进去了：{got.splitlines()[0] if got else ''}）")

    # ------------------------------------------------------------------
    # 最要紧的那一项单独做一次 allow → deny 的对照。
    #
    # 为什么不能只看"关掉之后数字变了没有"：基线里「用量统计条数」本来就是 0
    # （新装的 App 没有用量访问权），关掉之后也是 0 —— 看起来"没变化"，
    # 但那证明不了任何事。必须**先把它打开、确认它真的读到了东西**，
    # 再关掉、确认它读不到了。这才叫证明了一个开关有用。
    # 这一条正是给「后台在跑什么」用的那个 op。
    # ------------------------------------------------------------------
    print("\n" + "=" * 70)
    print("单独验证 GET_USAGE_STATS（先打开→确认能读，再关掉→确认读不到）")
    print("=" * 70)
    adb("shell", "appops", "reset", PKG)
    adb("shell", "appops", "set", PKG, "GET_USAGE_STATS", "allow")
    on = measure("用量访问 = allow")
    adb("shell", "appops", "set", PKG, "GET_USAGE_STATS", "deny")
    off = measure("用量访问 = deny")

    def num(d, k):
        try:
            return int(d.get(k, -1))
        except (TypeError, ValueError):
            return -1

    can_read = num(on, "用量统计条数") > 0
    blocked = off.get("B-用量统计") and BLOCK_MARK in str(off.get("B-用量统计"))
    print(f"\n  打开时：用量统计条数 = {on.get('用量统计条数')}，"
          f"切换事件条数 = {on.get('切换事件条数')}")
    print(f"  关掉时：{off.get('B-用量统计', '（还读得到）')}")
    if can_read and blocked:
        print("  → ✓ 确认有效：打开时真能读到别家的用量，关掉之后直接抛异常")
        if "GET_USAGE_STATS" not in usable:
            usable.append("GET_USAGE_STATS")
    elif can_read:
        print("  → ✗ 打开时能读，关掉之后**没被拦住** —— 不能当保护用")
    else:
        print("  → ? 打开时也没读到东西（模拟器里可能本来就没有用量记录），"
              "这一次证明不了，别当成有效")

    adb("shell", "appops", "reset", PKG)
    if keep:
        print("\n（--keep：探针留在机器上）")
    else:
        adb("shell", "pm", "uninstall", PKG)
        print("\n探针已卸载、appops 已 reset。")
    print(f"\n真正能用的开关：{', '.join(usable) if usable else '（一个都没有）'}")

if __name__ == "__main__":
    main()

