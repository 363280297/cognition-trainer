"""给 Android 侧加「音色包」能力和识别精度开关。

查出来的三件事（都是「看起来有、其实没有」）：
 1. `voices()` 方法早就写好了，**但网页侧一次都没调用过**——死代码，
    所以用户从来没能挑过音色，一直用系统默认那个嗓子。
 2. 没有 `setVoice()`，所以就算列出音色也选不了。
 3. 识别写死了 `EXTRA_PREFER_OFFLINE = true`，**强制走离线识别**。
    离线中文识别的模型很小，准确率明显差于在线引擎。而这条路的解释是
    「能离线就别联网」——可是 AI 对话本身**就必须联网**（要调大模型），
    所以这里强制离线不但没换来离线能力，只是白白牺牲了准确率。

这个改动把三件事一起修：让音色真的能挑、能试听、能引导去系统里下载更多，
以及把识别精度交还给用户（默认优先在线）。
"""
import io
import os

P = r'E:\android-build\app\src\com\local\cognitiontrainer\MainActivity.java'


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    s = io.open(P, encoding='utf-8').read()

    # ---------- 1) 记住用户选的音色，并在合成前确保生效 ----------
    s = sub(s, """    private TextToSpeech tts;
    private volatile boolean ttsReady = false;""",
            """    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    /* 用户选的音色名。空串 = 自动（用 setLanguage 选的默认音色）。
       存成字段而不是每次都 setVoice：setVoice 在部分引擎上要花几十毫秒，
       而 speak() 是每句话都会走的热路径。只在「和当前生效的不一样」时才切。 */
    private volatile String desiredVoice = "";
    private volatile String appliedVoice = null;""", tag='field')

    # ---------- 2) initTts：应用已保存的音色 ----------
    s = sub(s, """            int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
            ttsReady = (r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED);""",
            """            int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
            ttsReady = (r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED);
            applyVoice();""", tag='initApply')

    # ---------- 3) 替换掉那个没人调用的 voices()，并加上 setVoice / 下载 / 系统设置 ----------
    s = sub(s, """        /** 中文语音列表，供网页挑音色（不同手机差异很大） */
        @JavascriptInterface
        public String voices() {
            if (tts == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (android.speech.tts.Voice v : tts.getVoices()) {
                String n = v.getName();
                if (n == null || !n.toLowerCase(Locale.ROOT).contains("zh")) continue;
                if (!first) sb.append(",");
                sb.append(JSONObject.quote(n));
                first = false;
            }
            return sb.append("]").toString();
        }""",
            """        /* 中文音色列表。
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
        }""", tag='voices')

    # ---------- 4) applyVoice 的实体 ----------
    s = sub(s, """    private void initTts() {""",
            """    /* 把 desiredVoice 落到实处。可能失败（音色被卸载了、引擎换了），
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

    private void initTts() {""", tag='applyVoice')

    # ---------- 5) speak 之前确保音色生效 ----------
    s = sub(s, """            if (tts == null || !ttsReady) {
                js("window.__onSpeak&&window.__onSpeak('unavailable')");
                return;
            }
            tts.setSpeechRate(rate <= 0 ? 1f : rate);""",
            """            if (tts == null || !ttsReady) {
                js("window.__onSpeak&&window.__onSpeak('unavailable')");
                return;
            }
            applyVoice();      // 引擎可能被换过，合成前确认一次（不同才真切换，见 applyVoice）
            tts.setSpeechRate(rate <= 0 ? 1f : rate);""", tag='speak')

    # ---------- 6) 识别：不要强制离线 ----------
    s = sub(s, """        @JavascriptInterface
        public void listen() {""",
            """        /* preferOffline：true = 只用离线识别（不联网），false = 优先用在线识别。
         *
         * 原来这里是写死的 `EXTRA_PREFER_OFFLINE = true`，也就是**强制离线**。
         * 那条注释的理由是「能离线就别联网，也避免被墙的云引擎拖住」，但这里不成立：
         * AI 对话**本身就必须联网**（要调大模型），所以强制离线换不来任何离线能力，
         * 只是白白牺牲了准确率——离线中文识别的模型比在线小得多，长句子错得更多。
         * 于是改成由用户选，默认优先在线。
         */
        @JavascriptInterface
        public void listen(boolean preferOffline) {""", tag='listenSig')

    # 两个调用点，文本一模一样，得靠上下文区分：
    # 一处是当场开始听，另一处是「授权之后重试」——那一处要记住刚才请求的是哪种模式
    s = sub(s, """                        new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO));
                return;
            }
            startListening();""",
            """                        new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO));
                return;
            }
            startListening(preferOffline);""", tag='listenCall1')

    s = sub(s, """        if (granted && wantListen) {
            wantListen = false;
            startListening();""",
            """        if (granted && wantListen) {
            wantListen = false;
            // 授权是异步的：这次重试要用**当初请求时**那个模式，
            // 否则用户选了「优先离线」、点了允许，结果却按在线跑
            startListening(pendingPreferOffline);""", tag='listenCall2')

    s = sub(s, """    private boolean wantListen = false;      // 用户点了录音但等权限""",
            """    private boolean wantListen = false;      // 用户点了录音但等权限
    private volatile boolean pendingPreferOffline = false;  // 等权限期间记住要哪种识别模式""",
            tag='pendingField')

    s = sub(s, """                wantListen = true;""",
            """                wantListen = true;
                pendingPreferOffline = preferOffline;""", tag='pendingSet')

    s = sub(s, """    private void startListening() {
        ui.post(() -> {""", """    private void startListening(final boolean preferOffline) {
        ui.post(() -> {""", tag='startListeningSig')

    s = sub(s, """                // 优先离线引擎：能离线就别联网，也避免被墙的云引擎拖住
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);""",
            """                // 由用户选：默认优先在线（更准）。离线那条路只在用户明确要求时走。
                // 注意 EXTRA_PREFER_OFFLINE 只是「优先」，引擎仍然可以自己决定——
                // 所以要如实告诉用户这是偏好而不是保证。
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
                // 让引擎尽量用长句模型：短句模型会在第一个停顿就切句，中文长句容易被截断
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1000L);""",
            tag='preferOffline')

    io.open(P, 'w', encoding='utf-8').write(s)
    print('MainActivity：音色可挑/可试听/可下载，识别不再强制离线')


if __name__ == '__main__':
    main()
