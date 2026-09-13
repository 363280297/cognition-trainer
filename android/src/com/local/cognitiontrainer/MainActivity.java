package com.local.cognitiontrainer;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 全屏 WebView 容器 + 原生能力桥。
 *
 * 为什么需要这座桥：
 *  1. 语音合成 —— 用系统 TTS（中文、离线、免费）
 *     注意：网页里的 Web Speech API 在 Android WebView 里不生效，必须走原生。
 *  3. HTTPS 请求 —— WebView 里直接用 fetch 会被跨域(CORS)拦掉，
 *     所以网络请求交给原生 HttpURLConnection 发，再把结果回传给网页。
 *
 * 密钥不写在这份代码里：由用户在 App 内粘贴一次，存在网页的 localStorage。
 * 这样 APK 本身不含任何凭证，反编译也拿不到。
 */
public class MainActivity extends Activity {

    private static final int REQ_NOTIF = 1002;
    private static final int REQ_STORAGE = 1003;
    private static final int REQ_MUSIC = 1004;     // 选一个音乐文件（ACTION_OPEN_DOCUMENT）
    /* 截图那一条路的三个尺寸（2.43 定的，值和理由见 shotToDataUrls 的注释）：
       · SHOT_WIDTH_CAP —— 宽度基本不动：字的清晰度由它决定
       · SHOT_PX_BUDGET —— 一段的像素预算，超过就会被模型再缩一次
       · SHOT_MAX_PARTS —— 段数上限：一段一张图，太多会让请求又慢又贵，手机上还会超时 */
    private static final int SHOT_WIDTH_CAP = 1600;
    private static final int SHOT_PX_BUDGET = 640000;
    private static final int SHOT_MAX_PARTS = 13;

    private static final int REQ_SHOT = 1005;      // 选聊天截图（ACTION_OPEN_DOCUMENT image/*）

    /** 闸门服务把主界面拉起来时带这个 extra */
    public static final String EXTRA_GATE = "gate";

    private WebView web;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    /* 用户选的音色名。空串 = 自动（用 setLanguage 选的默认音色）。
       存成字段而不是每次都 setVoice：setVoice 在部分引擎上要花几十毫秒，
       而 speak() 是每句话都会走的热路径。只在「和当前生效的不一样」时才切。 */
    private volatile String desiredVoice = "";
    private volatile String appliedVoice = null;
    private final Handler ui = new Handler(Looper.getMainLooper());

    /* 用户自己的音乐。用 MediaPlayer 放手机里的一个文件（不是内置音频）。
       为什么这么做、以及为什么**不**内置商业音乐，见下面 musicPlay 上面那段注释。 */
    private MediaPlayer music;
    private float musicVol = 0.22f;
    private boolean musicDucked = false;
    /** 选中的 URI 是否拿到了「重启后仍然有效」的授权。拿不到就只能当下这次有效，
     *  这种情况必须如实告诉用户，否则他下次打开发现不能放、却不知道为什么。 */
    private boolean musicPersist = true;

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        if (Build.VERSION.SDK_INT >= 16) {
            s.setAllowFileAccessFromFileURLs(false);
            s.setAllowUniversalAccessFromFileURLs(false);
        }
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setBackgroundColor(Color.parseColor("#12131A"));
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        // 离线模块不需要网络；在线模块（语音对话/体检/复盘）自己发请求
        web.addJavascriptInterface(new Bridge(), "EQNative");

        web.loadUrl(startUrl(getIntent()));
        setContentView(web);

