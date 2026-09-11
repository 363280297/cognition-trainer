"""手工构建 Android APK（不依赖 Gradle / Android Gradle Plugin）。

流程：aapt2 编译资源 → aapt2 链接出 base.apk → javac 编译 → d8 出 dex
     → 把 dex 塞进 apk → zipalign → apksigner 签名 → 校验

用 Python 驱动是为了避开 Windows 批处理里路径和引号的各种坑。
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(r"E:\android-build")
APP = ROOT / "app"
BUILD = ROOT / "out"
SDK = ROOT / "sdk"
BT = SDK / "build-tools" / "34.0.0"
ANDROID_JAR = SDK / "platforms" / "android-34" / "android.jar"
JDK = ROOT / "jdk"
KEYSTORE = ROOT / "debug.keystore"
PACKAGE = "com.local.cognitiontrainer"
APP_NAME = "认知训练"
MIN_SDK, TARGET_SDK = 26, 34

# APK 的内容就是 build_offline.py 生成的那个单文件 HTML。
# 这一步以前靠手动拷贝，结果打过一次 8 分钟前的老版本还被报成「构建完成」——
# 所以现在改成构建时自己同步，并在下面校验字节一致。
OFFLINE_HTML = Path(__file__).resolve().parent.parent / "认知训练-离线版.html"
ASSETS_INDEX = APP / "assets" / "index.html"

# 2.30 曾经把开源的 Vosk（离线中文识别）连模型一起打进来过，APK 因此涨到 48MB。
# 2.31 按用户要求把「听你说话」整块删掉（原话「我直接打字算了」），打包也一起撤了：
# 不再需要 vendor/ 里的 jar、.so 和那个 42MB 的模型。
# **但那套东西仍然留在 android/vendor/ 里**（见那里的 README）：以后想找回语音输入
# 不用重新下载。构建时会反过来断言 APK 里没有它们，免得哪天又悄悄背回 42MB。
REPO_ANDROID_DIR = Path(__file__).resolve().parent
VENDOR = REPO_ANDROID_DIR / "vendor"
VENDOR_JARS = [VENDOR / "libs" / "vosk.jar", VENDOR / "libs" / "jna.jar"]
VENDOR_JNI = VENDOR / "jni"                       # <abi>/libvosk.so, libjnidispatch.so
MODEL_ASSET = VENDOR / "model" / "vosk-model-cn.zip"

env = os.environ.copy()
env["JAVA_HOME"] = str(JDK)
env["PATH"] = str(JDK / "bin") + os.pathsep + env["PATH"]


def run(cmd, label, allow_fail=False):
    printable = " ".join(str(c) for c in cmd)
    print(f"\n--- {label} ---\n$ {printable}")
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                       env=env, errors="replace")
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if out:
        print(out[-2000:])
    if err:
        print(err[-2000:])
    if r.returncode != 0 and not allow_fail:
        sys.exit(f"!! {label} 失败 (exit {r.returncode})")
    return r


def bat(tool):
    """build-tools 里有些是 .bat 包装，Windows 上必须经 cmd /c 调用。"""
    return ["cmd", "/c", str(tool)]


# ---------------------------------------------------------------- 清理
if BUILD.exists():
    shutil.rmtree(BUILD)
for d in ("gen", "obj", "dex"):
    (BUILD / d).mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------- 0 同步网页内容
if not OFFLINE_HTML.exists():
    sys.exit(f"!! 找不到 {OFFLINE_HTML}\n   先跑 `py -3 build_offline.py` 再构建 APK。")

# 网页那一半的源码改了、离线版 HTML 没重生成 —— 这里必须拦住。
#
# 为什么：这个脚本只**拷贝**离线版 HTML，它自己不会重新生成。所以改了
# public/*.js 之后直接构建，会打出一个「原生是新的、网页是旧的」的包，
# 而构建日志一切正常（体积、权限、条目全对）。这个坑真的踩到了：
# 在 __onShot 里加的一行调试输出根本没进包，却在模拟器上排查了半天
# 「为什么提示语不对」——因为跑的是上一个版本的 JS。
#
# 判据用的是 build_offline.py 写下的同一个指纹（输入文件的名字+字节），
# 它原本只有 verify_offline.js 在读；但那时已经构建完了，太晚。
_SRC_STAMP = OFFLINE_HTML.parent / "认知训练-离线版.src.txt"


def _stamp_hash():
    """重算 build_offline.py 那个指纹。返回 (算出来的, 记下来的)。"""
    import hashlib
    if not _SRC_STAMP.exists():
        return None, None
    lines = [l.strip() for l in _SRC_STAMP.read_text(encoding="utf-8").splitlines() if l.strip()]
    if len(lines) < 3:
        return None, None
    want = lines[0]
    h = hashlib.sha256()
    for rel in lines[2:]:
        p = OFFLINE_HTML.parent / rel
        if not p.exists():
            return None, want
        # 用 basename：build_offline.py 那边 update 的就是 _p.name
        h.update(p.name.encode("utf-8"))
        h.update(p.read_bytes())
    return h.hexdigest(), want


_got, _want = _stamp_hash()
if _got is None or _want is None:
    print("\n⚠ 读不出离线版的输入指纹（缺 认知训练-离线版.src.txt），"
          "没法证明这份 HTML 是最新的。先跑 py -3 build_offline.py。")
elif _got != _want:
    sys.exit(
        "!! 离线版 HTML 已经过期：public/ 或 data/ 里的源码改过了，但没重新生成。\n"
        f"   记下来的指纹 {_want[:16]}… / 现在算出来 {_got[:16]}…\n"
        "   直接构建会打出一个「原生新、网页旧」的包。\n"
        "   先跑 `py -3 build_offline.py` 再构建。")
else:
    print(f"\n--- 离线版新鲜度 ---\n指纹一致 {_got[:16]}…")

ASSETS_INDEX.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(OFFLINE_HTML, ASSETS_INDEX)
# 清掉 2.30 留在构建树里的那个 42MB 离线识别模型。
# assets/ 是整包带进去的：文件要是留在那儿，它会**继续被打进 APK**，而构建日志
# 一切正常——实测被下面的 stray 断言抓到过一次（APK 又变成 42MB）。
_stale_model = APP / "assets" / "vosk-model-cn.zip"
if _stale_model.exists():
    _stale_model.unlink()
    print("\n（清掉构建树里残留的 vosk-model-cn.zip：2.30 的离线识别模型，已不再打进包）")
src_bytes = OFFLINE_HTML.read_bytes()
print(f"\n--- 同步 assets/index.html ---\n"
      f"$ {OFFLINE_HTML} -> {ASSETS_INDEX}\n"
      f"  {len(src_bytes)} 字节")
if ASSETS_INDEX.read_bytes() != src_bytes:
    sys.exit("!! assets/index.html 与离线版不一致，构建中止（否则会打出一个旧版本）")

# ---------------------------------------------------- 0.5 同步原生源码（同一个坑）
# 原生代码的唯一来源是仓库里的 eq-app/android/（src、res、AndroidManifest.xml）；
# E:\android-build\app 只是编译用的工作区。构建时从这里同步过去。
#
# 为什么也要自动同步：这里踩过一次和 index.html **一模一样**的坑。我在仓库里改了
# MainActivity（加了音乐和识别探测），构建却从 E:\android-build\app 读源码，
# 于是脚本一路绿灯打印「构建完成」，而打出来的 APK 里那几行根本不存在——
# 两种拷贝迟早会漂移，能防住它的不是"记得同步"，是"没有第二份"。
REPO_ANDROID = Path(__file__).resolve().parent
SYNC_DIRS = ("src", "res")
SYNC_FILES = ("AndroidManifest.xml",)
synced = []
for name in SYNC_DIRS:
    src_dir = REPO_ANDROID / name
    if not src_dir.is_dir():
        sys.exit(f"!! 找不到 {src_dir}（原生源码应该在仓库里）")
    dst_dir = APP / name
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    synced += [p for p in dst_dir.rglob("*") if p.is_file()]
for name in SYNC_FILES:
    src_file = REPO_ANDROID / name
    if not src_file.is_file():
        sys.exit(f"!! 找不到 {src_file}")
    shutil.copy(src_file, APP / name)
    synced.append(APP / name)
print(f"\n--- 同步原生源码 ---\n$ {REPO_ANDROID} -> {APP}\n"
      f"  {len(synced)} 个文件：" + "、".join(sorted(p.name for p in synced)))

# 同步完再逐个字节核对一遍。拷贝本身出错（磁盘满、被杀进程）时，
# 后面会打出一个"半新半旧"的 APK，那种最难查——所以这里直接拦住。
for p in synced:
    rel = p.relative_to(APP)
    a = (REPO_ANDROID / rel).read_bytes()
    if p.read_bytes() != a:
        sys.exit(f"!! 同步后不一致：{rel}")
print("  逐字节核对：通过")

# ---------------------------------------------------------------- 1 编译资源
run([BT / "aapt2.exe", "compile", "--dir", APP / "res", "-o", BUILD / "res.zip"],
    "aapt2 compile（编译资源）")

# ---------------------------------------------------------------- 2 链接
run([BT / "aapt2.exe", "link",
     "-o", BUILD / "base.apk",
     "-I", ANDROID_JAR,
     "--manifest", APP / "AndroidManifest.xml",
     "-A", APP / "assets",
     "--java", BUILD / "gen",
     "--min-sdk-version", str(MIN_SDK),
     "--target-sdk-version", str(TARGET_SDK),
     "--no-version-vectors",
     BUILD / "res.zip"],
    "aapt2 link（链接出 base.apk）")

r_java = BUILD / "gen" / PACKAGE.replace(".", "/") / "R.java"
if not r_java.exists():
    sys.exit(f"!! 没生成 R.java: {r_java}")

# ---------------------------------------------------------------- 3 javac
# 不要写死文件名。原来只列了 MainActivity.java，加了 GateService / ReminderReceiver /
# Prefs 之后编译器报「找不到符号」，而报错信息指向的是调用处，看半天看不出是没编译进来。
# 改成自动收集 src 下所有 .java，新增源文件就自动生效。
java_srcs = sorted(glob.glob(str(APP / "src" / "**" / "*.java"), recursive=True)) + [str(r_java)]
print(f"\n（Java 源文件 {len(java_srcs) - 1} 个）")
for _s in java_srcs[:-1]:
    print("  " + Path(_s).name)
run([JDK / "bin" / "javac.exe", "-encoding", "UTF-8", "--release", "11",
     "-classpath", str(ANDROID_JAR),
     "-d", BUILD / "obj"] + java_srcs,
    "javac（编译 Java）")

# ---------------------------------------------------------------- 4 d8 → dex
classes = glob.glob(str(BUILD / "obj" / "**" / "*.class"), recursive=True)
print(f"\n（class 文件 {len(classes)} 个）")
run(bat(BT / "d8.bat") + ["--lib", str(ANDROID_JAR), "--min-api", str(MIN_SDK),
                          "--output", str(BUILD / "dex")]
    + classes,
    "d8（生成 classes.dex）")

dex = BUILD / "dex" / "classes.dex"
if not dex.exists():
    sys.exit("!! 没生成 classes.dex")

# ---------------------------------------------------------------- 5 塞进 apk
unsigned = BUILD / "unsigned.apk"
shutil.copy(BUILD / "base.apk", unsigned)
with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("\n--- 注入 classes.dex ---\n  已写入 %.0f KB" % (dex.stat().st_size / 1024))

# ---------------------------------------------------------------- 6 zipalign
aligned = BUILD / "aligned.apk"
run([BT / "zipalign.exe", "-f", "-p", "4", unsigned, aligned], "zipalign（对齐）")

# ---------------------------------------------------------------- 7 签名
if not KEYSTORE.exists():
    run([JDK / "bin" / "keytool.exe", "-genkeypair",
         "-keystore", KEYSTORE, "-storepass", "android", "-keypass", "android",
         "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
         "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US"],
        "keytool（生成调试签名证书）")

signed = ROOT / f"{APP_NAME}.apk"
run(bat(BT / "apksigner.bat") + ["sign",
                                 "--ks", str(KEYSTORE),
                                 "--ks-pass", "pass:android",
                                 "--key-pass", "pass:android",
                                 "--min-sdk-version", str(MIN_SDK),
                                 "--out", str(signed),
                                 str(aligned)],
    "apksigner（签名）")

# ---------------------------------------------------------------- 8 校验
run(bat(BT / "apksigner.bat") + ["verify", "--verbose", "--print-certs", str(signed)],
    "apksigner verify（校验签名）")

with zipfile.ZipFile(signed) as z:
    names = z.namelist()
    need = ["AndroidManifest.xml", "classes.dex", "assets/index.html", "resources.arsc"]
    missing = [n for n in need if n not in names]
    mipmaps = sorted(n for n in names if n.startswith("res/") and "ic_launcher" in n)
    packed_html = z.read("assets/index.html")

# 打进去的内容必须和离线版逐字节一致。这一步是为了堵住「拿旧 HTML 打新包」那个坑：
# 版本号、权限、签名全都正常，只有内容是老的，光看构建日志看不出来。
html_same = packed_html == src_bytes

# 权限要真的读出来，不要在输出里写死——之前写死过一次，结果加了权限还显示"无"
perms = []
pr = subprocess.run([str(BT / "aapt2.exe"), "dump", "permissions", str(signed)],
                    capture_output=True, text=True, errors="replace")
for line in (pr.stdout or "").splitlines():
    line = line.strip()
    if line.startswith("uses-permission"):
        perms.append(line.split("name=")[-1].strip().strip("'"))

print("\n" + "=" * 60)
print("构建完成")
print("=" * 60)
print(f"  文件      : {signed}")
print(f"  体积      : {signed.stat().st_size/1024/1024:.2f} MB")
print(f"  包名      : {PACKAGE}")
print(f"  minSdk    : {MIN_SDK}   targetSdk: {TARGET_SDK}")
print(f"  关键条目  : {', '.join(need)}")
print(f"  缺失条目  : {missing or '无'}")
print(f"  图标条目  : {len(mipmaps)} 个")
print(f"  权限      : {len(perms)} 个 -> {', '.join(p.split('.')[-1] for p in perms) or '无'}")
print(f"  网页内容  : assets/index.html {len(packed_html)} 字节，与离线版一致 = {html_same}")

# ---- 反过来查：这些东西**不该**在包里 ----
# 2.31 删掉语音输入之后，APK 里不该再有离线识别那套（42MB 模型 + 两个 ABI 的 .so）。
# 这一条守的是"别哪天又背回去"：它不会自己回来，但改构建脚本的人可能手滑。
with zipfile.ZipFile(signed) as z:
    zn = z.namelist()
    dex_blob = z.read("classes.dex")
stray = sorted(set(n for n in zn
                   if n.startswith("lib/") or "vosk" in n.lower() or "jna" in n.lower()
                   or n.startswith("assets/vosk")))

# 2.31 之后包里一个 native 库都没有了，所以不再校验 extractNativeLibs
# （那条断言是给 2.30 的离线识别库用的）。manifest 里那条属性留着：
# 将来真要再加 native 库时，它会替你挡掉"库在包里、JNA 却 dlopen 不到"那个坑。

if stray:
    sys.exit("!! APK 里出现了不该有的东西（离线识别的库或模型）：" + "、".join(stray[:5]))
if b"Lcom/local/cognitiontrainer/LocalAsr;" in dex_blob:
    sys.exit("!! dex 里还有 LocalAsr（语音输入的残留没删干净）")
print("  离线识别残留: 无")

if missing:
    sys.exit("!! APK 结构不完整")
if not html_same:
    sys.exit("!! APK 里的 index.html 与 build_offline.py 的产物不一致，构建作废")

