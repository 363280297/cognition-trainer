package com.local.eqprobe;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;

import java.util.Collections;
import java.util.List;

/**
 * 一次性探针：量「一个应用到底能看到多少别的东西」。
 *
 * 为什么要专门写一个 App 来量：
 *   认知训练要加的那个「应用隔离」功能，靠的是 appops（GET_USAGE_STATS / PROJECT_MEDIA /
 *   QUERY_ALL_PACKAGES …）。这些 op 名字**能不能被 appops 接受**我可以在模拟器上用命令行验，
 *   但「接受了之后真的拦住了吗」命令行看不出来——那要一个真的以普通应用身份运行的进程
 *   去调那些 API 才知道。
 *
 * 这个项目有一条明确的规矩（写在 RootGate.java 里）：
 *   **绝不能让「以为有保护、实际没有」的状态存在**。
 *   所以宁可先花力气量一次，也不把没验过的开关摆到设置页上。
 *
 * 做法：把所有数字打进 logcat（tag=EQPROBE），然后用 root 改 appops、重启这个 App、
 * 再读一遍，两次数字相减就是「这个 op 真的管不管用」。
 */
public class EqProbe extends Activity {

    private static final String TAG = "EQPROBE";
    // 挑几个第三方包来试可见性。都是模拟器上一定装了的。
    private static final String[] THIRD_PARTY = {
        "com.android.chrome", "com.google.android.dialer",
        "com.google.android.apps.wellbeing", "com.android.settings",
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        measure(getApplicationContext());
        finish();
    }

    private static void p(String k, Object v) {
        Log.i(TAG, k + "=" + v);
    }

    /**
     * 每段都单独兜异常，而且把异常本身当成**结论**记下来。
     *
     * 第一版没兜，结果关掉 GET_USAGE_STATS 之后整个 measure() 直接挂了、
     * 后面的行一行都没打出来——看上去像"探针坏了"，其实那正是"真的拦住了"的证据。
     * 一个被拒绝的 API 通常就是抛 SecurityException，所以异常不是噪声，是读数。
     */
    private static void section(String name, Runnable body) {
        try {
            body.run();
        } catch (Throwable t) {
            p(name, "被拦住（" + t.getClass().getSimpleName() + "）");
        }
    }

    static void measure(Context ctx) {
        final PackageManager pm = ctx.getPackageManager();

        // ---- 1 能看到多少个应用（「读取到另一个应用」）----
        section("A-读应用", () -> {
            List<PackageInfo> pkgs = pm.getInstalledPackages(0);
            List<ApplicationInfo> apps = pm.getInstalledApplications(0);
            p("installedPackages", pkgs.size());
            p("installedApplications", apps.size());
            int sys = 0;
            for (PackageInfo pi : pkgs) {
                if ((pi.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) sys++;
            }
            p("其中系统应用", sys);
            p("QUERY_ALL_PACKAGES权限", ctx.checkSelfPermission("android.permission.QUERY_ALL_PACKAGES"));
            StringBuilder vis = new StringBuilder();
            for (String t : THIRD_PARTY) {
                boolean ok;
                try {
                    pm.getPackageInfo(t, 0);
                    ok = true;
                } catch (PackageManager.NameNotFoundException e) {
                    ok = false;
                }
                vis.append(t.substring(t.lastIndexOf('.') + 1)).append('=').append(ok ? 'Y' : 'N').append(' ');
            }
            p("指定包可见性", vis.toString().trim());
        });

        // ---- 2 知道后台在跑什么（「后台有哪些应用在运行」）----
        section("B-用量统计", () -> {
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            long dayAgo = now - 24L * 3600 * 1000;
            List<UsageStats> stats = usm == null
                ? Collections.<UsageStats>emptyList()
                : usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, dayAgo, now);
            p("用量统计条数", stats == null ? -1 : stats.size());
            int withTime = 0;
            if (stats != null) {
                for (UsageStats s : stats) {
                    if (s.getTotalTimeInForeground() > 0) withTime++;
                }
            }
            p("queryUsageStats 里有前台时长的", withTime);
            // queryEvents 拿的是前后台切换事件 —— "谁刚在后台/谁刚起来"。
            // 注意 UsageEvents 没有 size()，得自己 getNextEvent() 数。
            android.app.usage.UsageEvents ev = usm.queryEvents(dayAgo, now);
            int n = 0;
            if (ev != null) {
                android.app.usage.UsageEvents.Event e = new android.app.usage.UsageEvents.Event();
                while (ev.getNextEvent(e)) n++;
            }
            p("切换事件条数", n);
        });

        section("C-运行进程", () -> {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            List<ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
            p("getRunningAppProcesses", procs == null ? -1 : procs.size());
            int other = 0;
            if (procs != null) {
                for (ActivityManager.RunningAppProcessInfo r : procs) {
                    if (r.uid != android.os.Process.myUid()) other++;
                }
            }
            p("其中别的 UID 的进程", other);
            p("getRunningTasks", am.getRunningTasks(10) == null ? -1 : am.getRunningTasks(10).size());
        });

        // ---- 3 截屏/录屏（MediaProjection）----
        section("D-截屏", () -> {
            Object mpm = ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            p("MediaProjectionManager", mpm == null ? "null" : mpm.getClass().getSimpleName());
            android.media.projection.MediaProjectionManager m =
                (android.media.projection.MediaProjectionManager) mpm;
            // createScreenCaptureIntent 本身不检查 appop（真正的检查在用户点过同意框之后的
            // getMediaProjection 里）。这一条只能确认接口可达，不能当"拦住了"的证据。
            p("captureIntent", m.createScreenCaptureIntent() == null ? "null" : "ok");
        });

        // ---- 4 无障碍（读屏）----
        section("E-无障碍", () -> {
            String enabled = android.provider.Settings.Secure.getString(
                ctx.getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            p("系统里已启用的无障碍服务", enabled == null ? "（无）" : enabled);
        });

        p("done", "1");
    }
}