        initTts();
        ensureNotifChannel();
        // 把上次存的提醒重新排上（用户可能在设置里改过时间）
        if (Prefs.reminderEnabled(this)) {
            ReminderReceiver.schedule(this, Prefs.reminderHour(this), Prefs.reminderMinute(this));
        }
    }

    /** 闸门被拉起时在 URL 上带 ?gate=1，网页那边据此不显示「跳过」按钮。
     *  判定仍然只有网页那一份，原生只是把「这次是被闸门拉起来的」这个事实传进去。 */
    private String startUrl(Intent intent) {
        boolean gate = intent != null && intent.getBooleanExtra(EXTRA_GATE, false);
        return "file:///android_asset/index.html" + (gate ? "?gate=1" : "");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web == null) return;
        if (intent != null && intent.getBooleanExtra(EXTRA_GATE, false)) {
            // 已经加载过就不要再 reload，直接让网页把闸门弹出来
            js("window.__gateKick&&window.__gateKick()");
        } else {
            web.loadUrl(startUrl(intent));
        }
    }

    private void ensureNotifChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        android.app.NotificationManager nm =
                (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        android.app.NotificationChannel ch = new android.app.NotificationChannel(
                ReminderReceiver.CHANNEL, "每日计划",
                android.app.NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("每天提醒一次，只在还没达标的时候响");
        nm.createNotificationChannel(ch);
    }

    private boolean hasNotifPermission() {
        if (Build.VERSION.SDK_INT < 33) return true;   // 13 之前不需要运行时授权
        return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    /* 把 desiredVoice 落到实处。可能失败（音色被卸载了、引擎换了），
       失败就退回默认音色——不能让「选了一个不存在的音色」变成彻底没声音。 */
    private void applyVoice() {
        if (tts == null || !ttsReady) return;
        try {
            String want = desiredVoice == null ? "" : desiredVoice;
            if (appliedVoice != null && appliedVoice.equals(want)) return;
            if (want.isEmpty()) {
                tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                appliedVoice = "";
                return;
            }
            for (android.speech.tts.Voice v : tts.getVoices()) {
                if (v != null && want.equals(v.getName())) {
                    // setVoice 会覆盖 setLanguage 的结果，所以按音色自己带的语言来
                    tts.setLanguage(v.getLocale());
                    int ok = tts.setVoice(v);
                    appliedVoice = (ok == TextToSpeech.SUCCESS) ? want : "";
                    if (ok != TextToSpeech.SUCCESS) tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                    return;
                }
            }
            // 找不到这个音色：说明它已经不在这台手机上了
            desiredVoice = "";
            tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
            appliedVoice = "";
        } catch (Exception ignored) { }
    }

    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) {
                ttsReady = false;
                js("window.__onCaps&&window.__onCaps()");   // 如实告诉网页：合成不可用
                return;
            }
            int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
            ttsReady = (r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED);
            applyVoice();
            /* TTS 就绪是**异步**的，比网页载入晚。网页载入时问 capabilities()
               有可能拿到 tts=false，然后它就一直以为这台手机不能出声。
               所以这里推一次，让网页重新探一遍——不能只靠"载入时那一问"。 */
            js("window.__onCaps&&window.__onCaps()");
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { js("window.__onSpeak&&window.__onSpeak('start')"); }
                @Override public void onDone(String id) { js("window.__onSpeak&&window.__onSpeak('done')"); }
                @Override public void onError(String id) { js("window.__onSpeak&&window.__onSpeak('error')"); }
                // onStop 必须要有。tts.stop() **不会**回调 onDone，只会回调 onStop；
                // 之前没实现它，于是网页侧「她正在说」这个状态永远关不掉。
                // 免提对话是等「她说完」才把麦克风交回来的，所以少了这一句的表现是：
                // 点「打断她」之后整局就不动了，而且不报任何错——浏览器里还测不出来
                // （浏览器走的是 speechSynthesis，回调路径完全不同）。
                @Override public void onStop(String id, boolean interrupted) {
                    js("window.__onSpeak&&window.__onSpeak('stop')");
                }
            });
        });
    }

    // ------------------------------------------------- 背景音乐：放你自己手机里的文件
    //
    // 用户说「自用、不商用，所以选有版权的也行」。但**把别人的商业唱片打包进 APK**
    // 这件事，不因为自用就成立：那是把他的手机变成再分发点，而且来源不明的音频
    // 一旦进了这个「要长期用、要能干净卸载」的 App，就成了他清理不掉的残留。
    // 所以我没内置任何一首曲子，而是做了更好的那条路：**放他自己手机里的音乐**。
    // 他选一次，App 记住（持久化 URI 授权，重启也还在），卸载就全没了——
    // 符合「卸载必须干净」这条底线。
    //
    // 用 MediaPlayer 而不是把文件读进网页：一首歌几十兆，网页里 <audio> 还拿不到
    // 能长期访问的地址。MediaPlayer + 持久化的 content:// 授权是 Android 上的标准做法，
    // 而且授权范围只有他挑中的那一个文件，不是整个存储。
    //
    // 它不常驻：不播就 release，Activity 销毁也 release，没有后台服务、没有进程。

    private void musicPlayImpl() {
        final String uri = Prefs.musicUri(this);
        if (uri.isEmpty()) { emitMusic("error", "还没选音乐文件"); return; }
        ui.post(() -> {
            try {
                releaseMusic();
                MediaPlayer mp = new MediaPlayer();
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build());
                mp.setDataSource(MainActivity.this, Uri.parse(uri));
                mp.setLooping(true);          // 背景声要一直有，不做成"放完就停"
                mp.setVolume(musicVol, musicVol);
                mp.setOnPreparedListener(m -> { m.start(); emitMusic("playing", ""); });
                mp.setOnErrorListener((m, what, extra) -> {
                    emitMusic("error", "这个文件播不了（可能被删掉、或者授权失效了）");
                    return true;
                });
                music = mp;
                mp.prepareAsync();            // 大文件不能在主线程 prepare
            } catch (Exception e) {
                emitMusic("error", "播放失败：" + e.getMessage());
            }
        });
    }

    private void musicStopImpl() {
        ui.post(() -> {
            releaseMusic();
            emitMusic("stopped", "");
        });
    }

    /** 只负责放掉播放器；调用方自己决定要不要通知网页 */
    private void releaseMusic() {
        if (music == null) return;
        try { if (music.isPlaying()) music.stop(); } catch (Exception ignored) { }
        try { music.release(); } catch (Exception ignored) { }
        music = null;
    }

    private void musicVolumeImpl(float v) {
        musicVol = Math.max(0f, Math.min(1f, v));
        applyMusicVolume();
    }

    private void musicDuckImpl(boolean on) {
        musicDucked = on;
        applyMusicVolume();
    }

    private void applyMusicVolume() {
        if (music == null) return;
        float v = musicVol * (musicDucked ? 0.35f : 1f);
        try { music.setVolume(v, v); } catch (Exception ignored) { }
    }

    private void musicForgetImpl() {
        ui.post(() -> {
            releaseMusic();
            String uri = Prefs.musicUri(MainActivity.this);
            if (!uri.isEmpty()) {
                try {
                    getContentResolver().releasePersistableUriPermission(Uri.parse(uri),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) { }
            }
            Prefs.setMusic(MainActivity.this, "", "");
            emitMusic("forgot", "");
        });
    }

    private void musicPickImpl() {
        ui.post(() -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("audio/*");
            try {
                startActivityForResult(i, REQ_MUSIC);
            } catch (Exception e) {
                emitMusic("error", "这台手机没有文件选择器");
            }
        });
    }

    // ------------------------------------------------ 聊天截图（OCR 的输入）

    private void shotPickImpl() {
        ui.post(() -> {
            /* 用 GET_CONTENT 而不是 OPEN_DOCUMENT：
               OPEN_DOCUMENT 的语义是「长期访问这个文档」，所以它会走一套
               更重的选择流程；而截图是**用完就扔**的——读完就转成文字，
               App 不留这份文件，也不需要持久化授权（下面 onActivityResult 里
               刻意没有 takePersistableUriPermission）。
               GET_CONTENT 正好是「拿一份内容」这个语义，权限只在这一次有效。 */
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("image/*");
            try {
                startActivityForResult(i, REQ_SHOT);
            } catch (Exception e) {
                emitShot(false, "这台手机没有图片选择器", null);
            }
        });
    }

    /**
     * 把结果回传给网页。**注意这里是 q() 包过的 JSON 字符串**，不是对象字面量：
     * JSONObject.quote 会做转义，直接注入原文迟早被某个字符搞坏。代价是
     * 网页那边必须 JSON.parse 一道——于是漏了这一步就会静默失效，
     * 网页一律走"没数据"的分支。见 voice.js 的 bridgeObj()。 */
    private void emitShot(boolean ok, String why, java.util.List<String> dataUrls) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            if (ok) o.put("dataUrls", new org.json.JSONArray(dataUrls)); else o.put("why", why);
        } catch (Exception ignored) { }
        js("window.__onShot&&window.__onShot(" + q(o.toString()) + ")");
    }

    /**
     * 把选中的图**切成若干段**，每段一个 dataURL。
     *
     * ── 为什么必须切开，以及 2.43 修的那个 bug ──────────────────────
     * 用户报的是「识图能力还是有点差，许多文字都识别不出来」，并提示「长截图切分有问题」。
     * 他猜对了，而且问题的位置比切分更靠前：**是这一步在切分之前就把宽度压没了**。
     *
     * 原来的写法是 `shotToDataUrl(u, 1400)`：把图缩到「最长边 1400」。普通截图是竖的，
     * 最长边就是**高**，于是宽度被一起压掉。算一下就清楚了（34px 的正文，实测值）：
     *     1080×2400  普通截图  → 630×1400，字剩 19.8px（勉强，所以"有些字"认不出）
     *     1080×7334  长截图    → 206×1400，字剩  6.5px
     *     1080×14572 长截图    → 104×1400，字剩  3.3px ← 这个尺寸不可能认得出来
     * 长截图越长的部分是**高**，所以"按最长边缩"对长截图的惩罚恰好最重——
     * 而长截图正是这个功能最该处理好的输入。
     *
     * ── 现在的做法 ───────────────────────────────────────────────
     *   1. **宽度基本不动**（只在上限处收），因为字的清晰度由宽度决定；
     *   2. 竖着切成若干**横段**，每段单独作为一张图送出去；
     *   3. 每段的高度按「模型的像素预算」定：官方会把图缩到约 800×800 的量级，
     *      所以一段只要不超过那个像素数，就**不会被再缩**，字原样保住；
     *   4. 段数有上限（13）：一段一张图，太多会让请求又慢又贵，
     *      而手机上原生 HTTP 的超时是 150 秒。段数顶到上限时接受模型侧再缩一点
     *      （14572 高时约缩到 0.73，字从 34px 到 24px——比原来的 3.3px 好太多）。
     *
     * ── 为什么用 BitmapRegionDecoder ─────────────────────────────
     * 它**逐段解码**：只把当前这一段的像素读进内存，不会为了切一段而整张解码。
     * 1080×14572 整张解码是 63 MB（ARGB_8888），加上白底副本就是 126 MB，
     * 在这种机器上迟早 OOM。而一段 1080×1121 只有 4.8 MB。
     * 它也是框架自带的（API 10+），不引入任何原生库——
     * build_apk.py 里那条「包里一个 lib/ 都不能有」的断言仍然成立。
     */
    private java.util.List<String> shotToDataUrls(Uri u) throws Exception {
        android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        InputStream in1 = getContentResolver().openInputStream(u);
        android.graphics.BitmapFactory.decodeStream(in1, null, bounds);
        if (in1 != null) in1.close();
        int w0 = bounds.outWidth, h0 = bounds.outHeight;
        if (w0 <= 0 || h0 <= 0) throw new Exception("这张图读不出尺寸（可能不是常见图片格式）");

        // 目标宽度：普通手机截图（1080 上下）原样不动，只有特别宽的才收
        int outW = Math.min(w0, SHOT_WIDTH_CAP);
        // 一段多高：先按「模型不会再把这段缩小」的像素预算算
        int bandH = Math.max(1, SHOT_PX_BUDGET / Math.max(1, outW));
        // 段数超上限就把段拉高（宁可让模型少缩一点，也不能发二三十张图出去）
        int parts = (int) Math.ceil(h0 / (double) bandH);
        if (parts > SHOT_MAX_PARTS) parts = SHOT_MAX_PARTS;
        if (parts < 1) parts = 1;
        // 均分，避免最后一段只剩一条缝
        bandH = (int) Math.ceil(h0 / (double) parts);

        java.util.List<String> out = new java.util.ArrayList<>();
        InputStream in2 = getContentResolver().openInputStream(u);
        android.graphics.BitmapRegionDecoder dec = null;
        try {
            dec = android.graphics.BitmapRegionDecoder.newInstance(in2, false);
            if (dec == null) throw new Exception("这张图打不开（解码器不支持）");
            android.graphics.BitmapFactory.Options opt = new android.graphics.BitmapFactory.Options();
            opt.inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888;
            for (int y = 0; y < h0; y += bandH) {
                int hh = Math.min(bandH, h0 - y);
                if (hh <= 8) break;
                android.graphics.Bitmap band = dec.decodeRegion(
                        new android.graphics.Rect(0, y, w0, y + hh), opt);
                if (band == null) continue;
                out.add(encodeFlat(band, outW));
            }
        } finally {
            if (dec != null) dec.recycle();
            if (in2 != null) in2.close();
        }
        if (out.isEmpty()) throw new Exception("这张图切不出内容");
        return out;
    }

    /** 铺白底（截图可能带透明，直接压 JPEG 会变黑，白底黑字就反了）→ 必要时缩宽 → JPEG → dataURL。 */
    private String encodeFlat(android.graphics.Bitmap src, int outW) {
        int w = src.getWidth(), h = src.getHeight();
        android.graphics.Bitmap flat = android.graphics.Bitmap.createBitmap(
                w, h, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas cv = new android.graphics.Canvas(flat);
        cv.drawColor(android.graphics.Color.WHITE);
        cv.drawBitmap(src, 0, 0, null);
        src.recycle();

        if (outW > 0 && w > outW) {
            float k = (float) outW / w;
            android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(
                    flat, outW, Math.max(1, Math.round(h * k)), true);
            if (small != flat) flat.recycle();
            flat = small;
        }

        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        flat.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, bos);
        flat.recycle();
        String b64 = android.util.Base64.encodeToString(
                bos.toByteArray(), android.util.Base64.NO_WRAP);
        return "data:image/jpeg;base64," + b64;
    }

    /** 文件在文件管理器里显示的名字。列表里想让用户认出自己选的是哪首。 */
    private String displayName(Uri u) {
        Cursor c = null;
        try {
            c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME},
                    null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) { }
        }
        String last = u.getLastPathSegment();
        return last == null ? "音乐文件" : last;
    }

    private void emitMusic(String type, String detail) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", type);
            o.put("detail", detail == null ? "" : detail);
            o.put("has", !Prefs.musicUri(MainActivity.this).isEmpty());
            o.put("name", Prefs.musicName(MainActivity.this));
            boolean playing = false;
            try { playing = music != null && music.isPlaying(); } catch (Exception ignored) { }
            o.put("playing", playing);
            o.put("persist", musicPersist);
        } catch (Exception ignored) { }
        js("window.__onMusic&&window.__onMusic(" + q(o.toString()) + ")");
    }

    @Override
    protected void onDestroy() {
        if (tts != null) { tts.stop(); tts.shutdown(); tts = null; }
        releaseMusic();                      // 不留后台播放、不留进程
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ------------------------------------------------------------ 与网页通信

    /** 在 UI 线程上执行一段 JS */
    /** 极简提示。用系统 Toast，不额外引资源。 */
    private void toast(String msg) {
        ui.post(() -> android.widget.Toast.makeText(
                MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show());
    }

    private void js(final String code) {
        ui.post(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    private String q(String s) {   // 转成安全的 JS 字符串字面量
        return JSONObject.quote(s == null ? "" : s);
    }

    // ------------------------------------------------------------ 原生桥

    public class Bridge {

        /** 桥是否可用（网页启动时探一次） */
        @JavascriptInterface
        public String capabilities() {
            JSONObject o = new JSONObject();
            try {
                o.put("tts", ttsReady);
                o.put("http", true);
                o.put("music", true);      // 有 MediaPlayer 就一定能放自己选的文件
                o.put("shot", true);       // 有 BitmapFactory 就一定能读自己选的图
            } catch (Exception ignored) { }
            return o.toString();
        }

        // ---- 每日计划：闸门 / 提醒 ----
        // 这里没有一处用到 root，因为都不需要：
        //   检测「打开了哪个应用」用无障碍服务——这是 Android 上的标准做法，
        //   而且权限范围比 root **更小**：它只拿到包名，读不到界面内容。
        //   提醒用 AlarmManager + 通知。两者系统升级都不会失效。

        /** 网页算完「是否达标」之后推过来。armed=1 表示达标之前要拦。
         *  达标逻辑只在网页那一份，原生只负责执行——两处各算一遍迟早会漂移。 */
        @JavascriptInterface
        public void setGate(int armed, String packagesJson, String summary, int canSkip) {
            Prefs.setGate(MainActivity.this, armed == 1, packagesJson, summary, canSkip == 1);
        }

        /** 新网页分别传用户开关和当天真实达标状态，关闭闸门不等于达标。 */
        @JavascriptInterface
        public void setTrainingState(int enabled, int met, String date,
                                     String packagesJson, String summary, int canSkip) {
            Prefs.setTrainingState(MainActivity.this, enabled == 1, met == 1, date,
                    packagesJson, summary, canSkip == 1);
        }

        /**
         * 深度拦截开关。拦到目标应用之后，除了挤到后台还真的把它杀掉。
         *
         * 它依赖 root，而 root 可能不可用。所以这里不替用户打开，
         * 由网页那边看着 probeRoot 的结果让用户自己点——「以为有保护、
         * 实际没有」比不做更糟，那种状态必须看得见。
         */
        @JavascriptInterface
        public void setDeepBlock(int on) {
            Prefs.setDeepBlock(MainActivity.this, on == 1);
        }

        /** 只是读缓存，不阻塞。真正的探测走 probeRoot()。 */
        @JavascriptInterface
        public String deepBlockStatus() {
            JSONObject o = new JSONObject();
            try {
                Boolean known = RootGate.cached();
                o.put("on", Prefs.deepBlock(MainActivity.this));
                o.put("known", known != null);
                o.put("supported", known != null && known);
            } catch (Exception ignored) { }
            return o.toString();
        }

        /**
         * 探测 root 是否可用。_必须_异步：su 的授权弹窗可能正在等用户点确认，
         * 卡在这里会把发起调用的线程一起拖住。
         */
        @JavascriptInterface
        public void probeRoot() {
            new Thread(() -> {
                RootGate.resetCache();
                final boolean ok = RootGate.available();
                js("window.__onRootProbe && window.__onRootProbe(" + ok + ")");
            }, "eq-root-probe").start();
        }

        /**
         * 防掉线开关。系统在「强行停止」时会把无障碍服务一起撤销，而且不自愈；
         * 开了这个，root 那边跑一个循环，发现被撤销就写回去（实测 1 秒内修回来）。
         *
         * 同样异步：su 那次调用可能弹授权框。做完把结果回传给网页——
         * 成功也回传，因为「看起来开了、其实没跑起来」正是要避免的那种状态。
         */
        @JavascriptInterface
        public void setGateWatch(int on) {
            final boolean want = on == 1;
            Prefs.setGateWatch(MainActivity.this, want);
            new Thread(() -> {
                String why = want ? GateWatch.start(MainActivity.this) : null;
                if (!want) GateWatch.stop(MainActivity.this);
                js("window.__onGateWatch && window.__onGateWatch("
                        + q(GateWatch.status(MainActivity.this))
                        + (why == null ? "" : ", " + q(why)) + ")");
            }, "eq-gate-watch").start();
        }

        /** 读状态，不阻塞、不触发 su：只读心跳文件的时间戳和本地开关。 */
        @JavascriptInterface
        public String gateWatchStatus() {
            return GateWatch.status(MainActivity.this);
        }

        /**
         * 把网页那份进度写成「下载/认知训练/认知训练-进度备份.json」。
         *
         * 卸载时这一份**会留下**（外部存储，卸载不动它），所以重装之后还能捞回来。
         * 这正是用户要的：卸载是唯一的出口，但不能让「想退出」等于「全部归零」。
         *
         * 只写纯文本 .json。不许写脚本、不许把命令落盘——用户对这件事的要求
         * 是「所有进程、代码、脚本都删掉，只留文本数据」，test_bridge.js 有断言。
         * 返回落盘位置；失败返回空串（网页那边会如实显示失败，不假装成功）。
         */
        @JavascriptInterface
        public String backupNow(String json) {
            try {
                String where = BackupStore.write(MainActivity.this, json);
                return where == null ? "" : where;
            } catch (Exception e) {
                return "";
            }
        }

        /** 读回备份内容；没有则返回空串。 */
        @JavascriptInterface
        public String backupRead() {
            try {
                String s = BackupStore.read(MainActivity.this);
                return s == null ? "" : s;
            } catch (Exception e) {
                return "";
            }
        }

        /** 备份状态（给界面显示）。ok=false 时 msg 说明原因。 */
        @JavascriptInterface
        public String backupStatus() {
            try {
                return BackupStore.status(MainActivity.this).toString();
            } catch (Exception e) {
                return "{\"ok\":false,\"msg\":\"状态读取失败\"}";
            }
        }

        /** 旧版系统（Android 9 及以下）写公共目录要存储权限；新版不需要，直接返回 1。 */
        @JavascriptInterface
        public int requestBackupPermission() {
            if (Build.VERSION.SDK_INT >= 29) return 1;
            if (BackupStore.legacyPermitted(MainActivity.this)) return 1;
            ui.post(() -> requestPermissions(
                    new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, REQ_STORAGE));
            return 0;
        }

        @JavascriptInterface
        public void scheduleReminder(int enabled, int hour, int minute) {
            Prefs.setReminder(MainActivity.this, enabled == 1, hour, minute);
            if (enabled == 1) {
                ReminderReceiver.schedule(MainActivity.this, hour, minute);
            } else {
                ReminderReceiver.cancel(MainActivity.this);
            }
        }

        /** 设置页的「发一条试试」——通知权限有没有给，试一次就知道 */
        @JavascriptInterface
        public void testReminder() {
            ui.post(() -> ReminderReceiver.notifyNow(MainActivity.this));
        }

        @JavascriptInterface
        public boolean hasAccessibility() {
            String flat = Settings.Secure.getString(getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (flat == null) return false;
            return flat.contains(getPackageName() + "/" + GateService.class.getName())
                    || flat.contains(getPackageName() + "/.GateService");
        }

        @JavascriptInterface
        public boolean hasNotifPermission() {
            return MainActivity.this.hasNotifPermission();
        }

        @JavascriptInterface
        public void requestNotif() {
            ui.post(() -> {
                if (Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
                } else {
                    toast("这个安卓版本不需要单独授权通知");
                }
            });
        }

        @JavascriptInterface
        public boolean hasOverlayPermission() {
            return Settings.canDrawOverlays(MainActivity.this);
        }

        @JavascriptInterface
        public void openOverlaySettings() {
            ui.post(() -> {
                try {
                    Intent it = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Exception e) {
                    toast("打不开悬浮窗设置：设置 → 应用 → 特殊权限 → 显示在其他应用上层");
                }
            });
        }

        @JavascriptInterface
        public void openAccessibilitySettings() {
            ui.post(() -> {
                try {
                    Intent it = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Exception e) {
                    toast("打不开无障碍设置：设置 → 无障碍 → 已安装的服务");
                }
            });
        }

        /** 跳到本应用的系统详情页——查包名、看权限都在那里 */
        @JavascriptInterface
        public void openAppSettings() {
            ui.post(() -> {
                try {
                    Intent it = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Exception ignored) { }
            });
        }

        // ---- 语音合成 ----
        @JavascriptInterface
        public void speak(String text, float rate, float pitch) {
            if (tts == null || !ttsReady) {
                js("window.__onSpeak&&window.__onSpeak('unavailable')");
                return;
            }
            applyVoice();      // 引擎可能被换过，合成前确认一次（不同才真切换，见 applyVoice）
            tts.setSpeechRate(rate <= 0 ? 1f : rate);
            tts.setPitch(pitch <= 0 ? 1f : pitch);
            tts.speak(text == null ? "" : text, TextToSpeech.QUEUE_FLUSH, null,
                    "u" + System.currentTimeMillis());
        }

        @JavascriptInterface
        public void stopSpeak() {
            if (tts != null) tts.stop();
        }

        /* 中文音色列表。
         *
         * 这个方法原来就存在，但**网页侧一次都没调用过**——所以用户从来没能挑过音色，
         * 一直用系统默认那个嗓子。用户这次问的「语音包」在 Android 上就是这个：
         * 系统合成引擎自带多个音色（Google、讯飞、华为、小米各不一样），
         * 有的还要额外下载语音数据。
         *
         * 返回结构化信息而不是光秃秃的名字：音色名（如 zh-cn-x-ccc-local）对用户
         * 毫无意义，真正决定「听起来像不像真人」的是这些字段——
         * 是否要联网（要联网的通常音质更好）、quality、以及**是否已下载**。
         * 显示用的中文由网页侧拼，UI 文案统一放在网页层。 */
        @JavascriptInterface
        public String voices() {
            JSONArray arr = new JSONArray();
            if (tts == null) return arr.toString();
            try {
                for (android.speech.tts.Voice v : tts.getVoices()) {
                    if (v == null || v.getName() == null) continue;
                    Locale lo = v.getLocale();
                    if (lo == null) continue;
                    boolean zh = "zh".equalsIgnoreCase(lo.getLanguage());
                    if (!zh) continue;
                    java.util.Set<String> f = v.getFeatures();
                    boolean notInstalled = f != null
                            && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED);
                    JSONObject o = new JSONObject();
                    o.put("name", v.getName());
                    o.put("locale", lo.toLanguageTag());
                    o.put("quality", v.getQuality());
                    o.put("latency", v.getLatency());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("installed", !notInstalled);
                    arr.put(o);
                }
            } catch (Exception ignored) { }
            return arr.toString();
        }

        /** 选音色。传空串 = 自动（回到 setLanguage 选的默认音色）。 */
        @JavascriptInterface
        public void setVoice(String name) {
            desiredVoice = name == null ? "" : name;
            ui.post(MainActivity.this::applyVoice);
        }

        /** 当前实际生效的音色名，供网页显示——避免「选了但没生效」却看不出来。 */
        @JavascriptInterface
        public String currentVoice() {
            try {
                if (tts != null) {
                    android.speech.tts.Voice v = tts.getVoice();
                    if (v != null && v.getName() != null) return v.getName();
                }
            } catch (Exception ignored) { }
            return "";
        }

        /* 去系统里下载更多音色。
         * 这是 Android 自带的机制：合成引擎（如 Google 语音服务）把音色做成
         * 可下载的数据包，装完之后上面的 voices() 里就会多出来——也就是用户说的
         * 「语音包」。App 自己不做音色包，那等于把几十 MB 塞进安装包，
         * 而且质量还不如系统引擎自带的。 */
        @JavascriptInterface
        public void installVoiceData() {
            try {
                Intent it = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it);
            } catch (Exception e) {
                openTtsSettings();
            }
        }

        /** 打开系统的文字转语音设置（换引擎、下语音包都在那里）。 */
        @JavascriptInterface
        public void openTtsSettings() {
            try {
                Intent it = new Intent(TextToSpeech.Engine.ACTION_CHECK_TTS_DATA);
                it = new Intent("com.android.settings.TTS_SETTINGS");
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it);
            } catch (Exception e) {
                toast("这台手机没有语音设置页，可以在系统设置里搜「文字转语音」");
            }
        }

        // ---- 已安装应用（给闸门选目标用）----
        //
        // 用户的原话：「那个包名太麻烦了，你直接读取应用，然后我告诉你选哪些就行。」
        // 之前只能手打包名（com.tencent.tmgp.sgame 这种），打错一个字母闸门就永远不触发，
        // 而界面上不会有任何异常——只让人觉得「这功能没用」。
        //
        // 只查**有启动图标的应用**（MAIN/LAUNCHER），所以既能拿到用户真正会点开的那些，
        // 又不需要 QUERY_ALL_PACKAGES 这个广权限：manifest 里用一个 <queries> 声明
        // 这个 intent 就够了（Android 11+ 的包可见性规则）。这个 App 的底线是不做
        // 流氓软件，能不多要一个权限就不多要。
        //
        // 顺便把包名从「用户要背的东西」变成「挑一下就行」，也就顺手消掉了
        // 「包名校验失败」这个失败模式。
        @JavascriptInterface
        public String listApps() {
            JSONArray arr = new JSONArray();
            try {
                Intent main = new Intent(Intent.ACTION_MAIN, null);
                main.addCategory(Intent.CATEGORY_LAUNCHER);
                PackageManager pm = getPackageManager();
                List<ResolveInfo> ris = pm.queryIntentActivities(main, 0);
                final String self = getPackageName();
                List<Object[]> rows = new ArrayList<>();
                for (ResolveInfo ri : ris) {
                    if (ri == null || ri.activityInfo == null) continue;
                    String pkg = ri.activityInfo.packageName;
                    if (pkg == null || pkg.isEmpty() || pkg.equals(self)) continue;
                    CharSequence cs = ri.loadLabel(pm);
                    String label = cs == null ? "" : cs.toString().trim();
                    if (label.isEmpty()) label = pkg;
                    rows.add(new Object[]{label, pkg});
                }
                // 同一个应用可能有多个启动入口（如微信和它的某个插件），按包名去重，
                // 标签取最短的那个（通常就是主入口）。
                Collections.sort(rows, new Comparator<Object[]>() {
                    @Override public int compare(Object[] a, Object[] b) {
                        return ((String) a[0]).compareTo((String) b[0]);
                    }
                });
                java.util.HashSet<String> seen = new java.util.HashSet<>();
                for (Object[] r : rows) {
                    String pkg = (String) r[1];
                    if (!seen.add(pkg)) continue;
                    JSONObject o = new JSONObject();
                    o.put("label", (String) r[0]);
                    o.put("pkg", pkg);
                    arr.put(o);
                }
            } catch (Exception e) {
                // 出错就返回空数组，网页侧会显示「一个都没读到」而不是崩掉
            }
            return arr.toString();
        }

        // ---- 网络（转发到 MainActivity 上的实现）----
        //
        // 这两个转发不是多余的：httpPost / httpGet 原来写在 MainActivity 上而不是
        // Bridge 里，所以 WebView 里根本看不到 EQNative.httpPost，一调用就抛
        // "httpPost is not a function"。浏览器里走的是 /api/proxy，正好绕开这条路，
        // 所以只在真机上炸——表现是语音陪练和另外两个 AI 模块全部失效。
        //
        // 教训：**只有 @JavascriptInterface 方法写在 Bridge 类里面才会被暴露给网页。**
        // 缩进差四个空格，就是「能编译、能装上、一用就废」。
        // 现在 tools/test_bridge.js 会做静态交叉检查，把这类错误挡在构建之前。
        @JavascriptInterface
        public void httpPost(String reqId, String url, String headersJson, String body) {
            MainActivity.this.httpPost(reqId, url, headersJson, body);
        }

        @JavascriptInterface
        public void httpGet(String reqId, String url, String headersJson) {
            MainActivity.this.httpGet(reqId, url, headersJson);
        }

        // ---- 背景音乐（用户自己手机里的文件）----
        // 同上：这几个必须在 Bridge 里面，否则网页那边一调用就是
        // "EQNative.musicPlay is not a function"，而且只在真机上炸。

        @JavascriptInterface
        public void musicPick() { musicPickImpl(); }
        @JavascriptInterface
        public void shotPick() { shotPickImpl(); }

        @JavascriptInterface
        public void musicPlay() { musicPlayImpl(); }

        @JavascriptInterface
        public void musicStop() { musicStopImpl(); }

        @JavascriptInterface
        public void musicForget() { musicForgetImpl(); }

        @JavascriptInterface
        public void musicSetVolume(float v) { musicVolumeImpl(v); }

        /** 她在说话时压低音乐。和合成音轨用的是同一条规则（0.35 倍）。 */
        @JavascriptInterface
        public void musicDuck(boolean on) { musicDuckImpl(on); }

        /** 网页打开设置页时问一次：现在选的是什么、在放吗。 */
        @JavascriptInterface
        public void musicState() { emitMusic("state", ""); }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_NOTIF) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            // 让网页那边刷新状态，否则设置页会一直显示「还没给」
            js("window.__onPerm&&window.__onPerm('notif'," + (ok ? "true" : "false") + ")");
            return;
        }
        if (code == REQ_STORAGE) {
            // 只有 Android 9 及以下会走到这里。让网页刷新备份区，别让它一直显示「要授权」。
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            js("window.__onPerm&&window.__onPerm('storage'," + (ok ? "true" : "false") + ")");
            return;
        }
        /* 这里原来还有 REQ_AUDIO 的三个分支（等麦克风权限，授权回来接着开始识别）。
           2.31 语音输入整块删掉之后它们跟着没了——现在 App 只申请通知和存储两种权限。 */
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);

        if (code == REQ_MUSIC) {
            if (result != RESULT_OK || data == null || data.getData() == null) {
                emitMusic("cancel", "");
                return;
            }
            Uri u = data.getData();
            /* 持久化授权：拿到之后重启 App 也还能读这个文件。
               拿不到就在界面上如实说明"这次能用、重启可能要重选"——
               不能让用户下次打开发现放不了、却不知道为什么。 */
            musicPersist = false;
            try {
                getContentResolver().takePersistableUriPermission(
                        u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                musicPersist = true;
            } catch (Exception ignored) { }
            Prefs.setMusic(this, u.toString(), displayName(u));
            emitMusic("picked", displayName(u));
            musicPlayImpl();               // 选完直接放，不然用户还要再点一下
            return;
        }

        if (code == REQ_SHOT) {
            /* 三种失败分开报，别都写成一句「没选到图片」。
               一句笼统的话在真机上排查不了：到底是用户真的取消了、
               选择器没给数据、还是给了个空地址？这三件事的下一步完全不同。
               （第一次实现就是笼统的一句话，结果连自己在哪一步失败都看不出来。） */
            if (result != RESULT_OK) {
                emitShot(false, "在选择器里取消了", null);
                return;
            }
            if (data == null) {
                emitShot(false, "选择器没有返回任何数据", null);
                return;
            }
            final Uri u = data.getData();
            if (u == null) {
                emitShot(false, "选择器返回了一个空地址（可能是这个图片选择器不兼容）", null);
                return;
            }
            /* 读图 + 编码放到后台线程：一张几 MB 的图解码要几百毫秒，
               在主线程做会让界面卡一下（用户的感觉是"点了没反应"）。
               这里的授权不用持久化——截图是**这一次**要用的东西，
               不该让这个 App 长期握着你相册里某张图的读取权。 */
            new Thread(() -> {
                try {
                    java.util.List<String> urls = shotToDataUrls(u);
                    emitShot(true, null, urls);
                } catch (Throwable t) {
                    emitShot(false, "读图失败：" + t.getMessage(), null);
                }
            }).start();
            return;
        }
    }

    // ------------------------------------------------------------ 原生 HTTPS

    /** 真正的实现。注意这里**没有** @JavascriptInterface——它在 Bridge 外面，
     *  加了也不会被暴露给网页（这正是之前那个 bug 的成因）。
     *  网页调用的是 Bridge 里那两个转发方法。 */
    private boolean isAllowedNetworkUrl(String raw) {
        try {
            URI u = new URI(raw);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (!"https".equalsIgnoreCase(scheme) || host == null || host.isEmpty()) return false;
            String h = host.toLowerCase(java.util.Locale.US);
            if (h.equals("localhost") || h.equals("127.0.0.1") || h.equals("::1") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("172.16.") || h.startsWith("172.17.") || h.startsWith("172.18.") || h.startsWith("172.19.") || h.startsWith("172.20.") || h.startsWith("172.21.") || h.startsWith("172.22.") || h.startsWith("172.23.") || h.startsWith("172.24.") || h.startsWith("172.25.") || h.startsWith("172.26.") || h.startsWith("172.27.") || h.startsWith("172.28.") || h.startsWith("172.29.") || h.startsWith("172.30.") || h.startsWith("172.31.")) return false;
            return true;
        } catch (Exception e) { return false; }
    }

    private void rejectNetwork(String reqId, String message) {
        JSONObject out = new JSONObject();
        try { out.put("status", 400); out.put("error", message); } catch (Exception ignored) { }
        js("window.__onHttp&&window.__onHttp(" + q(reqId) + "," + q(out.toString()) + ")");
    }

    public void httpPost(final String reqId, final String url,
                         final String headersJson, final String body) {
        if (!isAllowedNetworkUrl(url)) { rejectNetwork(reqId, "仅允许 HTTPS 公网地址"); return; }
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(20000);
                c.setReadTimeout(180000);
                c.setDoOutput(true);
                JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                java.util.Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    c.setRequestProperty(k, h.getString(k));
                }
                byte[] payload = (body == null ? "" : body).getBytes("UTF-8");
                c.setRequestProperty("Content-Length", String.valueOf(payload.length));
                try (OutputStream os = c.getOutputStream()) { os.write(payload); }

                int code = c.getResponseCode();
                InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
                StringBuilder sb = new StringBuilder();
                if (in != null) {
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                        String line;
                        while ((line = r.readLine()) != null) sb.append(line).append('\n');
                    }
                }
                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", sb.toString());
                js("window.__onHttp&&window.__onHttp(" + q(reqId) + "," + q(out.toString()) + ")");
            } catch (Exception e) {
                try {
                    JSONObject out = new JSONObject();
                    out.put("status", 0);
                    out.put("error", String.valueOf(e.getMessage()));
                    js("window.__onHttp&&window.__onHttp(" + q(reqId) + "," + q(out.toString()) + ")");
                } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    /** 也支持 GET，方便以后扩展 */
    public void httpGet(final String reqId, final String url, final String headersJson) {
        if (!isAllowedNetworkUrl(url)) { rejectNetwork(reqId, "仅允许 HTTPS 公网地址"); return; }
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("GET");
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                java.util.Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    c.setRequestProperty(k, h.getString(k));
                }
                int code = c.getResponseCode();
                InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
                StringBuilder sb = new StringBuilder();
                if (in != null) {
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                        String line;
                        while ((line = r.readLine()) != null) sb.append(line).append('\n');
                    }
                }
                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", sb.toString());
                js("window.__onHttp&&window.__onHttp(" + q(reqId) + "," + q(out.toString()) + ")");
            } catch (Exception e) {
                try {
                    JSONObject out = new JSONObject();
                    out.put("status", 0);
                    out.put("error", String.valueOf(e.getMessage()));
                    js("window.__onHttp&&window.__onHttp(" + q(reqId) + "," + q(out.toString()) + ")");
                } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }
}
