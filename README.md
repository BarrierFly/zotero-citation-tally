[![GitHub release (latest by date)](https://img.shields.io/github/v/release/BarrierFly/zotero-citation-tally?style=for-the-badge)](https://github.com/BarrierFly/zotero-citation-tally/releases/latest) [![GitHub Downloads all releases](https://img.shields.io/github/downloads/BarrierFly/zotero-citation-tally/total?style=for-the-badge&color=forestgreen)](https://github.com/BarrierFly/zotero-citation-tally/releases/latest) [![GitHub Downloads (latest release)](https://img.shields.io/github/downloads/BarrierFly/zotero-citation-tally/latest/total?style=for-the-badge)](https://github.com/BarrierFly/zotero-citation-tally/releases/latest)

# Citation Tally

[![zotero target version](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org) [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

**_Displays citation counts, FWCI, and average citations per year for Zotero library items._**

![Screenshot](docs/assets/readme/screenshot.png)

This is a plugin for [Zotero](https://www.zotero.org), a research source management tool. The _Citation Tally_ plugin fetches and displays citation counts for research papers in your library from multiple academic databases.

## Plugin Functions

- **Citation tracking** - Fetches citation counts when new items are added (optional)
- **Field-Weighted Citation Impact (FWCI)** - Displays FWCI from OpenAlex alongside citation counts
- **Average Citations Per Year** - Computes and displays a locally-calculated average citations per year (年均引用)
- **Startup retally** - Optionally refreshes outdated citations when Zotero starts
- **Visual integration** - Adds sortable "Citations", "FWCI", and "AvgCite/Yr" columns to the item list
- **Multiple databases** - Queries Crossref, Semantic Scholar, INSPIRE, and OpenAlex
- **Per-source updates** - Right-click menu entries update selected items from one source or from all configured sources
- **Adaptive rate limiting** - Adjusts request delays when an API reports rate limiting
- **Persistent storage** - Stores citation data in the item's Extra field, so it syncs with the library
- **Group libraries** - The startup scan covers the user library and all group libraries

Please post bug reports, questions, or feature requests in the [GitHub issues](https://github.com/BarrierFly/zotero-citation-tally/issues?q=is%3Aissue+is%3Aopen+sort%3Aupdated-desc).

## Installation

- Download the plugin (`.xpi` file) from the [latest release](https://github.com/BarrierFly/zotero-citation-tally/releases/latest)
- Open Zotero
- Open `Tools -> Plugins`
- Select `Install Plugin From File...` from the gear icon ⛭
- Choose the downloaded `.xpi` file (for example `citation-tally.xpi`)
- Restart Zotero

> [!NOTE]
> The last release supporting Zotero 7 was [`v0.0.11`](https://github.com/BarrierFly/zotero-citation-tally/releases/tag/v0.0.11).
>
> The last release supporting Zotero 8 was [`v0.0.12`](https://github.com/BarrierFly/zotero-citation-tally/releases/tag/v0.0.12).

## Setup and Configuration

After installation, the plugin adds its columns and menu entries. Citation data is fetched only for items that have a supported identifier (DOI or arXiv ID).

### Initial Setup

- **Columns**: The plugin adds "Citations", "FWCI", and "AvgCite/Yr" columns to the item list.
  - If a column is hidden, right-click the column header and enable it.

    ![show Citations column](docs/assets/readme/show-column.png)

- **Preferences**: Open `Zotero -> Settings -> Citation Tally` on macOS, or `Edit -> Settings -> Citation Tally` on Windows/Linux.

### Automatic Behavior

- **New items**: If enabled in preferences, citation counts are fetched when items with DOIs or arXiv IDs are added.
- **Startup retally**: If enabled, the plugin scans the user library and all group libraries for citation entries that are missing or older than the configured cutoff. Only the outdated sources are queried for each item.
- **Order**: Items are processed from newest to oldest based on the date they were added.
- **Not-found backoff**: Only automatic runs record confirmed "not found" responses. Repeated misses are retried after 7, 30, 90, and then 180 days. Network errors, rate limits, and server errors are not recorded as "not found".

### Manual Actions

- **Update selected items**: Right-click → "Update Citation Tallies"
  - Queries every configured database for the selected regular items.
  - Manual updates bypass the not-found backoff and do not change it.

- **Update from a specific source**: Right-click → choose Crossref, INSPIRE, SemanticScholar, or OpenAlex.

- **Compute average citations/year**: Right-click → "更新年均引用" / "Update Avg Citations/Year"
  - Computed locally from existing citation data and the item's publication date.

- **Retally outdated citations**: Tools menu → "Retally outdated item citations"
  - Runs the same outdated-item scan as the startup retally, but can be triggered at any time and works regardless of the automatic-update setting.

### Configuration Options

<details>

<summary>Database Settings</summary>

- **Database order**: Configure which databases are queried and in what order.
  - Default: `crossref, semanticscholar`
  - Available: `crossref`, `semanticscholar`, `inspire`, `openalex`
  - Every configured database is queried for each eligible item; the order determines query and display order.
  - Crossref and OpenAlex need a regular DOI. INSPIRE and Semantic Scholar also accept arXiv IDs. arXiv DOIs (`10.48550/arXiv.*`) are treated as arXiv identifiers rather than Crossref/OpenAlex DOIs.
  - For physics papers, for example: `inspire, crossref, semanticscholar`
  - For FWCI data, include `openalex`

- **Automatic updates**: Off, or retally outdated citations once at startup.
- **Retally cutoff**: Consider an entry outdated after 3, 6, 12, or 24 months.
- **Fetch on add**: Whether new items are looked up automatically.

</details>

### Troubleshooting

<details>

<summary>Common Issues</summary>

- **No citation data found**: The plugin needs a DOI or arXiv ID. Web pages, theses, and older publications without a digital identifier usually have no match in these databases.
- **Rate limiting**: Requests are spaced with base delays (Crossref, INSPIRE, OpenAlex: 1 s; Semantic Scholar: 3 s). After a `429` response the delay is multiplied by 1.5 (up to 10×) and gradually reduced after successful requests. Large batch updates can take a while but run in the background.
- **Network issues**: Ensure Zotero has internet access and that a firewall or proxy is not blocking the APIs. A failed request is retried a few times per item during automatic updates; it is never stored as a permanent "not found".
- **Missing group-library data**: Startup retally scans group libraries, but Zotero must have synced those libraries before the scan begins.

</details>

<details>
<summary>Advanced Features & Behavior</summary>

### Retry System

For automatic updates, the plugin remembers confirmed `not_found` responses per item and database:

- 1st miss: retry after 7 days
- 2nd miss: retry after 30 days
- 3rd miss: retry after 90 days
- 4th and later: retry after 180 days

A successful lookup clears the record for that source. Transient failures (network errors, rate limits, HTTP 5xx, unparsable responses) do not start or extend the backoff. Manual updates always bypass it.

### Adaptive Rate Limiting

- Crossref: 1 second base delay
- INSPIRE: 1 second
- Semantic Scholar: 3 seconds
- OpenAlex: 1 second
- On rate limiting, the delay increases by 1.5× up to 10×; successful requests reduce it by 0.9×.
- The limits are built in; there is no UI for editing them yet.

### Data Storage

Citation data is appended to the item's Extra field in these formats:

```text
Citations: 42 (Crossref) [2025-01-02]
FWCI: 1.25 (OpenAlex) [2025-01-02]
AvgCite: 3.50 (Crossref) [2025-01-02]
```

- Existing user lines in Extra are never removed.
- At most 20 plugin-generated lines are kept per entry type and source; the oldest are dropped first.
- Database names are written as stable English labels so records remain readable when Zotero's UI language changes.
- The records sync with the library and are readable by older releases.

### Performance Optimizations

- Parsed Extra data is cached per item while the item list repaints.
- Library scans load items in chunks so large libraries do not block the UI.
- Each item's Extra field is re-read under a write lock before updating, preventing concurrent manual, automatic, and fetch-on-add runs from overwriting each other.
- Ignored-item records are kept in memory and written back in one debounced update.
- Data for deleted library items is cleaned up once at startup and then at most once every 30 days.

### Supported Identifiers

- DOIs (including `https://doi.org/...` and percent-encoded forms)
- arXiv IDs, including new-style (`2201.02177`), old-style (`hep-th/9901001`), versioned, and URL forms

Identifiers are read from the DOI, archiveID, reportNumber, Extra, URL, and callNumber fields.

</details>

## Supported Databases

- **[Crossref](https://www.crossref.org/)**: Scholarly publications registered with Crossref
- **[INSPIRE](https://inspirehep.net/)**: High-energy physics literature
- **[Semantic Scholar](https://www.semanticscholar.org/)**: Academic search engine with citation data
- **[OpenAlex](https://openalex.org/)**: Open catalog providing citation counts and FWCI (Field-Weighted Citation Impact)

## Privacy

The plugin sends only the item's DOI or arXiv ID to the selected APIs. It has no telemetry and no account system. Citation counts are stored locally in Zotero and, like the rest of the item data, sync through the user's configured Zotero sync.

## Development

```bash
yarn install
yarn build       # build the XPI and type-check
yarn test        # run the pure-function unit tests
yarn lint:check  # check formatting and lint
```

The build output is written to `.scaffold/build/`.

### Plugin sandbox constraints

Zotero runs plugin code in a sandbox that injects only a whitelist of globals
(`fetch`, `XMLHttpRequest`, `URL`, `TextDecoder`, `crypto`, …). `AbortController`
and `structuredClone` are **not** available there. Referencing them throws a
`ReferenceError` inside the plugin at runtime, while `tsc` and the unit tests
still pass because Node provides them.

`test/sandboxGlobals.test.ts` scans every file under `src/` for these globals and
fails the build if one is used outside a comment. Use `src/modules/http.ts`
(`getJson`) for API calls: it goes through `Zotero.HTTP.request`, which provides
real timeouts and honours the user's proxy configuration.

Two related Zotero API rules the plugin depends on:

- `extra` is **not** a Zotero data type. `item.reload(['extra'], …)` silently
  does nothing, so writes re-read the stored value through `extraForWrite`.
- `Zotero.Items.get()` throws `UnloadedDataException` for an item that is
  registered but not yet loaded, which is the normal state inside an `add`
  notifier event. Use `Zotero.Items.getAsync()` there.

### Loading item data

`Zotero.Items.getAsync()` only loads `primaryData`. Calling `getField('DOI')`,
`getField('extra')` or `getField('dateAdded')` on the returned item throws
`UnloadedDataException` until `itemData` is loaded, so every code path that reads
fields from freshly loaded items calls
`Zotero.Items.loadDataTypes(items, ['itemData'])` first. This affects the library
scan, fetch-on-add and the outdated-source check; without it those paths fail
silently and no citations are ever fetched.

### Public API for automation

`Zotero.CitationTally.api` exposes the pure helpers and the update entry points,
so scripts and other plugins can drive the plugin without copying its logic:

```js
const { api } = Zotero.CitationTally

// Column values for an item whose itemData is loaded
api.core.getCitationCountForColumn(item)

// Identifiers, including arXiv IDs parsed from Extra/URL/archiveID
api.core.getIdentifiers(item)

// One-off lookup against a single database (no writes)
await api.databases.lookup('openalex', item)

// Full update of one item, same code path as the context menu
await api.items.updateItem(item, ['crossref'])

// The Tools-menu retally, run silently
await api.scan.retallyOutdated()
```

### Column sorting

The item tree sorts custom columns by comparing the `dataProvider` strings with
Zotero's locale collation. Numbers are therefore encoded as fixed-width,
hundredths-scaled keys, and missing values use a key that sorts _after_ every
number (Zotero's own convention for rows without a value). Both behaviours are
covered by `test/sortableNumber.test.ts` against `Intl.Collator`.

## Related Projects

- **[ZoteroCitationCountsManager](https://github.com/FrLars21/ZoteroCitationCountsManager)** by FrLars21
- **[zotero-citationcounts](https://github.com/eschnett/zotero-citationcounts)** by eschnett

## Notes

[GitHub](https://github.com/BarrierFly/zotero-citation-tally): source code repository

This extension uses the [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

## License

Distributed under the GNU Affero General Public License v3.0.

## Author

[BarrierFly](https://github.com/BarrierFly)
