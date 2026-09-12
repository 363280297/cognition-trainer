package com.local.cognitiontrainer;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore.Downloads;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** JVM-only Android boundary doubles. All backup decisions run in BackupStore. */
public final class BackupAtomicCheck {
    static final String NAME = "认知训练-进度备份.json";
    static final String DIR = "Download/认知训练/";
    static final String OLD = "{\"answers\":[1],\"note\":\"旧记录\"}";
    static final String NEW = "{\"answers\":[1,2],\"note\":\"新记录 😀\"}\n";
    static int passed, failed;

    interface Check { void run() throws Exception; }
    static void test(String name, Check check) {
        try { check.run(); passed++; System.out.println("PASS " + name); }
        catch (Throwable e) { failed++; System.out.println("FAIL " + name + ": " + e); }
    }
    static void require(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }
    static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    static final class Row {
        long id, date;
        String name, dir;
        int pending;
        byte[] body;
        Row(long id, String name, String dir, String body, long date, int pending) {
            this.id = id; this.name = name; this.dir = dir;
            this.body = bytes(body); this.date = date; this.pending = pending;
        }
        Object column(String column) {
            if (column.equals(Downloads._ID)) return id;
            if (column.equals(Downloads.DISPLAY_NAME)) return name;
            if (column.equals(Downloads.RELATIVE_PATH)) return dir;
            if (column.equals(Downloads.IS_PENDING)) return pending;
            if (column.equals(Downloads.DATE_ADDED) || column.equals(Downloads.DATE_MODIFIED)) return date;
            throw new AssertionError("unsupported projection " + column);
        }
    }

