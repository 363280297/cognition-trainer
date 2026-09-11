package com.local.cognitiontrainer;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.regex.Pattern;

/**
 * 用 root 真正把目标应用杀掉。
 *
 * 为什么是 root 而不是 Shizuku：
 *   这个项目的构建是手工的（aapt2 → javac → d8），**没有依赖管理**。
 *   Shizuku 要引入它的 API 和 provider，得手工 vendor 一整套类；
 *   而 root 只要一句 `su -c am force-stop`。效果一样，代价差一个数量级。
 *
 * 为什么 force-stop 不破坏「卸载即消失」那条保证：
 *   `am force-stop` 只结束进程，不写任何持久状态。卸载本应用之后，
 *   目标应用照常能启动——这一点和 setPackagesSuspended / pm disable-user
 *   有本质区别，那两个会把状态记进系统。所以不可残留的那条断言仍然成立。
 *
 * 但有一个必须说清的代价：**没有 root 时它会静默失效。**
 *   root 不可用、或者用户拒绝了 su，这个方法就只是返回 false。
 *   所以 available() 是要显式调用的——设置页会把它显示出来，
 *   绝不能让「深度拦截」在没生效的时候看起来像生效了。
 *   那种「以为有保护、实际没有」的状态比不做更糟。
 */
final class RootGate {

    // 包名白名单校验。这是防注入：pkg 会拼进 shell 命令里，
    // 不加校验就是命令注入（虽然来源是本地设置，但没有理由留这个口子）。
    private static final Pattern PKG = Pattern.compile("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+$");

    private static Boolean cachedAvailable = null;

    private RootGate() { }

    /** 跑一句无害命令探测 su 是否可用。结果缓存，因为要用到进程和超时。 */
    static synchronized boolean available() {
        if (cachedAvailable != null) return cachedAvailable;
        cachedAvailable = run("id") != null;
        return cachedAvailable;
    }

    /** 探测结果失效时调用（比如用户刚授权了 root） */
    static synchronized void resetCache() {
        cachedAvailable = null;
    }

    /** 读缓存，不触发探测。null 表示还不知道——界面上要显示成「未检测」而不是「不支持」。 */
    static synchronized Boolean cached() {
        return cachedAvailable;
    }

    /** 杀掉目标应用。返回是否真的执行了。 */
    static boolean forceStop(String pkg) {
        if (pkg == null || !PKG.matcher(pkg).matches()) return false;
        if (!available()) return false;
        // 用 am force-stop。不要用 kill -9，那个杀不干净还会被系统立刻拉起来。
        return run("am force-stop " + pkg) != null;
    }

    /**
     * 通过 su 跑一条命令。失败返回 null。
     *
     * 包可见：GateWatch 也用它（把守夜脚本交给 root 起起来）。
     *
     * 等 3 秒：su 授权弹窗可能正在等用户点确认，卡住主线程会更糟。
     * 调用方必须不在主线程上调它——所以 GateService 里是异步调的。
     */
    static String run(String cmd) {
        Process p = null;
        try {
            p = new ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
            if (!p.waitFor(3000, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                p.destroy();
                return null;
            }
            return p.exitValue() == 0 ? sb.toString() : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (p != null) try { p.destroy(); } catch (Exception ignored) { }
        }
    }
}
