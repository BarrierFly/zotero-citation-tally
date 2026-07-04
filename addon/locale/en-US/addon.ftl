startup-begin = Citation Tally is loading
startup-finish = Citation Tally is ready
startup-progress = [{ $percent }%] { $message }
menuitem-label = Citation Tally: Helper Examples
menupopup-label = Citation Tally: Menu
menuitem-submenulabel = Citation Tally
menuitem-filemenulabel = Citation Tally: File Menu
menuitem-update-citation-tallies =
    .label = Update Citation Tallies
menuitem-update-all-sources =
    .label = All Sources
menuitem-update-crossref =
    .label = Update from Crossref
menuitem-update-inspire =
    .label = Update from INSPIRE
menuitem-update-semanticscholar =
    .label = Update from SemanticScholar
menuitem-update-openalex =
    .label = Update from OpenAlex
menuitem-update-avgcite =
    .label = Update Avg Citations/Year
menuitem-retally-outdated-citations =
    .label = Retally outdated item citations
prefs-title = Citation Tally
prefs-table-title = Title
prefs-table-detail = Detail

# Progress window messages
progress-getting-citation-tallies = Getting citation tallies
progress-getting-avgcite = Computing average citations per year
progress-no-valid-items = No valid items selected for citation tally update.
progress-items-updated = Citation tallies updated for { $count } items.
progress-avgcite-updated = Average citations per year updated for { $count } items.
progress-item-counter = Item { $current } of { $total }

# Auto-update messages
auto-update-title = { $addonName } - Autoupdating (Click to Hide)
auto-update-updating-outdated = Updating { $count } outdated citations...
auto-update-updating-item = Updating item { $current } of { $total }
auto-update-connection-retry = Connection issue, retrying... ({ $current }/{ $max })
auto-update-stopped = Auto update stopped: { $error }
auto-update-completed = Auto update completed: { $updated }/{ $total } items updated

# Database display names
database-crossref = Crossref
database-inspire = INSPIRE
database-semanticscholar = SemanticScholar
database-openalex = OpenAlex

# Column and tooltip
column-citations = Citations
column-fwci = FWCI
column-avgcite = AvgCite/Yr
tooltip-citation-tallies = { $displayName }: { $count }