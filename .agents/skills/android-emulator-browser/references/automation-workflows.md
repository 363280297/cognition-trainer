# Automation Workflows

The browser server exposes semantic automation through Android `uiautomator` XML.

## Snapshot

```bash
curl -s http://127.0.0.1:<port>/snapshot
```

Each element has `elementRef`, `text`, `contentDescription`, `resourceId`, `className`, `role`, `bounds`, `center`, `enabled`, `focused`, `selected`, and `checked`.

## Selector Tap

```bash
curl -s -X POST http://127.0.0.1:<port>/tap-selector \
  -H 'content-type: application/json' \
  --data '{"selector":{"text":"Save"}}'
```

Prefer stable selectors in this order:

1. `resourceId`
2. `contentDescription`
3. exact `text`
4. `textContains`
5. `elementRef` from the latest snapshot
6. coordinate `/tap` only as fallback

## Wait

```bash
curl -s -X POST http://127.0.0.1:<port>/wait-selector \
  -H 'content-type: application/json' \
  --data '{"selector":{"textContains":"Done"},"predicate":"exists","timeoutMs":10000}'
```

Use `predicate:"gone"` for loading indicators or transient dialogs.

## Text

```bash
curl -s -X POST http://127.0.0.1:<port>/type-selector \
  -H 'content-type: application/json' \
  --data '{"selector":{"resourceId":"team.example:id/name"},"text":"Ada"}'
```

If the selected element is absent, the endpoint returns `404` and includes the snapshot for diagnosis.
