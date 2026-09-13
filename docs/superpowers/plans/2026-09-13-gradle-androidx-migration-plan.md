# Gradle/AndroidX 迁移计划

目标：将 Android 构建从手工 aapt2/javac/d8/apksigner 迁移到 Gradle + AGP，并逐步引入 Kotlin/AndroidX，同时保留现有 WebView 离线题库、原生闸门、备份、提醒和应用内更新能力。

## 阶段

1. 建立 Gradle 多文件工程，固定 AGP、Kotlin、compileSdk、minSdk、targetSdk，并让 Gradle APK 与旧 APK 使用同一份 `android/src`、`android/res`、离线 HTML。
2. 迁移可独立验证的原生工具类到 Kotlin；Activity 和系统服务先保持 Java 兼容编译，避免在功能迁移期间引入行为变化。
3. 将 MainActivity 切换到 AndroidX Activity，并用 AndroidX WebKit 做 WebView 兼容配置；在线更新仍走 HTTPS、SHA-256、版本校验和 PackageInstaller。
4. 配置 JVM 单元测试和 AndroidX Test 的基础依赖，补充构建、资源同步、Manifest 权限和更新逻辑校验。
5. Gradle 构建通过后生成 APK，与旧手工构建产物对比包名、版本、权限、assets 和签名信息；保留 `build_apk.py` 作为回退路径。

## 构建约束

- Gradle 8.7、AGP 8.5.2、Kotlin 1.9.20，JDK 17，compile/target SDK 34，min SDK 26。
- 不把网页作为独立产品；HTML/CSS/JS 仍是 APK 的离线内容资源。
- 使用固定签名配置或现有 debug keystore，不能在每次构建时生成新证书。
- 没有真机/模拟器时，明确报告设备级验证缺失，不把编译通过当成安装回归通过。
\n
