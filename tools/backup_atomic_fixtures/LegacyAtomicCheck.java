package com.local.cognitiontrainer;

import android.content.Context;
import android.os.Build;
import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import java.util.stream.Stream;

import static com.local.cognitiontrainer.BackupAtomicCheck.*;

/** Uses real temporary files and production transaction code; doubles only failing I/O. */
final class LegacyAtomicCheck {
    static final class Faults extends BackupStore.LegacyIo {
        final String failure;
        File staged;
        Faults(String failure) { this.failure = failure; }
        File stage(File dir) throws IOException {
            if (failure.equals("create")) throw new IOException("create");
            staged = super.stage(dir);
            return staged;
        }
        FileOutputStream output(File file) throws IOException {
            if (failure.equals("open")) throw new IOException("open");
            return new FileOutputStream(file) {
                public void write(byte[] bytes) throws IOException {
                    if (failure.equals("write")) {
                        super.write(bytes, 0, 4);
                        throw new IOException("partial write");
                    }
                    super.write(bytes);
                }
                public void close() throws IOException {
                    super.close();
                    if (failure.equals("close")) throw new IOException("close");
                }
            };
        }
        void sync(FileOutputStream out) throws IOException {
            if (failure.equals("sync")) throw new IOException("sync");
            super.sync(out);
        }
        InputStream input(File file) throws IOException {
            if (failure.equals("read")) throw new IOException("read");
            if (failure.equals("read-null")) return null;
            if (failure.equals("truncate")) Files.write(file.toPath(), bytes("{\"answers\":"));
            if (failure.equals("substitute")) Files.write(file.toPath(), bytes(OLD));
            return new FileInputStream(file) {
                public void close() throws IOException {
                    super.close();
                    if (failure.equals("read-close")) throw new IOException("read close");
                }
            };
        }
        void publish(File staged, File target) throws IOException {
            if (failure.equals("publish")) throw new IOException("rename");
            if (failure.equals("atomic-unsupported")) {
                throw new AtomicMoveNotSupportedException(staged.toString(), target.toString(), "unsupported");
            }
            super.publish(staged, target);
        }
    }
    static Path target() {
        return Paths.get(System.getProperty("backup.test.root"), "Download", "认知训练", NAME);
    }
    static void seed() throws IOException {
        Files.createDirectories(target().getParent());
        Files.write(target(), bytes(OLD));
    }
    static long count() throws IOException {
        try (Stream<Path> files = Files.list(target().getParent())) { return files.count(); }
    }
    static void run() {
        for (int api : new int[]{26, 27, 28}) {
            for (String failure : new String[]{"create", "open", "write", "sync", "close", "read",
                    "read-null", "read-close", "truncate", "substitute", "publish", "atomic-unsupported"}) {
                test("API" + api + " preserves old / " + failure, () -> {
                    Build.VERSION.SDK_INT = api;
                    seed();
                    Faults io = new Faults(failure);
                    Context c = context(new Resolver());
                    String result = new BackupStore.LegacyStore(io).write(c, NEW);
                    require(result == null, "reported success after failure");
                    require(Arrays.equals(Files.readAllBytes(target()), bytes(OLD)), "old bytes lost");
                    require(OLD.equals(BackupStore.read(c)), "old backup not readable");
                    require(count() == 1, "partial text file leaked");
                });
            }
            test("API" + api + " exact repeated atomic replacement", () -> {
                Build.VERSION.SDK_INT = api;
                seed();
                Context c = context(new Resolver());
                for (int i = 0; i < 4; i++) {
                    require(BackupStore.write(c, NEW) != null, "replacement failed");
                    require(Arrays.equals(Files.readAllBytes(target()), bytes(NEW)), "bytes differ");
                    require(NEW.equals(BackupStore.read(c)), "read differs");
                    require(count() == 1, "files accumulated");
                }
                require(Boolean.TRUE.equals(BackupStore.status(c).get("ok")), "valid status is false");
                require(((Number)BackupStore.status(c).get("bytes")).intValue() == bytes(NEW).length,
                        "status counts characters instead of UTF-8 bytes");
            });
            test("API" + api + " denied permission preserves old", () -> {
                Build.VERSION.SDK_INT = api;
                seed();
                Context denied = new Context() {
                    public android.content.ContentResolver getContentResolver() { throw new AssertionError("resolver on legacy"); }
                    public int checkSelfPermission(String permission) { return -1; }
                };
                require(BackupStore.write(denied, NEW) == null && BackupStore.read(denied) == null, "ignored permission");
                require(Arrays.equals(Files.readAllBytes(target()), bytes(OLD)), "permission failure changed old");
                require(Boolean.TRUE.equals(BackupStore.status(denied).get("needsPerm")), "missing permission status");
            });
            test("API" + api + " corrupt read has no valid status", () -> {
                Build.VERSION.SDK_INT = api;
                seed();
                Files.write(target(), bytes("{\"answers\":"));
                Context c = context(new Resolver());
                require(BackupStore.read(c) == null, "returned corrupt JSON");
                require(Boolean.FALSE.equals(BackupStore.status(c).get("ok")), "corrupt backup reported valid");
            });
        }
    }
}
