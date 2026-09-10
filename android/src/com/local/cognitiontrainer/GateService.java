package com.local.cognitiontrainer;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;

import java.util.HashSet;
import java.util.Set;

/**
 * 闸门服务：达标之前拦住目标应用。
 *
 * 技术边界先说清楚，因为它决定了这里能做到什么：
 *   **无障碍服务无法阻止另一个应用启动。** 它能做的是——观察到目标应用到了前台，
 *   然后立刻做两件事：
 *     1. performGlobalAction(GLOBAL_ACTION_HOME)：把它推下去，不让你停在里面；
 *     2. 叠一层全屏浮层：你看到的是闸门，不是游戏。
 *   观感上接近「打不开」，但严格说不是禁止：按 Home 键仍能绕开。
 *   真·打不开要靠 DevicePolicyManager.setPackagesSuspended（设备管理员），
 *   代价不同，没有做。
 *
 * 为什么不是「把主界面拉到前台」（上一版的做法）：
 *   上一版 startActivity(MainActivity)，于是**游戏已经开起来了**，用户是事后被拽走的。
 *   浮层是在目标应用露头的同一帧盖上去，没有应用切换动画，观感差很多。
 *   这也正是那篇 PNAS 研究（Grüning 等 2023，n=280）用的机制：
 *   摩擦 + 一个明确的放弃选项，让打开次数降了 57%。
 *
 * 为什么不用 root：
 *   1. 系统标准做法，系统升级不会把它弄坏；
 *   2. 权限范围反而**更小**——root 是这个 App 什么都能做，
 *      而这里 canRetrieveWindowContent=false，读不到任何界面内容，只拿到包名；
 *   3. 换台手机功能还在。
 *
 * 判定「该不该拦」不在原生做，由网页那边算（是否达标）后推过来，
 * 这样达标逻辑只有一份，不会两边漂移。
 */
public class GateService extends AccessibilityService {

    private static final long COOLDOWN_MS = 2500;

    private long lastFire = 0;
    private View overlay;
    private WindowManager wm;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkgCs = event.getPackageName();
        if (pkgCs == null) return;
        String pkg = pkgCs.toString();

        if (getPackageName().equals(pkg)) return;        // 别拦自己
        if ("com.android.systemui".equals(pkg)) return;  // 别拦下拉通知栏

        if (!Prefs.isArmed(this)) return;

        Set<String> targets = new HashSet<>();
        try {
            JSONArray arr = new JSONArray(Prefs.packages(this));
            for (int i = 0; i < arr.length(); i++) targets.add(arr.getString(i));
        } catch (Exception ignored) {
            return;
        }
        if (!targets.contains(pkg)) return;

        long now = System.currentTimeMillis();
        boolean cooled = now - lastFire >= COOLDOWN_MS;
        if (cooled) lastFire = now;

        // 深度拦截：真的把它杀掉，不只是挤到后台。
        //
        // 关键：杀进程**不受冷却限制**。冷却的目的是别把浮层刷爆，
        // 而不是「两秒内重新打开就放过你」——那正好是「强制」要堵的那条缝。
        // 先起线程再决定要不要弹浮层，因为杀完之后浮层其实已经没意义了。
        // 必须异步：su 的授权弹窗可能在等人点确认，同步等会卡住无障碍的回调线程，
        // 那个线程被卡住的话后面的窗口变化就全收不到了。
        if (Prefs.deepBlock(this)) {
            final String victim = pkg;
            new Thread(() -> RootGate.forceStop(victim), "eq-force-stop").start();
        }

        // 已经在冷却里就不重复弹浮层（不然连点几次会叠出好几个）
        if (!cooled) return;

