package com.local.cognitiontrainer

import android.content.Context
import java.util.Calendar
import java.util.Locale

/** 原生侧和网页侧共享的少量持久状态。 */
object Prefs {
    @JvmField val NAME: String = "eq_state"

    private fun sp(c: Context) = c.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    @JvmStatic fun setGate(c: Context, armed: Boolean, packagesJson: String?, summary: String?, canSkip: Boolean) {
        sp(c).edit().putBoolean("gateEnabled", armed).putBoolean("dailyMetVerified", false)
            .putString("packages", packagesJson ?: "[]").putString("gateSummary", summary ?: "")
            .putBoolean("gateCanSkip", canSkip).putString("gateDate", today(c)).commit()
    }

    @JvmStatic fun setTrainingState(c: Context, enabled: Boolean, met: Boolean, date: String?, packagesJson: String?, summary: String?, canSkip: Boolean) {
        val edit = sp(c).edit().putBoolean("gateEnabled", enabled).putString("packages", packagesJson ?: "[]")
        if (today(c) == date) edit.putBoolean("dailyMet", met).putBoolean("dailyMetVerified", true)
            .putString("dailyDate", date).putString("gateDate", date)
            .putString("gateSummary", summary ?: "").putBoolean("gateCanSkip", canSkip)
        edit.commit()
    }

    @JvmStatic fun gateSummary(c: Context): String {
        if (today(c) != sp(c).getString("gateDate", "")) return "今天的进度尚未同步，请打开训练页确认。"
        return sp(c).getString("gateSummary", "").orEmpty().ifEmpty { "今天的量很小，做完就达标。" }
    }

    @JvmStatic fun gateCanSkip(c: Context): Boolean =
        if (today(c) != sp(c).getString("gateDate", "")) true else !dailySkipped(c) && sp(c).getBoolean("gateCanSkip", false)

    @JvmStatic fun isArmed(c: Context): Boolean {
        val enabled = sp(c).getBoolean("gateEnabled", sp(c).getBoolean("armed", false))
        return enabled && !dailyMet(c) && !dailySkipped(c)
    }
    @JvmStatic fun packages(c: Context): String = sp(c).getString("packages", "[]").orEmpty()
    @JvmStatic fun dailySkipped(c: Context): Boolean =
        sp(c).getString("dailyDate", "") == today(c) && sp(c).getBoolean("dailySkipped", false)

    @JvmStatic fun markDailySkipped(c: Context) {
        sp(c).edit().putBoolean("dailySkipped", true).putString("dailyDate", today(c))
            .putBoolean("gateCanSkip", false).commit()
    }

    @JvmStatic fun setDeepBlock(c: Context, on: Boolean) = sp(c).edit().putBoolean("deepBlock", on).apply()
    @JvmStatic fun deepBlock(c: Context): Boolean = sp(c).getBoolean("deepBlock", false)
    @JvmStatic fun setGateWatch(c: Context, on: Boolean) = sp(c).edit().putBoolean("gateWatch", on).apply()
    @JvmStatic fun gateWatch(c: Context): Boolean = sp(c).getBoolean("gateWatch", false)
    @JvmStatic fun dailyMet(c: Context): Boolean = sp(c).getBoolean("dailyMetVerified", false) &&
        sp(c).getBoolean("dailyMet", false) && sp(c).getString("dailyDate", "") == today(c)

    @Suppress("UNUSED_PARAMETER")
    @JvmStatic fun today(_c: Context): String {
        val cal = Calendar.getInstance()
        return String.format(Locale.US, "%04d-%02d-%02d", cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH))
    }
    @JvmStatic fun setReminder(c: Context, enabled: Boolean, hour: Int, minute: Int) = sp(c).edit()
        .putBoolean("remEnabled", enabled).putInt("remHour", hour).putInt("remMinute", minute).apply()
    @JvmStatic fun reminderEnabled(c: Context): Boolean = sp(c).getBoolean("remEnabled", true)
    @JvmStatic fun reminderHour(c: Context): Int = sp(c).getInt("remHour", 20)
    @JvmStatic fun reminderMinute(c: Context): Int = sp(c).getInt("remMinute", 0)
    @JvmStatic fun setMusic(c: Context, uri: String?, name: String?) = sp(c).edit()
        .putString("musicUri", uri ?: "").putString("musicName", name ?: "").apply()
    @JvmStatic fun musicUri(c: Context): String = sp(c).getString("musicUri", "").orEmpty()
    @JvmStatic fun musicName(c: Context): String = sp(c).getString("musicName", "").orEmpty()
}
