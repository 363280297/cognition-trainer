# App 优化与 Android 框架、在线更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成题库分类、自适应、训练报告、AndroidX 框架层、WebView 安全、回归测试和离线优先在线更新，并生成可验证 APK。

**Architecture:** 保留现有 WebView 内容层和轻量 Android 构建链。把报告聚合、更新校验和测试逻辑拆成小模块；Android 原生层负责安全网络、私有文件和桥接。在线更新仅允许 JSON 内容包，APK 更新只提示手动下载。

**Tech Stack:** Java 11、Android SDK 34、WebView、固定本地 AndroidX 依赖、原生 JavaScript、Node.js、Playwright/现有脚本。

**Spec:** `docs/superpowers/specs/2026-09-13-app-optimization-online-update-design.md`

## Global Constraints

- 离线内容必须在无网络时可用。
- 在线更新不得下载或执行远程 JS、HTML。
- 更新文件必须经过 HTTPS、SHA-256、JSON 结构和版本校验。
- 用户进度和旧题库必须可回退。
- 不增加录音权限，不使用静默 APK 安装。
- APK 构建继续使用 `android/build_apk.py`。
- 每个新行为先写失败测试，再写实现。

---

### Task 1: 固化现有测试基线和第六题回归

**Files:** Create `tools/check_frame_ui.js`; Modify `tools/check_reported_bugs.js`, `tools/check_variant_ui.js`.

- [ ] Write a failing test for “第六题：开始检验 → 选择答案 → 返回今天”, including a check that rendered onclick contains a literal boolean and no undefined `extra` reference.
- [ ] Run `node tools/check_frame_ui.js` and confirm the expected failure.
- [ ] Implement the Playwright harness and update stale practice subnav expectations plus modal cleanup in the two existing checks.
- [ ] Run `node tools/check_frame_ui.js`, `node tools/check_reported_bugs.js`, and `node tools/check_variant_ui.js`; all must pass.

### Task 2: 统一题库一级分类并保留兼容字段

**Files:** Create `tools/check_categories.js`, `tools/migrate_card_categories.js`; Modify `data/cards.json`, `public/app.js`, `tools/test_content.js`.

- [ ] Add failing assertions that every card has one of six categories and retains the old domain.
- [ ] Run `node tools/check_categories.js` and confirm it fails before migration.
- [ ] Map old domain/type/skill to `人际判断、沟通表达、亲密关系、边界冲突、自我调节、五维认知`, write `category` and `tags`, and make filters use category while preserving old domain compatibility.
- [ ] Run category and content checks.

### Task 3: 修正本地日期并改进五维选题

**Files:** Create `tools/test_frame_selection.js`; Modify `public/app.js`.

- [ ] Add failing tests for local date around UTC midnight and weak-dimension selection.
- [ ] Run the test and confirm failure against `toISOString()` and date-only rotation.
- [ ] Add `localDateKey(date)` and stable weighted selection using dimension accuracy and sample size.
- [ ] Run the focused selection and content checks.

### Task 4: 添加训练报告

**Files:** Create `public/report.js`, `tools/check_report.js`; Modify `public/app.js`, `public/style.css`.

- [ ] Add failing tests for empty, partial, and complete report data, including 7-day completion, error types, six categories, and five dimensions.
- [ ] Run the report test and confirm failure.
- [ ] Implement pure `buildTrainingReport(state, now)` plus the growth-page entry and readable empty state.
- [ ] Run report and navigation checks.

### Task 5: AndroidX 框架层与 WebView 安全

**Files:** Create fixed local AndroidX jars and `tools/check_android_framework.js`; Modify `android/build_apk.py`, `android/src/com/local/cognitiontrainer/MainActivity.java`, `android/AndroidManifest.xml`.

- [ ] Add failing checks for AndroidX dependency collection, file URL cross-origin restrictions, HTTPS/host validation, and exported component/PendingIntent rules.
- [ ] Run the check and confirm failure.
- [ ] Add fixed local AndroidX Core/Activity/WebKit dependencies, disable file URL cross-origin access, and restrict native HTTP to HTTPS allowlisted hosts.
- [ ] Run the framework check and compile the APK.

### Task 6: 在线内容更新

**Files:** Create `data/update-manifest.json`, `public/update.js`, `tools/check_content_update.js`; Modify `public/app.js`, `android/src/com/local/cognitiontrainer/MainActivity.java`, `android/src/com/local/cognitiontrainer/Prefs.java`.

- [ ] Add failing tests for version floor, HTTPS failure, hash error, schema error, successful update, offline fallback, and progress preservation.
- [ ] Run the update test and confirm failure.
- [ ] Implement manifest parsing, HTTPS/host validation, SHA-256, schema checks, temporary download, atomic replacement, and rollback using App-private storage.
- [ ] Add settings UI for “检查内容更新”; expose optional APK version check as a manual download notice only.
- [ ] Run update tests and offline verification.

### Task 7: 全量验证、构建和交付

**Files:** Modify `README.md`, `docs/testing.md`, `android/认知训练.apk`.

- [ ] Run content, UI, bridge, security, update, and offline checks; report that live device validation is unavailable if `adb devices` is empty.
- [ ] Run `py -3 build_offline.py`, `py -3 android/build_apk.py`, then copy `E:/android-build/认知训练.apk` to `android/认知训练.apk`.
- [ ] Verify APK asset identity, update code presence, and v2/v3 signature.
- [ ] Commit with `git add .` and `git commit -m "完善 Android App 训练系统与在线内容更新"`.
