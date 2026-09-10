# android/vendor —— 语音输入时代留下的东西（**现在不打包**）

这里的文件是 **2.30** 打进去过的开源离线识别（Vosk）。2.31 用户说
「直接把这个录音的功能删除。我直接打字算了」，于是整块语音输入被删掉，
这些文件也就不再进 APK 了（安装包从 48MB 回到 0.5MB）。

**东西留着是有意的**：万一哪天想把"听你说话"加回来，不用重新下载、不用再翻文档。
现在它们只是磁盘上的开发素材，一个字节都不会进 APK——`build_apk.py` 末尾会断言
包里没有 `lib/`、没有 `vosk`/`jna` 字样的条目，`audit_project.js` 也会对着
磁盘上那个包再查一遍。

| 文件 | 作用 |
|---|---|
| `libs/vosk.jar` | Vosk 的 Java API（`org.vosk.Model` / `Recognizer` / `android.SpeechService`） |
| `libs/jna.jar` | Vosk 靠 JNA 调 native，所以必须有它（`com.sun.jna.Pointer`） |
| `jni/<abi>/libvosk.so` | native 库，两个 ABI（arm64-v8a、armeabi-v7a） |
| `jni/<abi>/libjnidispatch.so` | JNA 的 native 库，**必须和 libvosk 同源**，版本不匹配会在运行时才炸 |
| `model/vosk-model-cn.zip` | 中文小模型（Apache 2.0），42MB 压缩 / 解开 65MB |

## 想加回来的话

1. `android/build_apk.py`：javac 的 `-classpath` 加上两个 jar；d8 的输入加上两个 jar；
   把模型拷进 `APP/assets/`（放在 aapt2 link 之前）；把 `lib/<abi>/*.so` 以
   **ZIP_STORED 或者配上 `extractNativeLibs="true"`** 塞进 unsigned.apk。
   这三步和 2.30 的构建脚本一模一样，翻 git 历史没有（这个项目没有版本控制），
   但 `MainActivity` 里那句注释和 PLAN 里 v0.10.5 那一段记了当时踩的坑。
2. manifest：加回 `<uses-permission android:name="android.permission.RECORD_AUDIO" />`、
   `android.speech.RecognitionService` 与 `android.settings.VOICE_INPUT_SETTINGS`
   两条 `<queries>`、以及 `android:extractNativeLibs="true"`。
3. 原生：`LocalAsr` 那个类（解包 + 加载 + 录音识别）和 `MainActivity` 里的桥方法
   （`asrLocalState` / `asrLocalPrepare` / `listenLocal` / `stopListeningLocal`）都要重写，
   还有那个**麦克风权限必须自己申请**的坑（2.30 修过一次，见 PLAN 里那条 5.5）。
4. 网页：`voice.js` 里的三层路由（`asrCap` / `startListen` / `stopListen`）、
   免提状态机、按住说话、设置页的识别诊断，全部要重写。

**一句话**：这不是"改一行配置就能回来"的东西。真要做，按 2.30 那次的顺序重来一遍，
并且一定要在真机上试 native 库能不能加载——那一步在电脑上验不了。
