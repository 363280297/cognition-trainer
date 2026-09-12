"""Run the real BackupStore on JVM I/O doubles, never a device or real Downloads.

py -3 tools/check_backup_atomic.py
Requires a JDK (JAVA_HOME/PATH or the project's E:/android-build/jdk).
All generated classes and legacy files live in a TemporaryDirectory. No APK build.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tools" / "backup_atomic_fixtures"

# Android boundary doubles only; the production Java file is compiled unchanged.
STUBS = {
    "android/net/Uri.java": '''package android.net;
public final class Uri {
    private final String value;
    private Uri(String value) { this.value = value; }
    public static Uri parse(String value) { return new Uri(value); }
    public static Uri withAppendedPath(Uri base, String id) { return parse(base + "/" + id); }
    public String toString() { return value; }
}''',
    "android/content/ContentValues.java": '''package android.content;
public class ContentValues extends java.util.HashMap<String, Object> { }''',
    "android/content/Context.java": '''package android.content;
public abstract class Context {
    public abstract ContentResolver getContentResolver();
    public int checkSelfPermission(String permission) { return 0; }
}''',
    "android/content/pm/PackageManager.java": '''package android.content.pm;
public class PackageManager { public static final int PERMISSION_GRANTED = 0; }''',
    "android/content/ContentResolver.java": '''package android.content;
import android.net.Uri;
import android.database.Cursor;
import java.io.*;
public abstract class ContentResolver {
    public abstract Uri insert(Uri uri, ContentValues values);
    public abstract int update(Uri uri, ContentValues values, String where, String[] args);
    public abstract int delete(Uri uri, String where, String[] args);
    public abstract Cursor query(Uri uri, String[] columns, String where, String[] args, String order);
    public abstract OutputStream openOutputStream(Uri uri, String mode) throws IOException;
    public abstract InputStream openInputStream(Uri uri) throws IOException;
}''',
    "android/database/Cursor.java": '''package android.database;
public interface Cursor extends AutoCloseable {
    boolean moveToNext();
    boolean moveToFirst();
    String getString(int column);
    long getLong(int column);
    int getInt(int column);
    void close();
}''',
    "android/os/Build.java": '''package android.os;
public class Build { public static class VERSION { public static int SDK_INT = 29; } }''',
    "android/os/Environment.java": '''package android.os;
import java.io.File;
public class Environment {
    public static final String DIRECTORY_DOWNLOADS = "Download";
    public static File getExternalStoragePublicDirectory(String name) {
        String root = System.getProperty("backup.test.root");
        if (root == null) throw new AssertionError("temporary root required");
        return new File(root, name);
    }
}''',
    "android/provider/MediaStore.java": '''package android.provider;
import android.net.Uri;
public class MediaStore {
    public static class Downloads {
        public static final Uri EXTERNAL_CONTENT_URI = Uri.parse("content://media/external/downloads");
        public static final String DISPLAY_NAME = "_display_name", MIME_TYPE = "mime_type",
            RELATIVE_PATH = "relative_path", _ID = "_id", IS_PENDING = "is_pending",
            DATE_ADDED = "date_added", DATE_MODIFIED = "date_modified";
    }
}''',
    # JSON test double parses the fixture subset, including nested JSON and trailing data.
    # It is not intended to test Android's JSON parser implementation.
    "org/json/JSONObject.java": '''package org.json;
public class JSONObject extends java.util.LinkedHashMap<String, Object> {
    public JSONObject() { }
    public JSONObject(String text) {
        Object value = new JSONTokener(text).nextValue();
        if (!(value instanceof JSONObject)) throw new IllegalArgumentException("object required");
        putAll((JSONObject)value);
    }
}''',
    "org/json/JSONTokener.java": r'''package org.json;
public class JSONTokener {
    private final String text;
    private int pos;
    public JSONTokener(String text) { this.text = text; }
    public char nextClean() {
        while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) pos++;
        return pos < text.length() ? text.charAt(pos++) : 0;
    }
    public Object nextValue() {
        char c = nextClean();
        if (c == '{') {
            JSONObject object = new JSONObject();
            c = nextClean();
            if (c == '}') return object;
            pos--;
            while (true) {
                if (nextClean() != '"') throw bad();
                String key = string();
                if (nextClean() != ':') throw bad();
                object.put(key, nextValue());
                c = nextClean();
                if (c == '}') return object;
                if (c != ',') throw bad();
            }
        }
        if (c == '[') {
            java.util.List<Object> list = new java.util.ArrayList<>();
            c = nextClean();
            if (c == ']') return list;
            pos--;
            while (true) {
                list.add(nextValue());
                c = nextClean();
                if (c == ']') return list;
                if (c != ',') throw bad();
            }
        }
        if (c == '"') return string();
        if (c == 0) throw bad();
        int start = --pos;
        while (pos < text.length() && ",]} \r\n\t".indexOf(text.charAt(pos)) < 0) pos++;
        String token = text.substring(start, pos);
        if (token.equals("true") || token.equals("false") || token.equals("null")
                || token.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) return token;
        throw bad();
    }
    private String string() {
        StringBuilder value = new StringBuilder();
        while (pos < text.length()) {
            char c = text.charAt(pos++);
            if (c == '"') return value.toString();
            if (c < 32) throw bad();
            if (c == '\\') {
                if (pos >= text.length()) throw bad();
                c = text.charAt(pos++);
                if (c == 'u') {
                    if (pos + 4 > text.length()) throw bad();
                    c = (char)Integer.parseInt(text.substring(pos, pos + 4), 16);
                    pos += 4;
                } else if ("\"\\/bfnrt".indexOf(c) < 0) throw bad();
            }
            value.append(c);
        }
        throw bad();
    }
    private IllegalArgumentException bad() { return new IllegalArgumentException("invalid JSON"); }
}''',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "android/src/com/local/cognitiontrainer/BackupStore.java")
    args = parser.parse_args()
    started = time.monotonic()
    javac = shutil.which("javac")
    if not javac:
        home = Path(os.environ.get("JAVA_HOME", "E:/android-build/jdk"))
        javac = str(home / "bin" / ("javac.exe" if os.name == "nt" else "javac"))
    java = str(Path(javac).with_name("java.exe" if os.name == "nt" else "java"))

    def run(command):
        remaining = 120 - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError("120s overall check deadline")
        result = subprocess.run([str(x) for x in command], capture_output=True,
                                encoding="utf-8", errors="replace", timeout=min(40, remaining))
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="")
        return result.returncode

    with tempfile.TemporaryDirectory(prefix="backup-atomic-") as tmp:
        work = Path(tmp)
        files = []
        for rel, body in STUBS.items():
            path = work / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
            files.append(path)
        classes = work / "classes"
        classes.mkdir()
        code = run([javac, "-encoding", "UTF-8", "--release", "11", "-d", classes,
                    args.source, *files, *sorted(FIXTURES.rglob("*.java"))])
        if not code:
            code = run([java, "-Dfile.encoding=UTF-8", f"-Dbackup.test.root={work / 'storage'}",
                        "-cp", classes, "com.local.cognitiontrainer.BackupAtomicCheck"])
        # Signature/API check against real SDK stubs, separate from executable doubles.
        sdk = Path(os.environ.get("ANDROID_HOME", "E:/android-build/sdk"))
        jar = sdk / "platforms/android-34/android.jar"
        if jar.exists():
            api_code = run([javac, "-encoding", "UTF-8", "--release", "11", "-cp", jar,
                            "-d", work / "sdk-classes", args.source])
            print("SDK signature compile: " + ("PASS" if api_code == 0 else "FAIL"))
            code = code or api_code
        else:
            print("SDK signature compile: SKIP (android-34/android.jar unavailable)")
    print(f"Backup atomic checks: {'FAIL' if code else 'PASS'} ({time.monotonic() - started:.2f}s)")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