    static final class Resolver extends ContentResolver {
        final Map<Long, Row> rows = new LinkedHashMap<>();
        String fail = "";
        boolean exposedPartial;
        long next = 100, created = -1;
        Row add(long id, String name, String dir, String body, long date, int pending) {
            Row row = new Row(id, name, dir, body, date, pending);
            rows.put(id, row); return row;
        }
        Uri uri(long id) { return Uri.withAppendedPath(Downloads.EXTERNAL_CONTENT_URI, "" + id); }
        long id(Uri uri) { return Long.parseLong(uri.toString().substring(uri.toString().lastIndexOf('/') + 1)); }
        public Uri insert(Uri uri, ContentValues values) {
            if (fail.equals("insert-throw")) throw new IllegalStateException("insert");
            if (fail.equals("insert-null")) return null;
            String name = (String)values.get(Downloads.DISPLAY_NAME);
            String dir = (String)values.get(Downloads.RELATIVE_PATH);
            if (!dir.endsWith("/")) dir += "/";
            String base = name;
            for (int n = 1; occupied(name, dir); n++) name = base.substring(0, base.length() - 5) + " (" + n + ").json";
            Object pending = values.get(Downloads.IS_PENDING);
            created = next++;
            add(created, name, dir, "", created, pending == null ? 0 : ((Number)pending).intValue());
            return uri(created);
        }
        boolean occupied(String name, String dir) {
            for (Row row : rows.values()) if (row.name.equals(name) && row.dir.equals(dir)) return true;
            return false;
        }
        public OutputStream openOutputStream(Uri uri, String mode) throws IOException {
            if (fail.equals("open-throw")) throw new IOException("open");
            if (fail.equals("open-null")) return null;
            Row row = rows.get(id(uri));
            if (row.pending != 1) exposedPartial = true;
            return new ByteArrayOutputStream() {
                public void write(byte[] b, int off, int len) {
                    if (fail.equals("write")) {
                        row.body = Arrays.copyOfRange(b, off, off + Math.min(4, len));
                        throw new IllegalStateException("partial write");
                    }
                    super.write(b, off, len);
                }
                public void close() throws IOException {
                    if (!fail.equals("write")) row.body = toByteArray();
                    if (fail.equals("close")) throw new IOException("close");
                    if (fail.equals("truncate")) row.body = bytes("{\"answers\":");
                    if (fail.equals("substitute")) row.body = bytes(OLD);
                }
            };
        }
        public InputStream openInputStream(Uri uri) throws IOException {
            long id = id(uri);
            if (id == created && fail.equals("read-throw")) throw new IOException("readback");
            if (id == created && fail.equals("read-null")) return null;
            if (id == 9 && fail.equals("unreadable")) throw new IOException("denied");
            Row row = rows.get(id);
            if (row == null) throw new FileNotFoundException();
            return new ByteArrayInputStream(row.body) {
                public void close() throws IOException {
                    if (id == created && fail.equals("read-close")) throw new IOException("read close");
                }
            };
        }
        public int update(Uri uri, ContentValues values, String where, String[] args) {
            Row row = rows.get(id(uri));
            if (values.containsKey(Downloads.IS_PENDING)) {
                if (fail.equals("publish-throw")) throw new IllegalStateException("publish");
                if (fail.equals("publish-zero")) return 0;
                row.pending = ((Number)values.get(Downloads.IS_PENDING)).intValue();
                if (fail.equals("publish-after-change")) throw new IllegalStateException("publish ambiguous");
            }
            if (values.containsKey(Downloads.DISPLAY_NAME)) {
                if (fail.equals("rename")) throw new IllegalStateException("rename");
                if (fail.equals("rename-zero")) return 0;
                row.name = (String)values.get(Downloads.DISPLAY_NAME);
            }
            return 1;
        }
        public int delete(Uri uri, String where, String[] args) {
            long key = uri.toString().equals(Downloads.EXTERNAL_CONTENT_URI.toString()) ? Long.parseLong(args[0]) : id(uri);
            if (fail.equals("delete-old") && key != created) throw new IllegalStateException("cleanup denied");
            if (fail.equals("delete-old-zero") && key != created) return 0;
            return rows.remove(key) == null ? 0 : 1;
        }
        public Cursor query(Uri uri, String[] columns, String where, String[] args, String order) {
            if (fail.equals("query-throw")) throw new IllegalStateException("query");
            if (fail.equals("query-null")) return null;
            List<Row> matches = new ArrayList<>();
            for (Row row : rows.values()) {
                // Honor exact bound directory/name/pending predicates used by the production query.
                if (where != null && where.contains(Downloads.RELATIVE_PATH) && !Arrays.asList(args).contains(row.dir)) continue;
                if (where != null && where.contains(Downloads.DISPLAY_NAME) && !Arrays.asList(args).contains(row.name)) continue;
                if (where != null && where.contains(Downloads.IS_PENDING + "=0") && row.pending != 0) continue;
                matches.add(row);
            }
            if (order != null) {
                Comparator<Row> sorting = (a, b) -> 0;
                if (order.contains(Downloads.DATE_ADDED + " DESC")) sorting = Comparator.comparingLong((Row row) -> row.date).reversed();
                if (order.contains(Downloads._ID + " DESC")) sorting = sorting.thenComparing(Comparator.comparingLong((Row row) -> row.id).reversed());
                matches.sort(sorting);
            }
            return new Cursor() {
                int position = -1;
                public boolean moveToNext() { return ++position < matches.size(); }
                public boolean moveToFirst() { position = 0; return !matches.isEmpty(); }
                public String getString(int col) { return "" + matches.get(position).column(columns[col]); }
                public long getLong(int col) { return Long.parseLong(getString(col)); }
                public int getInt(int col) { return Integer.parseInt(getString(col)); }
                public void close() { }
            };
        }
    }
    static Context context(Resolver resolver) {
        return new Context() { public ContentResolver getContentResolver() { return resolver; } };
    }
    static Resolver seeded() {
        Resolver r = new Resolver();
        r.add(1, NAME, DIR, OLD, 1, 0);
        return r;
    }
    public static void main(String[] args) throws Exception {
        Build.VERSION.SDK_INT = 29;
        for (String failure : new String[]{"insert-null", "insert-throw", "open-null", "open-throw",
                "write", "close", "truncate", "substitute", "read-null", "read-throw", "read-close",
                "publish-zero", "publish-throw", "publish-after-change", "query-null", "query-throw"}) {
            test("API29 preserves old / " + failure, () -> {
                Resolver r = seeded(); r.fail = failure;
                String result = null;
                Throwable escaped = null;
                try { result = BackupStore.write(context(r), NEW); } catch (Throwable e) { escaped = e; }
                require(r.rows.containsKey(1L) && Arrays.equals(r.rows.get(1L).body, bytes(OLD)), "old bytes lost");
                require(escaped == null, "exception escaped: " + escaped);
                require(result == null, "reported success after failure");
                require(r.rows.size() == 1, "partial record leaked");
                r.fail = "";
                require(OLD.equals(BackupStore.read(context(r))), "old backup no longer readable");
            });
        }
        test("API29 exact repeated replacement without accumulation", () -> {
            Resolver r = seeded();
            for (int i = 0; i < 4; i++) {
                require(BackupStore.write(context(r), NEW) != null, "replacement failed");
                require(NEW.equals(BackupStore.read(context(r))), "new bytes differ");
                require(r.rows.size() == 1, "records accumulated");
                Row row = r.rows.values().iterator().next();
                require(row.pending == 0 && Arrays.equals(row.body, bytes(NEW)), "not published/exact");
                require(!r.exposedPartial, "replacement exposed before verification");
            }
        });
        test("API29 directory isolation for read and cleanup", () -> {
            Resolver r = new Resolver();
            r.add(8, NAME, "Download/elsewhere/", "{\"foreign\":true}", 800, 0);
            r.add(1, NAME, DIR, OLD, 1, 0);
            r.add(7, "notes.json", DIR, "{\"unrelated\":true}", 900, 0);
            require(OLD.equals(BackupStore.read(context(r))), "read another directory/file");
            require(BackupStore.write(context(r), NEW) != null, "write failed");
            require(r.rows.containsKey(8L) && r.rows.containsKey(7L), "unrelated file deleted");
            require(r.rows.size() == 3, "backup duplicates left");
        });
        test("API29 newest valid, duplicate suffix, pending and corrupt fallback", () -> {
            Resolver r = seeded();
            r.add(5, NAME, DIR, OLD, 5, 0);
            r.add(6, "认知训练-进度备份 (2).json", DIR, NEW, 5, 0);
            r.add(7, NAME, DIR, "{broken", 7, 0);
            r.add(8, NAME, DIR, "{\"pending\":true}", 8, 1);
            r.add(9, NAME, DIR, "{\"unreadable\":true}", 9, 0);
            r.fail = "unreadable";
            require(NEW.equals(BackupStore.read(context(r))), "did not select newest valid id tie-break");
        });
        test("API29 committed new survives old-cleanup failure and next write prunes", () -> {
            Resolver r = seeded(); r.fail = "delete-old";
            require(BackupStore.write(context(r), NEW) != null, "published backup reported failed");
            require(NEW.equals(BackupStore.read(context(r))), "deleted or cannot read committed replacement");
            r.fail = "";
            require(BackupStore.write(context(r), NEW) != null && r.rows.size() == 1, "retry did not prune");
        });
        for (String failure : new String[]{"rename", "delete-old-zero"}) {
            test("API29 new remains recoverable after " + failure, () -> {
                Resolver r = seeded(); r.fail = failure;
                require(BackupStore.write(context(r), NEW) != null, "committed replacement reported failed");
                require(NEW.equals(BackupStore.read(context(r))), "committed replacement not selected");
                r.fail = "";
                require(BackupStore.write(context(r), NEW) != null && r.rows.size() == 1, "retry did not prune");
            });
        }
        for (String failure : new String[]{"delete-old", "delete-old-zero", "rename", "rename-zero"}) {
            test("API29 write location avoids stale filename after " + failure, () -> {
                Resolver r = seeded(); r.fail = failure;
                String where = BackupStore.write(context(r), NEW);
                require("下载/认知训练/".equals(where), "location points to stale or missing canonical filename: " + where);
                require(NEW.equals(BackupStore.read(context(r))), "published backup no longer readable");
            });
        }
        test("API29 confirmed canonical rename returns exact file location", () -> {
            Resolver r = seeded();
            String where = BackupStore.write(context(r), NEW);
            require("下载/认知训练/认知训练-进度备份.json".equals(where), "confirmed filename missing");
            Row row = r.rows.values().iterator().next();
            require(NAME.equals(row.name) && Arrays.equals(bytes(NEW), row.body), "location does not identify new bytes");
        });
        test("API29 legacy directory without trailing slash remains readable", () -> {
            Resolver r = new Resolver();
            r.add(1, NAME, "Download/认知训练", OLD, 1, 0);
            require(OLD.equals(BackupStore.read(context(r))), "legacy path not found");
        });
        test("API29 malformed UTF-8 and JSON are skipped, status reflects valid fallback", () -> {
            Resolver r = seeded();
            r.add(3, NAME, DIR, "{} trailing", 3, 0);
            r.add(4, NAME, DIR, "[]", 4, 0);
            Row broken = r.add(5, NAME, DIR, "{\"a\":\"x\"}", 5, 0);
            broken.body[6] = (byte)0xff;
            require(OLD.equals(BackupStore.read(context(r))), "accepted invalid UTF-8 or JSON");
            require(Boolean.TRUE.equals(BackupStore.status(context(r)).get("ok")), "valid fallback status false");
            r.rows.remove(1L);
            require(BackupStore.read(context(r)) == null, "returned corrupt data");
            require(Boolean.FALSE.equals(BackupStore.status(context(r)).get("ok")), "corrupt backup reported valid");
        });
        test("API29 first backup succeeds without prior records", () -> {
            Resolver r = new Resolver();
            require(BackupStore.read(context(r)) == null, "unexpected initial data");
            require(BackupStore.write(context(r), NEW) != null && r.rows.size() == 1, "first write failed");
            require(NEW.equals(BackupStore.read(context(r))), "first read differs");
        });
        for (int api : new int[]{26, 28, 29}) {
            for (String invalid : new String[]{null, "", "not json", "{\"a\":", "null", "[]", "{} trailing", "{\"a\":\"\ud800\"}"}) {
                test("API" + api + " rejects malformed input: " + invalid, () -> {
                    Build.VERSION.SDK_INT = api;
                    Resolver r = seeded();
                    Path path = Paths.get(System.getProperty("backup.test.root"), "Download", "认知训练", NAME);
                    Files.createDirectories(path.getParent()); Files.write(path, bytes(OLD));
                    require(BackupStore.write(context(r), invalid) == null, "accepted invalid JSON object");
                    require(Arrays.equals(Files.readAllBytes(path), bytes(OLD)), "legacy old bytes lost");
                    require(Arrays.equals(r.rows.get(1L).body, bytes(OLD)), "MediaStore old bytes lost");
                });
            }
        }
        LegacyAtomicCheck.run();
        System.out.println("Results: " + passed + " passed, " + failed + " failed");
        if (failed != 0) System.exit(1);
    }
}
