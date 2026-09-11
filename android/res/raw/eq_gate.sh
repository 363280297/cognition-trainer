#!/system/bin/sh
# 闸门守夜：把「无障碍服务被系统关掉」这件事自己修回来。
#
# 为什么需要它——这是实测出来的，不是推测：
#   Android 在「强行停止」一个应用时，会**连它已启用的无障碍服务一起撤销**，
#   直接改写 settings_secure 里的 enabled_accessibility_services（实测被清成 null、
#   accessibility_enabled 被清成 0），而且**不会自愈**——等 15 秒也不回来。
#   而多数国产 ROM 把「从最近任务划掉」就实现成 force-stop。所以划一下，闸门就没了。
#
#   对照实验（同一个模拟器）：
#     am kill          → 进程**没被杀掉**，无障碍开关不动（已启用的无障碍服务受系统保护）
#     am force-stop    → 进程死 + 开关被系统清空，且不自愈
#     重启手机          → 服务自己回来（开关是持久化的）
#   所以真正需要修的只有 force-stop 这一种，其它情况不用管。
#
# 为什么改设置就等于把服务拉回来：写回 enabled_accessibility_services 之后，
#   系统会重新绑定服务——实测 dumpsys accessibility 里出现
#   Bound services:{Service[label=认知训练, ...]}，进程也重新起来（新 pid）。
#   注意「写进去」和「连上」是两件事，这个文件只认前者，所以必须实测过才算数。
#
# 四条不能破的底线：
#   1. 不许覆盖别人的无障碍服务。enabled_accessibility_services 是**冒号分隔的完整列表**，
#      settings put 是整体覆盖——直接写自己那一个，会把用户其它无障碍服务全关掉。
#      所以这里一律先读、再判断、只在缺失时追加。
#   2. 卸载即消失。包里没了就立刻退出，不留下任何在跑的东西。
#   3. 用户在应用里关掉了就退出。靠一个标记文件。
#   4. 只能有一个实例。重复启动会叠加出一堆循环，每个都在写设置。
#
# 参数（应用侧传进来，都给了默认值）：
#   $1 标记文件路径（存在即退出）  $2 锁目录路径  $3 心跳文件路径
#
# 心跳（$3）是给应用读的。应用**没法**自己去查这个循环还活着没有：
# 一个普通应用读不到 root 进程的 /proc。所以让循环每轮把自己的心跳文件戳一下，
# 应用只看「最后修改时间」就能如实说出「运行中（几秒前）」还是「已经停了」——
# 这比让应用记一个"我启动过它"的布尔值可靠得多（那个正是这个项目反复踩的坑：
# 记意图，不记事实）。
#
# 关于「默认值」这几个字，有个教训值得留在这里：第一版把标记文件写成
#   `if [ -n "$STOP" ] && [ -f "$STOP" ]`，而应用那次**没传参数**，
#   于是 $STOP 是空的 → 前半段为假 → **关掉开关它照样在跑**，而且一声不响。
#   测试时我差点把「10 秒内没修」当成「已经退出了」（其实只是还没到 30 秒的兜底窗口）。
#   所以现在一律给默认值，让「少传一个参数」变成「按默认路径判断」而不是「跳过判断」。
#
# 轮询成本是设计过的：settings get/put 每次都会起一个 app_process（JVM），很贵，
#   所以不能高频调用。便宜的是 pidof（toybox，几毫秒）。于是：
#     · 每 2 秒一次 pidof —— 应用进程一没（划掉之后就是这样）就立刻动手；
#     · 每 30 秒一次完整检查 —— 兜住「应用还活着、但用户手动关了无障碍」这种情况。
#   顺带说明为什么不去 grep /data/system/users/0/settings_secure.xml：
#   那个文件是 ABX 二进制格式，grep 不出来（实测直接段错误）。

PKG="com.local.cognitiontrainer"
SVC="$PKG/$PKG.GateService"
STOP="${1:-/data/local/tmp/eq_gate.stop}"
LOCK="${2:-/data/local/tmp/eq_gate.lock}"
HEART="${3:-/data/local/tmp/eq_gate.beat}"

FAST=2                    # pidof 的间隔（秒）
SLOW=15                   # 每多少次才做一次完整检查（15 × 2s = 30s）

# 底线 4：只允许一个实例。
#
# 用 mkdir 抢占，因为 mkdir 是原子的——「先检查再创建」那种写法有竞态。
# 抢不到的时候**不杀对方，而是自己让位退出**：杀进程这件事在这个环境下不一定成
# （实测同一条 kill 一次成功一次像是没生效，得再查一遍才知道），
# 而"两个循环同时改设置"的后果只是多写几次，不值得为它引入一个可能失败的 kill。
#
# 锁里记着持有者的 pid，所以**锁过期能自愈**：进程被系统杀掉之后锁目录还在，
# 这时新实例发现那个 pid 已经没了（/proc/<pid> 不存在），就接管过来。
# 这一步是必须的，否则一次异常退出会让防掉线永久起不来。
acquire() {
  mkdir "$LOCK" 2>/dev/null || return 1
  echo $$ > "$LOCK/pid" 2>/dev/null
  return 0
}

if ! acquire; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && [ -d "/proc/$holder" ]; then
    exit 0                      # 真有一个活的实例：让它干，我不重复
  fi
  rm -rf "$LOCK" 2>/dev/null     # 锁过期了（持有者已经没了）：接管
  acquire || exit 0
fi
trap 'rm -rf "$LOCK" 2>/dev/null; rm -f "$HEART" 2>/dev/null' EXIT

i=0
while :; do
  # 心跳：应用靠这个文件的时间戳判断「在不在跑」，所以每轮都要戳
  : > "$HEART" 2>/dev/null

  # 底线 2：卸载了就退出
  if [ -z "$(pm path "$PKG" 2>/dev/null)" ]; then
    exit 0
  fi
  # 底线 3：用户关掉了就退出
  if [ -f "$STOP" ]; then
    exit 0
  fi

  # 应用进程没了 → 立刻修；否则每隔 SLOW 次兜一次底
  if [ -z "$(pidof "$PKG")" ] || [ $((i % SLOW)) -eq 0 ]; then
    cur=$(settings get secure enabled_accessibility_services 2>/dev/null)

    case "$cur" in
      *"$SVC"*) : ;;                                       # 已经在列表里，不动
      "null"|"") settings put secure enabled_accessibility_services "$SVC" ;;
      *) settings put secure enabled_accessibility_services "$cur:$SVC" ;;   # 底线 1：追加
    esac

    if [ "$(settings get secure accessibility_enabled 2>/dev/null)" != "1" ]; then
      settings put secure accessibility_enabled 1
    fi
  fi

  i=$((i + 1))
  sleep $FAST
done
