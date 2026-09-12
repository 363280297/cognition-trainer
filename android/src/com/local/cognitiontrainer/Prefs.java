package com.local.cognitiontrainer;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 原生侧和网页侧共享的一小块状态。
 *
 * 为什么走 SharedPreferences 而不是内存变量：闸门服务（GateService）和
 * 提醒接收器（ReminderReceiver）都可能在主界面没起来的时候被系统唤起，
 * 那时内存里什么都没有。磁盘上的这一份是唯一可靠的来源。
 *
 * 写入方只有一个：网页那边算出「是否达标」之后通过桥推过来。
 * 原生只负责读和执行——达标逻辑不能有两份，否则迟早会漂移。
 */
final class Prefs {

    static final String NAME = "eq_state";

    private Prefs() { }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    // ---------------------------------------------------------- 闸门
    /** 旧网页只有 armed，无法区分「关闭」与「达标」，不能据此确认完成。 */
    static void setGate(Context c, boolean armed, String packagesJson,
                        String summary, boolean canSkip) {
        sp(c).edit()
                .putBoolean("gateEnabled", armed)
                .putBoolean("dailyMetVerified", false)
                .putString("packages", packagesJson == null ? "[]" : packagesJson)
                // 浮层上要显示进度文案，而浮层可能在主界面没起来时被唤起，
                // 所以这句也得落盘，不能只留在内存里。
                .putString("gateSummary", summary == null ? "" : summary)
                .putBoolean("gateCanSkip", canSkip)
                .putString("gateDate", today(c))
                .apply();
    }

    /** 用户开关长期有效；当天事实只能由带当前本地日期的网页记录更新。 */
    static void setTrainingState(Context c, boolean enabled, boolean met, String date,
                                 String packagesJson, String summary, boolean canSkip) {
        SharedPreferences.Editor edit = sp(c).edit()
                .putBoolean("gateEnabled", enabled)
                .putString("packages", packagesJson == null ? "[]" : packagesJson);
        if (today(c).equals(date)) {
            edit.putBoolean("dailyMet", met)
                    .putBoolean("dailyMetVerified", true)
                    .putString("dailyDate", date)
                    .putString("gateDate", date)
                    .putString("gateSummary", summary == null ? "" : summary)
                    .putBoolean("gateCanSkip", canSkip);
        }
        // 旧页面跨天后可能仍发昨天的数据，也可能传来未来日期。
        // 不存这些日期事实，防止未来自动生效；也不覆盖已经收到的今天事实。
        edit.apply();
    }

    /** 浮层上显示的那行进度。网页算好推过来，原生不重复算。 */
    static String gateSummary(Context c) {
        if (!today(c).equals(sp(c).getString("gateDate", ""))) {
            return "今天的进度尚未同步，请打开训练页确认。";
        }
        String s = sp(c).getString("gateSummary", "");
        return s.isEmpty() ? "今天的量很小，做完就达标。" : s;
    }

    /** 今天还能不能跳过。用过了浮层上就不给「跳过」按钮——Never Miss Twice。 */
    static boolean gateCanSkip(Context c) {
        // 没有今天的证据时，不能用昨天的跳过限制锁住用户。
        if (!today(c).equals(sp(c).getString("gateDate", ""))) return true;
        return sp(c).getBoolean("gateCanSkip", false);
    }

    static boolean isArmed(Context c) {
        // 旧 armed=true 能证明用户启用了闸门；false 含义不明，保持关闭。
        // 不把派生 armed 写回，避免当天达标丢掉下一天仍应有效的启用意图。
        boolean enabled = sp(c).getBoolean("gateEnabled", sp(c).getBoolean("armed", false));
        return enabled && !dailyMet(c);
    }

    static String packages(Context c) {
        return sp(c).getString("packages", "[]");
    }

    /**
     * 深度拦截：拦到之后不只是把游戏挤到后台，而是真的把它杀掉。
     *
     * 默认关。它依赖 root，root 不在的时候会静默失效——
     * 「以为有保护、实际没有」比不做更糟，所以这个开关必须由用户在
     * 设置页看着 root 探测结果主动打开，不能默认替用户打开。
     */
    static void setDeepBlock(Context c, boolean on) {
        sp(c).edit().putBoolean("deepBlock", on).apply();
    }

    static boolean deepBlock(Context c) {
        return sp(c).getBoolean("deepBlock", false);
    }

    /**
     * 防掉线：让守夜循环把被系统关掉的无障碍服务写回来。
     *
     * 这也是「用户想不想让它开着」的**意图**，不是「它真的在不在跑」。
     * 真在不在跑要去读心跳文件的时间戳（GateWatch.runningSecAgo）——
     * 这个项目已经栽过几次「记意图当事实」的坑了，这里不能再犯。
     */
    static void setGateWatch(Context c, boolean on) {
        sp(c).edit().putBoolean("gateWatch", on).apply();
    }

    static boolean gateWatch(Context c) {
        return sp(c).getBoolean("gateWatch", false);
    }

    // ---------------------------------------------------------- 每日达标
    /** 只有「今天这一条记录」才算数——跨天之后旧记录不能拿来当达标证据 */
    static boolean dailyMet(Context c) {
        String d = sp(c).getString("dailyDate", "");
        // 旧版本从 !armed 推出来的 dailyMet 不是实际完成证据。
        return sp(c).getBoolean("dailyMetVerified", false)
                && sp(c).getBoolean("dailyMet", false) && d.equals(today(c));
    }

    static String today(Context c) {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        return String.format(java.util.Locale.US, "%04d-%02d-%02d",
                cal.get(java.util.Calendar.YEAR),
                cal.get(java.util.Calendar.MONTH) + 1,
                cal.get(java.util.Calendar.DAY_OF_MONTH));
    }

    // ---------------------------------------------------------- 提醒
    static void setReminder(Context c, boolean enabled, int hour, int minute) {
        sp(c).edit()
                .putBoolean("remEnabled", enabled)
                .putInt("remHour", hour)
                .putInt("remMinute", minute)
                .apply();
    }

    static boolean reminderEnabled(Context c) {
        return sp(c).getBoolean("remEnabled", true);
    }

    static int reminderHour(Context c) {
        return sp(c).getInt("remHour", 20);
    }

    static int reminderMinute(Context c) {
        return sp(c).getInt("remMinute", 0);
    }

    // ---------------------------------------------------------- 用户自己的音乐
    //
    // 只存一个 URI（带持久化读授权）和一个显示用的文件名。
    // 卸载之后 SharedPreferences 和那份授权都会没，他自己那个音乐文件不受影响——
    // 这是「卸载必须干净」的一部分：我们不复制、不搬运他的文件。
    static void setMusic(Context c, String uri, String name) {
        sp(c).edit()
                .putString("musicUri", uri == null ? "" : uri)
                .putString("musicName", name == null ? "" : name)
                .apply();
    }

    static String musicUri(Context c) {
        return sp(c).getString("musicUri", "");
    }

    static String musicName(Context c) {
        return sp(c).getString("musicName", "");
    }
}
