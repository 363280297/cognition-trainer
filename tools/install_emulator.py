"""把 Android 模拟器本体和系统镜像补上，再建一个 AVD。

为什么写成脚本、而不是直接在 shell 里敲：
sdkmanager.bat 需要 JAVA_HOME，而在 Git Bash 里 `export JAVA_HOME='E:\\...'`
会被 MSYS 的路径转换改写成 /e/... ，java 认不出来；`cmd /c "set ... && ..."` 也传不进
批处理里。build_apk.py 用的是「python 里给 subprocess 一个 env」这条路，这里照抄。

用户拍板：「装，我想看真机跑起来」。好处是这个项目到现在为止一次都没在真 Android 上
跑过——只能拿"浏览器里跑离线单文件版"近似，原生桥、通知、无障碍、TTS 全都没验过。

用法：
    py -3 tools/install_emulator.py            # 装（下载约 1 GB，慢慢等）
    py -3 tools/install_emulator.py --check    # 只看现在有什么
"""
import os
import subprocess
import sys
from pathlib import Path

SDK = Path("E:/android-build/sdk")
JDK = Path("E:/android-build/jdk")
SDKMANAGER = SDK / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat"
AVDMANAGER = SDK / "cmdline-tools" / "latest" / "bin" / "avdmanager.bat"
EMULATOR = SDK / "emulator" / "emulator.exe"
ADB = SDK / "platform-tools" / "adb.exe"

PKGS = ["emulator", "system-images;android-34;google_apis;x86_64"]
AVD = "eq34"
IMAGE = "system-images;android-34;google_apis;x86_64"


def env():
    e = dict(os.environ)
    e["JAVA_HOME"] = str(JDK)
    e["ANDROID_HOME"] = str(SDK)
    e["ANDROID_SDK_ROOT"] = str(SDK)
    return e


def run(args, **kw):
    print("$ " + " ".join(str(a) for a in args), flush=True)
    return subprocess.run(args, env=env(), **kw)


def check():
    print(f"emulator 本体：{'有' if EMULATOR.exists() else '没有'}  {EMULATOR}")
    print(f"adb          ：{'有' if ADB.exists() else '没有'}  {ADB}")
    imgs = SDK / "system-images"
    have = sorted(p.name for p in imgs.rglob("system.img")) if imgs.is_dir() else []
    print(f"系统镜像     ：{have if have else '没有'}")
    avds = Path(os.path.expanduser("~/.android/avd"))
    print(f"已有 AVD     ：{[p.stem for p in avds.glob('*.ini')] if avds.is_dir() else '没有'}")


def main():
    if "--check" in sys.argv:
        check()
        return
    if not SDKMANAGER.exists():
        sys.exit(f"找不到 sdkmanager：{SDKMANAGER}")
    if not JDK.is_dir():
        sys.exit(f"找不到 JDK：{JDK}")

    # --install 一路会问几次许可，用 input 把一串 y 灌进去（stdin 用 PIPE 时
    # subprocess 会自动接上；不给 input 就会一直等键盘，看起来像卡死）
    print("== 1/3 装 emulator 和系统镜像（要约 1 GB，这一步最慢）==", flush=True)
    r = run([str(SDKMANAGER), "--sdk_root=" + str(SDK), "--install"] + PKGS,
            input=b"y\r\n" * 50)
    if r.returncode != 0:
        sys.exit(f"!! sdkmanager 退出码 {r.returncode}，看上面的输出")
    if not EMULATOR.exists():
        sys.exit("!! 装完还是没有 emulator.exe，看上面的 sdkmanager 输出")

    print("\n== 2/3 建 AVD ==", flush=True)
    run([str(AVDMANAGER), "create", "avd", "-n", AVD, "-k", IMAGE, "-d", "pixel_6",
         "--force"], input=b"no\r\n")

    print("\n== 3/3 结果 ==", flush=True)
    check()


if __name__ == "__main__":
    main()
