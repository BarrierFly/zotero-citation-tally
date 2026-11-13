# TODO

- more vertical padding between sections in prefs pane
- add download counts from arxiv?
- coordinate tsconfig files
- hidden prefs for text colors
- show a visible indicator when a source is in not-found backoff
- add tests for the API status classification (404/429/5xx/network)
- `item.hasChanged()` is item-wide, so `extraForWrite` skips the database
  refresh whenever any field is dirty; using `_hasFieldChanged('extra')` would
  be more precise
- `import/order` is disabled in `eslint.config.mjs`: `eslint-plugin-import`
  2.x does not support ESLint 10 and the rule throws. Re-enable it after moving
  to `eslint-plugin-import-x` or an upstream fix.
- the Zotero 7 menu icon is omitted (Zotero 7 has no `16/universal` icon set);
  a per-version icon map could give it one.
