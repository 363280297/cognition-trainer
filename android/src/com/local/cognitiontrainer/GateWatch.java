package com.local.cognitiontrainer;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 防掉线：用 root 让无障碍服务在被系统关掉之后自己站起来。
 *
 * ── 为什么需要这个功能（实测，不是推测）─────────────────────────────
 * Android 在「强行停止」一个应用时会**连它已启用的无障碍服务一起撤销**：
 *   am kill        → 进程没被杀掉，开关不动（已启用的无障碍服务受系统保护）
 *   am force-stop  → 进程死 + enabled_accessibility_services 被系统清成 null，
 *                    且**不自愈**（等 15 秒也不回来）
 *   重启手机        → 自己回来（那个开关是持久化的）
 * 麻烦在于**多数国产 ROM 把「从最近任务划掉」就实现成 force-stop**，
 * 所以用户划一下闸门就没了，而且闸门自己不会回来。
 *
 * ── 这个类做什么 ────────────────────────────────────────────────
 * 把一段 shell 循环（res/raw/eq_gate.sh）交给 root 跑起来。它每 2 秒看一次
 * 应用进程在不在（pidof，便宜），不在就立刻把无障碍服务写回设置——实测写回之后
 * 系统会真的重新绑定（dumpsys 里出现 Bound services），1 秒内闸门就回来了。
 *
 * ── 三条边界，每条都对应脚本里的一段注释 ────────────────────────
 * 1. **不覆盖别人的无障碍服务**：enabled_accessibility_services 是一个冒号分隔的
 *    完整列表，settings put 是整体覆盖。直接写自己那一个会把用户其它无障碍服务
 *    全关掉。脚本一律「先读、缺了才追加」。
 * 2. **卸载即消失**：脚本每轮检查包还在不在，包没了就退出；脚本自己也放在
 *    应用的私有目录里（卸载连带删掉），不留任何东西在外部存储。
 * 3. **用户关掉就停**：这个类往私有目录写一个标记文件，脚本看到就退出。
 *
 * 它**不**做的事（都是有意的）：不往 /system 写任何东西、不做开机自启、
 * 不隐藏自己、不因为被关掉就反复重试骚扰——那些是保活软件那一套，
 * 和这个项目「卸载必须解除所有拦截」的前提冲突。
 *
 * ── 状态怎么如实报告 ────────────────────────────────────────────
 * 一个普通应用读不到 root 进程的 /proc，所以没法直接查那个循环还活着没有。
 * 于是脚本每轮戳一下心跳文件，这个类只读它的时间戳：
 * 「运行中（3 秒前）」是硬证据，「我启动过它」不是。这条是这个项目反复踩出来的。
 */
final class GateWatch {

    private static final String SCRIPT = "eq_gate.sh";
    private static final String STOP = "eq_gate.stop";
    private static final String LOCK = "eq_gate.lock";
    private static final String BEAT = "eq_gate.beat";

    /** 心跳超过这个秒数没动就认为它已经停了。脚本 2 秒一轮，留足余量。 */
    private static final long STALE_SEC = 12;

    private GateWatch() { }

    private static File f(Context c, String name) {
        return new File(c.getFilesDir(), name);
    }

    /**
     * 把脚本从 res/raw 落到私有目录。每次都对一遍字节：
     * 应用升级换了脚本内容之后，磁盘上那份不能还是旧的。
     * （这和离线版 HTML 的「逐字节指纹」是同一个道理：不能只信"我写过一次"。）
     */
    private static File materialize(Context c) throws Exception {
        File out = f(c, SCRIPT);
        byte[] want;
        try (InputStream in = c.getResources().openRawResource(R.raw.eq_gate)) {
            want = readAll(in);
        }
        if (out.isFile() && out.length() == want.length) {
            byte[] has = readAll(new java.io.FileInputStream(out));
            if (java.util.Arrays.equals(has, want)) return out;
        }
        try (OutputStream os = new FileOutputStream(out)) {
            os.write(want);
        }
        return out;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /**
     * 打开防掉线。同步执行，**必须在后台线程调**（su 授权框可能在等人点）。
     * 返回失败原因，成功返回 null。
     */
    static synchronized String start(Context c) {
        try {
            if (!RootGate.available()) return "root 不可用（没授权或这台机器没有 root）";
            File script = materialize(c);
            // 先撤掉停止标记，否则脚本一看标记就直接退出了
            f(c, STOP).delete();
            f(c, BEAT).delete();

            // 用 & 起在后台，并 redirect 掉输出：不这么写的话 su 的管道会一直挂着，
            // 我们这边的 readLine 要等到循环结束才返回——而它是**不会**结束的。
            String cmd = "sh " + q(script.getAbsolutePath())
                    + " " + q(f(c, STOP).getAbsolutePath())
                    + " " + q(f(c, LOCK).getAbsolutePath())
                    + " " + q(f(c, BEAT).getAbsolutePath())
                    + " >/dev/null 2>&1 &";
            String out = RootGate.run(cmd);
            if (out == null) return "su 执行失败（可能被拒绝授权）";
            return null;
        } catch (Exception e) {
            return "启动失败：" + e.getClass().getSimpleName();
        }
    }

    /** 关掉防掉线。写停止标记即可——脚本自己看到就退出，不需要我们去 kill。 */
    static synchronized void stop(Context c) {
        try {
            FileOutputStream os = new FileOutputStream(f(c, STOP));
            os.write('1');
            os.close();
        } catch (Exception ignored) { }
    }

    /** 单引号包一层，防止路径里的字符被 shell 解释。 */
    private static String q(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /**
     * 如实报告状态。running 是从**心跳时间戳**推出来的，不是从「我启动过」推出来的。
     * 心跳读不到（还没起、或者已经停了）→ running=false。
     */
    static String status(Context c) {
        JSONObject o = new JSONObject();
        try {
            boolean want = Prefs.gateWatch(c);
            o.put("want", want);

            Boolean known = RootGate.cached();
            o.put("rootKnown", known != null);
            o.put("rootOk", known != null && known);

            File beat = f(c, BEAT);
            long ago = -1;
            if (beat.isFile()) {
                long ms = System.currentTimeMillis() - beat.lastModified();
                if (ms >= 0) ago = ms / 1000;
            }
            o.put("ago", ago);
            o.put("running", ago >= 0 && ago <= STALE_SEC);
        } catch (Exception ignored) { }
        return o.toString();
    }
}
