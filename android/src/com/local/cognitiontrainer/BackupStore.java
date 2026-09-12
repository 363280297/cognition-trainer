package com.local.cognitiontrainer;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 把训练记录作为**纯文本**留一份在公共「下载」目录里。
 *
 * ---------------------------------------------------------------- 为什么要有它
 *
 * 闸门的原设计曾把「卸载」写成唯一出口（现已改为如实说明退出路径）。
 * 但卸载的代价原本是「全部归零」——
 * 几个月的偏差画像、你自己写的预案、身份陈述，一次卸载全没。用户明确把这条
 * 放宽了：卸载之后**文本数据可以留下来**（要清掉他自己用清理软件清）。
 * 这一条是有道理的：让「想退出」等于「全部毁掉」，那是在惩罚用户，
 * 而在这个 App 的整体立场上，惩罚性设计正是要避免的东西。
 *
 * ------------------------------------------------- 另一半要求（更重要，别搞丢）
 *
 * 用户同一次要求里还有后半句：「所有的进程、代码、脚本那些都要删掉，
 * 只留下文本数据。」也就是说卸载之后**磁盘上不许剩下任何可执行的东西**。
 * 这条约束的含义是：
 *   - 这里只允许写一个 `.json` 纯文本文件，**永远不许写 .sh / .dex / .apk / .js**，
 *     也不许把任何 shell 命令落到磁盘上；
 *   - root 那条路（RootGate）必须继续是「一次性 ProcessBuilder 调用」，
 *     不许改成写一个脚本再执行——那样脚本就留在磁盘上了，正好违反这条。
 * tools/test_bridge.js 里有断言盯着这两点。
 *
 * ------------------------------------------------------------------ 权限说明
 *
 * API 29+（绝大多数机器）走 MediaStore.Downloads，**不需要任何权限**。
 * API 26–28 只能走公共目录直写，需要 WRITE_EXTERNAL_STORAGE，所以清单里那个
 * 权限带 maxSdkVersion="28"——新系统上根本不会被请求。
 *
 * 写清楚一件不确定的事：**卸载重装之后能不能读回这个文件，是不保证的。**
 * 文件一定还在（这是外部存储，卸载不动它），但 MediaStore 的归属是按
 * 包名/UID 记的，重装之后 UID 变了，读权限可能就不给了。
 * 所以这里不去假装一定能读回来：新文件发布之前会立刻**回读校验**一次，
 * 字节不一致或读不回来就返回失败，保留上一份有效备份。
 * 这是这个 App 一贯的做法——
 * 宁可显示一个难看的真相，也不显示一个好看的空话。
 */
final class BackupStore {

    /** 目录和文件名都写成中文，是为了让用户在文件管理器里一眼认出这是什么，
     *  以及一眼看出它是**数据**不是程序。 */
    static final String DIR_NAME = "认知训练";
    static final String FILE_NAME = "认知训练-进度备份.json";
    private static final String MIME = "application/json";

    private BackupStore() { }

    // ------------------------------------------------------------ 对外接口

    /** 写一份备份。返回落盘位置的可读描述；失败返回 null。 */
    static synchronized String write(Context c, String text) {
        if (!validText(text)) return null;
        if (Build.VERSION.SDK_INT >= 29) {
            return new Api29().write(c, text);
        }
        return new LegacyStore(new LegacyIo()).write(c, text);
    }

    /** 读回备份内容；没有或读不到返回 null。 */
    static synchronized String read(Context c) {
        if (Build.VERSION.SDK_INT >= 29) {
            return new Api29().read(c);
        }
        return new LegacyStore(new LegacyIo()).read(c);
    }

