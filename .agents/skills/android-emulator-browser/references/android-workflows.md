# Android Workflows

Use these commands as starting points, but prefer the target repo's scripts and local instructions.

## Device Selection

```bash
adb devices
emulator -list-avds
```

If more than one device is listed, use an explicit serial:

```bash
adb -s emulator-5554 shell getprop ro.product.model
```

## Emulator Boot

```bash
emulator -avd <avd-name>
adb -s <serial> wait-for-device
adb -s <serial> shell getprop sys.boot_completed
```

Wait until `sys.boot_completed` returns `1` before launching the app or mirror.

## Common Build And Launch Commands

React Native:

```bash
npm run android
npx react-native run-android --deviceId <serial>
```

Expo:

```bash
npx expo run:android --device <serial>
```

Gradle:

```bash
./gradlew installDebug
adb -s <serial> shell monkey -p <package.name> 1
```

If the package name is unknown, inspect `android/app/build.gradle`, `AndroidManifest.xml`, or installed packages:

```bash
adb -s <serial> shell pm list packages | rg '<project-or-company-name>'
```

## Logs And Screenshots

```bash
adb -s <serial> logcat
adb -s <serial> logcat -c
adb -s <serial> exec-out screencap -p > /tmp/android-screen.png
```

Use `logcat` for runtime errors and the browser mirror for visual proof. Do not rely on the mirror alone to diagnose build or native crashes.

## Multi-Display Screenshots

Foldables and some physical devices may print display warnings before PNG bytes. The browser server sanitizes that output. For stable capture, inspect display ids:

```bash
adb -s <serial> shell dumpsys SurfaceFlinger --display-id
```

Then pass the chosen id:

```bash
node <skill-root>/scripts/serve-android-emulator.mjs \
  --serial <serial> \
  --display-id <display-id>
```