        // 先把目标应用推下去，再叠浮层。顺序很重要：
        // 反过来的话浮层会被目标应用盖住，等于没拦。
        try {
            performGlobalAction(GLOBAL_ACTION_HOME);
        } catch (Exception ignored) { }
        showOverlay();
    }

    private void showOverlay() {
        if (overlay != null) return;   // 已经在显示了
        try {
            wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm == null) return;

            // 今天还能不能跳过，决定了这层浮层是「可关掉的提醒」还是「必须动手的闸门」。
            // 用过了跳过按钮就整个消失——这是 Never Miss Twice 的执行点。
            final boolean canSkip = Prefs.gateCanSkip(this);

            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setBackgroundColor(Color.parseColor("#F00E0F16"));
            box.setGravity(Gravity.CENTER);
            box.setPadding(dp(28), dp(28), dp(28), dp(28));
            // 能获得焦点才接得到返回键。不能获得焦点的浮层，按返回会直接穿到下面的应用。
            box.setFocusableInTouchMode(true);
            box.requestFocus();

            TextView title = new TextView(this);
            title.setText(canSkip ? "先做完今天的量" : "今天已经跳过一次了");
            title.setTextColor(Color.parseColor("#F2EDFF"));
            title.setTextSize(23);
            box.addView(title);

            TextView sum = new TextView(this);
            sum.setText(Prefs.gateSummary(this));
            sum.setTextColor(Color.parseColor("#C6BCDC"));
            sum.setTextSize(15);
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            sp.topMargin = dp(16);
            sum.setLayoutParams(sp);
            box.addView(sum);

            if (!canSkip) {
                TextView why = new TextView(this);
                why.setText("第二次没有跳过按钮。不是惩罚——「反正已经破了」比漏掉那一次危险得多："
                        + "错过一次对习惯养成没有实质影响，累积的错过才有。");
                why.setTextColor(Color.parseColor("#E8C07A"));
                why.setTextSize(13);
                LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                wp.topMargin = dp(14);
                why.setLayoutParams(wp);
                box.addView(why);
            }

            // 明确的放弃选项——PNAS 那篇的预注册实验里，这是三个成分中唯一
            // 单独就有效的那个。所以它必须在，而且要一眼看到。
            Button go = new Button(this);
            go.setText("去完成");
            go.setTextSize(16);
            go.setOnClickListener(v -> {
                hideOverlay();
                Intent it = new Intent(GateService.this, MainActivity.class);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                it.putExtra(MainActivity.EXTRA_GATE, true);
                try { startActivity(it); } catch (Exception ignored) { }
            });
            LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            gp.topMargin = dp(28);
            go.setLayoutParams(gp);
            box.addView(go);

            if (canSkip) {
                Button skip = new Button(this);
                skip.setText("今天先跳过这次");
                skip.setTextSize(14);
                skip.setOnClickListener(v -> hideOverlay());
                box.addView(skip);
            }

            // 退路：只剩「卸载」这一条，写在脸上而不是藏在代码里。
            //
            // 这里要说清一件容易被误解的事，因为浮层上写着「只能卸载」，
            // 很容易读成「前两条路已经被堵死了」——并不是。
            // 「强行停止本应用」和「关掉无障碍服务」是系统给用户的权力，
            // 不是这个 App 提供的选项，任何应用都关不掉它们
            // （能关掉就是在利用系统漏洞，而且安全模式和 ADB 照样绕得过去）。
            // 所以这里删掉的是**提示**，不是**路径**：不告诉你、不等于不存在。
            // 真要硬堵，只能靠 root 那条深度拦截，而它依赖的 root 也可能不可用。
            TextView route = new TextView(this);
            route.setText("要退出这一层，只有一条路：在系统设置里卸载本应用。\n"
                    + "进度、预案、身份陈述都在应用内部，卸载会一并清掉——"
                    + "这是唯一的出口，代价是全部归零。");
            route.setTextColor(Color.parseColor("#8A82A0"));
            route.setTextSize(11);
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rp.topMargin = dp(24);
            route.setLayoutParams(rp);
            box.addView(route);

            // 返回键直接吃掉，别让它穿到下面的游戏
            box.setOnKeyListener((v, code, ev) -> code == android.view.KeyEvent.KEYCODE_BACK);

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    // 不再用 FLAG_NOT_FOCUSABLE：那个标志会让按键直接穿到下层应用。
                    // 代价是这层会拿到焦点（这正是「必须动手」需要的）。
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
                    PixelFormat.OPAQUE);

            wm.addView(box, lp);
            overlay = box;
        } catch (Exception e) {
            // 没有悬浮窗权限之类，静默放弃——不能因为拦不住就崩掉
            overlay = null;
        }
    }

    private void hideOverlay() {
        if (overlay == null || wm == null) return;
        try { wm.removeView(overlay); } catch (Exception ignored) { }
        overlay = null;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onInterrupt() { }

    @Override
    public void onDestroy() {
        hideOverlay();
        super.onDestroy();
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        getSharedPreferences(Prefs.NAME, MODE_PRIVATE).edit().putBoolean("service_on", true).apply();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        getSharedPreferences(Prefs.NAME, MODE_PRIVATE).edit().putBoolean("service_on", false).apply();
        return super.onUnbind(intent);
    }
}
