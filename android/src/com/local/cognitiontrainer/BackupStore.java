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
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 把训练记录作为**纯文本**留一份在公共「下载」目录里。
 *
 * ---------------------------------------------------------------- 为什么要有它
 *
 * 闸门那条设计里，「卸载」是唯一的出口。但那个出口的代价原本是「全部归零」——
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
 * 所以这里不去假装一定能读回来：write 之后会立刻**回读校验**一次，
 * 读不回来就在界面上如实显示「写进去了，但读不回来」，
 * 而不是显示一个假的「已备份」。这是这个 App 一贯的做法——
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
    static String write(Context c, String text) {
        if (text == null || text.isEmpty()) return null;
        if (Build.VERSION.SDK_INT >= 29) {
            return new Api29().write(c, text);
        }
        return legacyWrite(c, text);
    }

    /** 读回备份内容；没有或读不到返回 null。 */
    static String read(Context c) {
        if (Build.VERSION.SDK_INT >= 29) {
            return new Api29().read(c);
        }
        return legacyRead(c);
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
        String write(Context c, String text) {
            ContentResolver r = c.getContentResolver();
            deleteExisting(r);
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, FILE_NAME);
            v.put(MediaStore.Downloads.MIME_TYPE, MIME);
            v.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/" + DIR_NAME);
            Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) return null;
            try (OutputStream os = r.openOutputStream(uri, "wt")) {
                os.write(text.getBytes("UTF-8"));
            } catch (Exception e) {
                return null;
            }
            // 立刻回读校验。读得回来才敢说「备份好了」。
            String back = read(c);
            if (back == null) return null;
            return "下载/" + DIR_NAME + "/" + FILE_NAME;
        }

        /** 先删同名的。不删的话 MediaStore 会自动改名成「…备份 (1).json」，
         *  每次备份多一个文件，用不了多久就能堆出几十个副本。 */
        private void deleteExisting(ContentResolver r) {
            try (Cursor cur = r.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID},
                    MediaStore.Downloads.DISPLAY_NAME + "=?",
                    new String[]{FILE_NAME}, null)) {
                while (cur != null && cur.moveToNext()) {
                    r.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            MediaStore.Downloads._ID + "=?", new String[]{cur.getString(0)});
                }
            } catch (Exception ignored) { }
        }

        String read(Context c) {
            ContentResolver r = c.getContentResolver();
            try (Cursor cur = r.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID},
                    MediaStore.Downloads.DISPLAY_NAME + "=?",
                    new String[]{FILE_NAME}, null)) {
                if (cur == null || !cur.moveToFirst()) return null;
                Uri uri = Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        cur.getString(0));
                try (InputStream in = r.openInputStream(uri)) {
                    return slurp(in);
                }
            } catch (Exception e) {
                return null;
            }
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

    private static String legacyWrite(Context c, String text) {
        if (!legacyPermitted(c)) return null;
        File f = legacyFile();
        try {
            File dir = f.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) return null;
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(text.getBytes("UTF-8"));
            }
            return "下载/" + DIR_NAME + "/" + FILE_NAME;
        } catch (Exception e) {
            return null;
        }
    }

    private static String legacyRead(Context c) {
        if (!legacyPermitted(c)) return null;
        File f = legacyFile();
        if (!f.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(f)) {
            return slurp(in);
        } catch (Exception e) {
            return null;
        }
    }

    private static String slurp(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }
}
