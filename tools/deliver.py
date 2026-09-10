"""把 APK 交付到桌面，并自动清理历史版本。

用户的要求：**桌面上只留最新一次和上一次的包，再之前的全部删掉。**

为什么写成脚本而不是"记得手动删"：
这个项目的教训是「凡是需要记得做某件事的设计，迟早会忘」
（内容键白名单、javac 源文件清单、两个数据文件清单，都栽过）。
交付这个动作每次迭代都要做一遍，放在脑子里必然有一天忘了，
然后桌面又开始堆。所以把它变成一条命令。

它会做四件事：
  1) 从 manifest 读出版本号（不手抄，避免和包里的不一致）
  2) 把构建产物拷到桌面：认知训练-<版本>.apk 和固定名的 认知训练.apk
  3) 同步仓库 android/ 里的 manifest 和 apk 副本
  4) 删掉桌面上更老的 认知训练-<版本>.apk，只留最新两个

安全措施（删东西之前先看清楚）：
  · 只匹配 认知训练-数字.数字.apk 这个形状，固定名的 认知训练.apk 不动
  · 删之前确认它是真的 APK（zip 魔数 PK）且体积合理，不是同名别的东西
  · --dry 只看不删；--keep N 改保留数量

    py -3 tools/deliver.py            # 交付 + 清理
    py -3 tools/deliver.py --dry      # 只看会做什么
"""
import argparse
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = pathlib.Path(r"E:\android-build")
BUILT_APK = BUILD / "认知训练.apk"
BUILD_MF = BUILD / "app" / "AndroidManifest.xml"
REPO_ANDROID = ROOT / "android"
DESKTOP = pathlib.Path.home() / "Desktop"

VERSIONED = re.compile(r"^认知训练-(\d+)\.(\d+)\.apk$")


def version_of(manifest: pathlib.Path) -> str:
    txt = manifest.read_text(encoding="utf-8")
    m = re.search(r'android:versionName="([\d.]+)"', txt)
    if not m:
        sys.exit(f"!! 从 {manifest} 里读不到 versionName")
    return m.group(1)


def looks_like_apk(p: pathlib.Path) -> bool:
    """删之前确认它真是个 APK：zip 魔数 + 体积下限。"""
    try:
        if p.stat().st_size < 100_000:
            return False
        with p.open("rb") as f:
            return f.read(2) == b"PK"
    except OSError:
        return False


def prune(desktop: pathlib.Path, keep_versions: set, dry: bool) -> list:
    """删掉桌面上的旧版本包。keep_versions 里的版本号保留。"""
    removed, kept = [], []
    cands = []
    for p in desktop.glob("认知训练-*.apk"):
        m = VERSIONED.match(p.name)
        if not m:
            continue
        cands.append(((int(m.group(1)), int(m.group(2))), p))
    cands.sort(key=lambda x: x[0], reverse=True)
    for ver, p in cands:
        if f"{ver[0]}.{ver[1]}" in keep_versions:
            kept.append(p)
            continue
        if not looks_like_apk(p):
            print(f"  !! 跳过 {p.name}：不像 APK（魔数或体积不对），不敢删")
            continue
        # 体积要在删之前读：先 unlink 再 stat，打出来会是空的（第一版就是这样）
        size = p.stat().st_size
        if dry:
            print(f"  [dry] 会删 {p.name}  {size} 字节")
        else:
            p.unlink()
            print(f"  已删 {p.name}  {size} 字节")
        removed.append(p)
    for p in kept:
        print(f"  保留 {p.name}")
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=int, default=2, help="保留最近几个版本（默认 2）")
    ap.add_argument("--dry", action="store_true", help="只看会做什么，不实际改动")
    args = ap.parse_args()

    if not BUILT_APK.exists():
        sys.exit(f"!! 找不到构建产物 {BUILT_APK}，先跑 py -3 android/build_apk.py")
    ver = version_of(BUILD_MF)
    print(f"版本 {ver}")

    # 交付前先确认包里装的确实是现在这份 HTML（这个不变式由 build_apk.py 保证，
    # 但交付是最后一道门，值得自己再看一眼——打错包的事故这一版刚发生过一次）。
    import zipfile
    with zipfile.ZipFile(BUILT_APK) as z:
        inner = z.read("assets/index.html")
    offline = (ROOT / "认知训练-离线版.html").read_bytes()
    if inner != offline:
        sys.exit("!! APK 里的 HTML 与 认知训练-离线版.html 不一致，拒绝交付"
                 "（先跑 build_offline.py 再跑 build_apk.py）")
    print("  包内 HTML 与离线版一致")

    if args.dry:
        print("\n[dry] 会拷到桌面：", f"认知训练-{ver}.apk", "和 认知训练.apk")
    else:
        shutil.copy(BUILT_APK, DESKTOP / f"认知训练-{ver}.apk")
        shutil.copy(BUILT_APK, DESKTOP / "认知训练.apk")
        print(f"  已拷到桌面：认知训练-{ver}.apk / 认知训练.apk")

        # 仓库里的副本也一起同步，否则仓库那份会悄悄过时
        shutil.copy(BUILT_APK, REPO_ANDROID / "认知训练.apk")
        shutil.copy(BUILD_MF, REPO_ANDROID / "AndroidManifest.xml")
        print("  已同步仓库 android/ 的 apk 与 manifest")

    # 保留「最新 N 个」：最新的本身就是刚拷上去的那个
    keep = {ver}
    others = []
    for p in DESKTOP.glob("认知训练-*.apk"):
        m = VERSIONED.match(p.name)
        if m and f"{m.group(1)}.{m.group(2)}" != ver:
            others.append(((int(m.group(1)), int(m.group(2))), p))
    others.sort(key=lambda x: x[0], reverse=True)
    for _v, p in others[:max(0, args.keep - 1)]:
        keep.add(p.name[len("认知训练-"):-len(".apk")])

    print(f"\n清理桌面（保留最新 {args.keep} 个版本）")
    prune(DESKTOP, keep, args.dry)

    left = sorted(p.name for p in DESKTOP.glob("认知训练*"))
    print("\n桌面上现在的认知训练文件：")
    for n in left:
        print("  " + n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
