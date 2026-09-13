# React Native And Expo Preview

Use this adapter for Expo and React Native apps that can open a preview state through a deep link, dev-only route, or Storybook-like fixture screen.

## Registry

```json
{
  "framework": "react-native-expo",
  "package": "team.nottoday.mobile.sandbox",
  "scheme": "nottoday-sandbox",
  "targets": [
    {
      "id": "home-empty",
      "name": "Home Empty",
      "url": "nottoday-sandbox://preview/home-empty"
    }
  ]
}
```

## Launch Behavior

The CLI runs:

```bash
adb -s <serial> shell am start -W -a android.intent.action.VIEW -d "<url>"
```

## Guidance

- Do not assume Expo Go works when native modules are present.
- Start Metro/dev client through the project's own commands when required.
- Do not add preview routes unless the user asks for app code changes.
- If no registry exists, launch the normal app and explain that preview targets need project support.