    /**
     * 状态：给界面用的。ok=false 时 msg 说明原因，绝不用「看起来成功了」糊过去。
     */
    static JSONObject status(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", FILE_NAME);
            o.put("where", "下载/" + DIR_NAME + "/");
            boolean legacy = Build.VERSION.SDK_INT < 29;
            o.put("needsPerm", legacy && !legacyPermitted(c));
            String body = read(c);
            if (body == null) {
                o.put("ok", false);
                o.put("msg", legacy && !legacyPermitted(c)
                        ? "旧版系统（Android 9 及以下）需要存储权限才能写公共目录"
                        : "还没有备份文件");
            } else {
                o.put("ok", true);
                o.put("bytes", body.getBytes("UTF-8").length);
                o.put("msg", "已有备份");
            }
        } catch (Exception e) {
            try { o.put("ok", false); o.put("msg", "读取状态失败"); } catch (Exception ignored) { }
        }
        return o;
    }

    // ------------------------------------------------------------ API 29+

    /** 单独放一个内部类：MediaStore.Downloads 在 API 26 上不存在，
     *  放在这个类里就只会在真正需要时被加载，老系统上不会碰它。 */
    private static final class Api29 {
        private static final String PATH = Environment.DIRECTORY_DOWNLOADS + "/" + DIR_NAME;
        private static final Pattern NUMBERED_NAME = Pattern.compile(
                Pattern.quote(FILE_NAME.substring(0, FILE_NAME.length() - 5)) + " \\([1-9][0-9]*\\)\\.json");

        String write(Context c, String text) {
            ContentResolver r = c.getContentResolver();
            Uri uri = null;
            boolean published = false;
            try {
                // 查询失败时不开始替换；只清理本次写入之前已存在的已发布记录。
                List<Uri> old = candidates(r);
                byte[] expected = text.getBytes("UTF-8");
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, FILE_NAME);
                v.put(MediaStore.Downloads.MIME_TYPE, MIME);
                v.put(MediaStore.Downloads.RELATIVE_PATH, PATH + "/");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return null;
                try (OutputStream os = r.openOutputStream(uri, "wt")) {
                    if (os == null) throw new IOException("Cannot open backup output");
                    os.write(expected);
                }
                // 必须验证刚写的 URI；不能用 read(c) 把另一份旧文件当成校验成功。
                try (InputStream in = r.openInputStream(uri)) {
                    verify(expected, readBytes(in));
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Downloads.IS_PENDING, 0);
                if (r.update(uri, ready, null, null) != 1) throw new IOException("Cannot publish backup");
                published = true;

                // 发布是提交点。此后的清理/改名失败不能回滚、删除已提交的新备份。
                boolean cleared = true;
                for (Uri previous : old) {
                    try { if (r.delete(previous, null, null) != 1) cleared = false; }
                    catch (Exception ignored) { cleared = false; }
                }
                boolean canonicalName = false;
                if (cleared) {
                    try {
                        ContentValues name = new ContentValues();
                        name.put(MediaStore.Downloads.DISPLAY_NAME, FILE_NAME);
                        canonicalName = r.update(uri, name, null, null) == 1;
                    } catch (Exception ignored) { }
                }
                // 清理或改名未确认成功时，新文件可能仍带编号；不要指向旧的同名文件。
                return "下载/" + DIR_NAME + "/" + (canonicalName ? FILE_NAME : "");
            } catch (Exception e) {
                return null;
            } finally {
                if (uri != null && !published) {
                    try { r.delete(uri, null, null); } catch (Exception ignored) { }
                }
            }
        }

        /** MediaStore 的同名文件会带编号。限定目录，兼容旧名称和编号名称，
         *  排除未发布文件；同秒创建的文件以 ID 排序，保证选择顺序确定。 */
        private List<Uri> candidates(ContentResolver r) throws IOException {
            List<Uri> found = new ArrayList<>();
            try (Cursor cur = r.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                    "(" + MediaStore.Downloads.RELATIVE_PATH + "=? OR "
                            + MediaStore.Downloads.RELATIVE_PATH + "=?) AND "
                            + MediaStore.Downloads.IS_PENDING + "=0",
                    new String[]{PATH + "/", PATH},
                    MediaStore.Downloads.DATE_ADDED + " DESC, " + MediaStore.Downloads._ID + " DESC")) {
                if (cur == null) throw new IOException("Cannot query backups");
                while (cur.moveToNext()) {
                    String name = cur.getString(1);
                    if (FILE_NAME.equals(name) || (name != null && NUMBERED_NAME.matcher(name).matches())) {
                        found.add(Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cur.getString(0)));
                    }
                }
            }
            return found;
        }

        String read(Context c) {
            ContentResolver r = c.getContentResolver();
            try {
                for (Uri uri : candidates(r)) {
                    try (InputStream in = r.openInputStream(uri)) {
                        String body = validBody(readBytes(in));
                        if (body != null) return body;
                    } catch (Exception ignored) { }
                }
            } catch (Exception ignored) { }
            return null;
        }
    }

    // ------------------------------------------------------ API 26–28 直写

    private static File legacyFile() {
        File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        return new File(new File(dl, DIR_NAME), FILE_NAME);
    }

    static boolean legacyPermitted(Context c) {
        return c.checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE")
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** 文件系统边界单独封装，故障测试可替换 I/O，仍执行同一套提交逻辑。 */
    static class LegacyIo {
        File stage(File dir) throws IOException {
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create backup directory");
            return File.createTempFile("认知训练-待发布-", ".json", dir);
        }
        FileOutputStream output(File file) throws IOException { return new FileOutputStream(file); }
        InputStream input(File file) throws IOException { return new FileInputStream(file); }
        void sync(FileOutputStream out) throws IOException { out.getFD().sync(); }
        void publish(File staged, File target) throws IOException {
            // 同目录原子替换；不支持原子移动就失败，绝不退回先删旧文件的做法。
            Files.move(staged.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        }
        void discard(File file) throws IOException { Files.deleteIfExists(file.toPath()); }
    }

    static final class LegacyStore {
        private final LegacyIo io;
        LegacyStore(LegacyIo io) { this.io = io; }

        String write(Context c, String text) {
            if (!legacyPermitted(c) || !validText(text)) return null;
            File staged = null;
            try {
                File target = legacyFile();
                staged = io.stage(target.getParentFile());
                byte[] expected = text.getBytes("UTF-8");
                try (FileOutputStream out = io.output(staged)) {
                    out.write(expected);
                    io.sync(out);
                }
                try (InputStream in = io.input(staged)) {
                    verify(expected, readBytes(in));
                }
                io.publish(staged, target);
                return "下载/" + DIR_NAME + "/" + FILE_NAME;
            } catch (Exception e) {
                return null;
            } finally {
                if (staged != null) {
                    try { io.discard(staged); } catch (Exception ignored) { }
                }
            }
        }

        String read(Context c) {
            if (!legacyPermitted(c)) return null;
            try (InputStream in = io.input(legacyFile())) {
                return validBody(readBytes(in));
            } catch (Exception e) {
                return null;
            }
        }
    }

    private static boolean validText(String text) {
        if (text == null || text.isEmpty()) return false;
        try {
            if (!text.equals(new String(text.getBytes("UTF-8"), "UTF-8"))) return false;
            return new StrictJson(text).objectDocument();
        } catch (Exception e) {
            return false;
        }
    }

    /** Android JSONTokener accepts comments and other extensions that JSON.parse rejects. */
    private static final class StrictJson {
        private final String text;
        private int at;
        StrictJson(String text) { this.text = text; }
        boolean objectDocument() { ws(); boolean ok = object(); ws(); return ok && at == text.length(); }
        private boolean value() {
            ws(); if (at >= text.length()) return false;
            char c = text.charAt(at);
            if (c == '{') return object(); if (c == '[') return array(); if (c == '"') return string();
            if (c == 't') return literal("true"); if (c == 'f') return literal("false");
            if (c == 'n') return literal("null"); return number();
        }
        private boolean object() {
            if (!take('{')) return false; ws(); if (take('}')) return true;
            while (true) { if (!string()) return false; ws(); if (!take(':') || !value()) return false;
                ws(); if (take('}')) return true; if (!take(',')) return false; ws(); }
        }
        private boolean array() {
            if (!take('[')) return false; ws(); if (take(']')) return true;
            while (true) { if (!value()) return false; ws(); if (take(']')) return true;
                if (!take(',')) return false; ws(); }
        }
        private boolean string() {
            if (!take('"')) return false;
            while (at < text.length()) {
                char c = text.charAt(at++); if (c == '"') return true; if (c < 0x20) return false;
                if (c != '\\') continue; if (at >= text.length()) return false;
                char escaped = text.charAt(at++); if ("\"\\/bfnrt".indexOf(escaped) >= 0) continue;
                if (escaped != 'u' || at + 4 > text.length()) return false;
                for (int i = 0; i < 4; i++) { char hex = text.charAt(at++);
                    if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') || (hex >= 'A' && hex <= 'F'))) return false; }
            }
            return false;
        }
        private boolean number() {
            int start = at; take('-');
            if (take('0')) { if (at < text.length() && Character.isDigit(text.charAt(at))) return false; }
            else { if (at >= text.length() || text.charAt(at) < '1' || text.charAt(at) > '9') return false;
                while (at < text.length() && Character.isDigit(text.charAt(at))) at++; }
            if (take('.')) { int digits = at; while (at < text.length() && Character.isDigit(text.charAt(at))) at++; if (digits == at) return false; }
            if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
                at++; if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
                int digits = at; while (at < text.length() && Character.isDigit(text.charAt(at))) at++; if (digits == at) return false; }
            return at > start;
        }
        private boolean literal(String want) { if (!text.regionMatches(at, want, 0, want.length())) return false; at += want.length(); return true; }
        private boolean take(char want) { if (at >= text.length() || text.charAt(at) != want) return false; at++; return true; }
        private void ws() { while (at < text.length()) { char c = text.charAt(at); if (c != ' ' && c != '\t' && c != '\r' && c != '\n') return; at++; } }
    }
    private static String validBody(byte[] bytes) throws Exception {
        String text = new String(bytes, "UTF-8");
        return Arrays.equals(bytes, text.getBytes("UTF-8")) && validText(text) ? text : null;
    }

    private static void verify(byte[] expected, byte[] actual) throws Exception {
        if (!Arrays.equals(expected, actual) || validBody(actual) == null) {
            throw new IOException("Backup verification failed");
        }
    }

    private static byte[] readBytes(InputStream in) throws IOException {
        if (in == null) throw new IOException("Cannot open backup input");
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }
}
