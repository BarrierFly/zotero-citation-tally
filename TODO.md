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
