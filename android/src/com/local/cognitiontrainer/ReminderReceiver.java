package com.local.cognitiontrainer;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Calendar;

/**
 * 每日提醒。
 *
 * 两个刻意的设计：
 *   1. **只在没达标的时候响。** 已经达标的日子不再打扰。一个天天响、
 *      内容和状态无关的提醒，很快会被无意识忽略——那样它就等于不存在。
 *   2. 响过之后自己排明天的。AlarmManager 的重复闹钟在国产 ROM 上被清理得很凶，
 *      自排 + 开机重建（BOOT_COMPLETED）比 setRepeating 可靠。
 *
 * 不用 setExactAndAllowWhileIdle，因为那条路在 Android 12+ 要用户单独授权
 * 「闹钟和提醒」，多一道门槛不值当。setAndAllowWhileIdle 不需要任何特殊权限，
 * 代价是最多晚几分钟——每天一次的提醒晚几分钟无所谓。
 */
public class ReminderReceiver extends BroadcastReceiver {

    public static final String CHANNEL = "eq_daily";
    private static final int NOTIF_ID = 4201;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? null : intent.getAction();

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            // 重启之后闹钟全没了，按已存的时间重排一次
            if (Prefs.reminderEnabled(ctx)) {
                schedule(ctx, Prefs.reminderHour(ctx), Prefs.reminderMinute(ctx));
            }
            return;
        }

        // 到点了：没达标才提醒
        if (Prefs.reminderEnabled(ctx) && !Prefs.dailyMet(ctx)) {
            notifyNow(ctx);
        }
        // 无论响没响都排下一天，否则只响一次
        if (Prefs.reminderEnabled(ctx)) {
            schedule(ctx, Prefs.reminderHour(ctx), Prefs.reminderMinute(ctx));
        }
    }

    /** 排下一次提醒（明天这个点） */
    public static void schedule(Context ctx, int hour, int minute) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, hour);
        c.set(Calendar.MINUTE, minute);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (c.getTimeInMillis() <= System.currentTimeMillis()) {
            c.add(Calendar.DAY_OF_YEAR, 1);
        }

        PendingIntent pi = pending(ctx, PendingIntent.FLAG_UPDATE_CURRENT);
        // setAndAllowWhileIdle：不需要「闹钟和提醒」特殊权限，Doze 下也能出得来
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, c.getTimeInMillis(), pi);
    }

    public static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.cancel(pending(ctx, PendingIntent.FLAG_NO_CREATE));
    }

    private static PendingIntent pending(Context ctx, int flag) {
        Intent it = new Intent(ctx, ReminderReceiver.class);
        it.setAction("com.local.cognitiontrainer.DAILY");
        int f = flag | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 0, it, f);
    }

    /** 立刻发一条，也用于设置页的「试一下」 */
    public static void notifyNow(Context ctx) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "每日计划", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("每天提醒一次，只在还没达标的时候响");
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL)
                : new Notification.Builder(ctx);

        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("今天的量很小")
                .setContentText("4 张卡片 + 1 条微课，做完就达标。")
                .setContentIntent(content)
                .setAutoCancel(true)
                .setShowWhen(true);

        nm.notify(NOTIF_ID, b.build());
    }
}
