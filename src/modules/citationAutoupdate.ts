import { getString } from '../utils/locale'
import { getPref } from '../utils/prefs'

import { DATABASE_IDS, parseExtra } from './citationData'
import { Helpers, safeChangeLine, type StepReporter, updateItem } from './citationTally'
import { IgnoredItemsStore } from './ignoredItems'

import type { DatabaseId } from './citationData'

const VALID_CUTOFF_MONTHS = new Set([3, 6, 12, 24])
const DEFAULT_CUTOFF_MONTHS = 6

// How many ids to load from the item cache at once while scanning. Large
// libraries otherwise spend a long time in a single blocking call.
const SCAN_CHUNK_SIZE = 200

const MAX_RETRIES = 3
const RETRY_DELAY = 5000

// Progress window line indexes (0 = item counter, 1 = current lookup step)
const AUTO_PROGRESS_LINE_STATUS = 0
const AUTO_PROGRESS_LINE_STEP = 1

interface OutdatedItem {
  item: Zotero.Item
  /** Databases that actually need a lookup for this item. */
  databases: DatabaseId[]
}

// Automatic update state
let autoUpdateInProgress = false
let autoUpdateQueue: OutdatedItem[] = []
let autoUpdateIndex = 0
let autoUpdateProgressWindow: any = null
let autoUpdateRetryCount = 0
let autoUpdateUpdatedCount = 0

function getCutoffMonths(): number {
  const parsed = parseInt(getPref('autoUpdateCutoff') || '', 10)
  // An invalid value used to produce an Invalid Date, which made every item
  // look fresh and silently disabled automatic updates.
  return VALID_CUTOFF_MONTHS.has(parsed) ? parsed : DEFAULT_CUTOFF_MONTHS
}

function getConfiguredDatabases(): DatabaseId[] {
  const raw = getPref('databaseOrder') || 'crossref'
  return [
    ...new Set(
      raw
        .split(',')
        .map((db) => db.trim())
        .filter((db): db is DatabaseId => (DATABASE_IDS as readonly string[]).includes(db)),
    ),
  ]
}

function hasUsableDoi(identifiers: { type: string; id: string }[]): boolean {
  return identifiers.some((identifier) => identifier.type === 'doi' && !/^10\.48550\/arxiv\./i.test(identifier.id))
}

/**
 * Whether a source can return data for this item at all. Missing sources are
 * not "outdated" — querying them would only produce permanent 404s.
 */
function isDatabaseApplicable(database: DatabaseId, identifiers: { type: string; id: string }[]): boolean {
  if (identifiers.length === 0) return false
  switch (database) {
    case 'crossref':
    case 'openalex':
      return hasUsableDoi(identifiers)
    case 'inspire':
    case 'semanticscholar':
      return true
    default:
      return false
  }
}

/**
 * Databases whose citation entry is missing or older than the configured
 * cutoff. Only those are queried, so one stale source does not force a full
 * round of requests to every API.
 */
function getOutdatedDatabases(item: Zotero.Item, cutoffMs: number): DatabaseId[] {
  const databases = getConfiguredDatabases()
  if (databases.length === 0) return []

  const identifiers = Helpers.getAllItemIdentifiers(item)
  const parsed = parseExtra(item.getField('extra'))
  const outdated: DatabaseId[] = []

  for (const database of databases) {
    if (!isDatabaseApplicable(database, identifiers)) continue
    if (IgnoredItemsStore.isBlocked(item.id, database)) continue

    const entry = parsed.citations[database]
    // An undated entry cannot be judged fresh, but it still has a value, so
    // retally it rather than treating it as absent.
    if (!entry || !entry.date || entry.dateMs < cutoffMs) {
      outdated.push(database)
    }
  }

  return outdated
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Collect item ids from the user library and every group library. The previous
 * implementation only scanned the user library, silently skipping group
 * libraries.
 */
async function collectLibraryItemIds(): Promise<number[]> {
  const ids: number[] = []

  for (const library of Zotero.Libraries.getAll()) {
    // Feed libraries contain no fetchable items.
    if (library.libraryType === 'feed') continue
    try {
      const search = new Zotero.Search({ libraryID: library.libraryID })
      search.addCondition('deleted', 'false', '')
      search.addCondition('itemType', 'isNot', 'attachment')
      search.addCondition('itemType', 'isNot', 'note')
      ids.push(...(await search.search()))
    } catch (e) {
      ztoolkit.log(`Auto update: could not scan library ${library.libraryID}:`, e)
    }
  }

  return ids
}

/**
 * Find items that need citation updates. Items are processed in chunks so a
 * large library does not block the UI in one synchronous pass.
 */
async function getItemsNeedingUpdate(): Promise<OutdatedItem[]> {
  const itemIds = await collectLibraryItemIds()
  ztoolkit.log(`Auto update debug: Found ${itemIds.length} candidate items across all libraries`)

  const cutoffMs = new Date(new Date().setMonth(new Date().getMonth() - getCutoffMonths())).getTime()
  const itemsNeedingUpdate: OutdatedItem[] = []
  const debugReasons: { id: number; title: string; reason: string }[] = []
  let regularItemCount = 0
  let itemsWithIdentifierCount = 0
  let outdatedItemCount = 0

  for (let start = 0; start < itemIds.length; start += SCAN_CHUNK_SIZE) {
    if (!addon.data.alive) break
    const chunk = itemIds.slice(start, start + SCAN_CHUNK_SIZE)
    const items = await Zotero.Items.getAsync(chunk)

    for (const item of items) {
      if (!item.isRegularItem()) continue
      regularItemCount++

      // Skip items without DOI or arXiv ID
      const identifiers = Helpers.getAllItemIdentifiers(item)
      if (identifiers.length === 0) continue
      itemsWithIdentifierCount++

      const databases = getOutdatedDatabases(item, cutoffMs)
      if (databases.length === 0) continue

      itemsNeedingUpdate.push({ item, databases })
      outdatedItemCount++

      if (addon.data.env === 'development') {
        debugReasons.push({
          id: item.id,
          title: (item.getField('title') || 'No title').substring(0, 60),
          reason: databases.join(','),
        })
      }
    }

    // Yield to the event loop between chunks.
    await delay(0)
  }

  ztoolkit.log('Auto update debug: Item filtering summary:')
  ztoolkit.log(`  - Candidate items: ${itemIds.length}`)
  ztoolkit.log(`  - Regular items: ${regularItemCount}`)
  ztoolkit.log(`  - Items with identifier: ${itemsWithIdentifierCount}`)
  ztoolkit.log(`  - Items outdated: ${outdatedItemCount}`)

  if (addon.data.env === 'development') {
    ztoolkit.log('*** DETAILED DEBUG REASONS FOR AUTOUPDATE SELECTION ***')
    ztoolkit.log(JSON.stringify(debugReasons, null, 2))
    ztoolkit.log('*** END DETAILED DEBUG REASONS ***')
  }

  // Sort by date added (newest first)
  itemsNeedingUpdate.sort((a, b) => {
    const dateA = new Date(a.item.getField('dateAdded')).getTime()
    const dateB = new Date(b.item.getField('dateAdded')).getTime()
    return (Number.isFinite(dateB) ? dateB : 0) - (Number.isFinite(dateA) ? dateA : 0)
  })

  return itemsNeedingUpdate
}

function checkIfRunnable(): boolean {
  const window = Zotero.getMainWindow()

  if (!addon.data.alive) {
    ztoolkit.log('Auto update: Plugin is shutting down, stopping')
    return false
  }

  if (!window) {
    ztoolkit.log('Auto update: No Zotero window available, stopping')
    return false
  }

  if (!window?.navigator?.onLine) {
    ztoolkit.log('Auto update: No network connection, stopping')
    return false
  }

  return true
}

function closeProgressWindow(): void {
  if (!autoUpdateProgressWindow) return
  try {
    autoUpdateProgressWindow.close()
  } catch (e) {
    ztoolkit.log('Auto update: failed to close progress window:', e)
  }
  autoUpdateProgressWindow = null
}

function resetAutoUpdateState(): void {
  autoUpdateQueue = []
  autoUpdateIndex = 0
  autoUpdateRetryCount = 0
  autoUpdateUpdatedCount = 0
}

/**
 * Start automatic update process on startup if enabled
 * @param silent Whether to suppress progress UI
 * @param ignoreAutoUpdateMode Bypass the autoUpdate preference check. The startup
 *   trigger only runs when the user opted in via preferences; the Tools-menu
 *   retally action is an explicit request and must not be gated on that setting.
 */
async function startAutomaticUpdate(silent: boolean = false, ignoreAutoUpdateMode: boolean = false) {
  const autoUpdateMode = getPref('autoUpdate') || 'never'

  if (!ignoreAutoUpdateMode && autoUpdateMode !== 'startup') {
    return
  }

  // Claim the flag before any `await`. Otherwise two startup triggers (or a
  // startup trigger and a menu action) could scan the library concurrently and
  // then both process their own queues.
  if (autoUpdateInProgress || !addon.data.alive) {
    return
  }
  autoUpdateInProgress = true

  try {
    // Show the progress window before the library scan starts: finding outdated
    // items is the first thing the user waits for.
    if (!silent) {
      autoUpdateProgressWindow = new ztoolkit.ProgressWindow(
        getString('auto-update-title', { args: { addonName: addon.data.config.addonName } }),
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )

      autoUpdateProgressWindow
        .createLine({
          text: getString('auto-update-scanning'),
          type: 'default',
          progress: 0,
        })
        .createLine({
          text: getString('progress-step-preparing'),
          type: 'default',
        })
        .show()
    }

    const itemsToUpdate = await getItemsNeedingUpdate()

    if (!addon.data.alive) return

    if (itemsToUpdate.length === 0) {
      ztoolkit.log('Auto update: No items need updating')
      closeProgressWindow()
      // Only report "up to date" for an explicit menu action; on startup it
      // would just be noise.
      if (!silent && ignoreAutoUpdateMode) {
        const upToDateWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
          closeOnClick: true,
          closeTime: 4000,
        })
        upToDateWindow
          .createLine({
            text: getString('auto-update-none'),
            type: 'success',
            progress: 100,
          })
          .show()
      }
      return
    }

    ztoolkit.log(`Auto update: Found ${itemsToUpdate.length} items needing updates`)

    if (!checkIfRunnable()) {
      closeProgressWindow()
      return
    }

    autoUpdateQueue = itemsToUpdate
    autoUpdateIndex = 0
    autoUpdateRetryCount = 0
    autoUpdateUpdatedCount = 0

    if (!silent && autoUpdateProgressWindow) {
      safeChangeLine(autoUpdateProgressWindow, {
        text: getString('auto-update-updating-outdated', { args: { count: itemsToUpdate.length } }),
        progress: 0,
        idx: AUTO_PROGRESS_LINE_STATUS,
      })
    }

    await processAutoUpdateQueue(silent)
  } catch (error) {
    ztoolkit.log('Auto update: Error getting items to update:', error)
    closeProgressWindow()
    if (!silent && addon.data.alive) {
      const failureWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: 5000,
      })
      failureWindow
        .createLine({
          text: getString('auto-update-stopped', { args: { error: String(error) } }),
          type: 'fail',
          progress: 100,
        })
        .show()
    }
  } finally {
    autoUpdateInProgress = false
    resetAutoUpdateState()
  }
}

/**
 * Process the automatic update queue. Each item is retried a bounded number of
 * times for temporary failures; a confirmed 404 is recorded by `updateItem`
 * itself and is not retried here.
 */
async function processAutoUpdateQueue(silent: boolean = false): Promise<void> {
  while (autoUpdateInProgress && addon.data.alive && autoUpdateIndex < autoUpdateQueue.length) {
    if (!checkIfRunnable()) {
      finishAutomaticUpdate(getString('auto-update-connection-error'), silent)
      return
    }

    const { item, databases } = autoUpdateQueue[autoUpdateIndex]
    const progress = Math.round((autoUpdateIndex / autoUpdateQueue.length) * 100)
    const title = item?.getField('title') || 'No title'

    ztoolkit.log(`[${autoUpdateIndex + 1}/${autoUpdateQueue.length}] Processing: ${title} (${progress}%)`)

    if (!silent && autoUpdateProgressWindow) {
      safeChangeLine(autoUpdateProgressWindow, {
        text: getString('auto-update-updating-item', {
          args: { current: autoUpdateIndex + 1, total: autoUpdateQueue.length },
        }),
        progress,
        idx: AUTO_PROGRESS_LINE_STATUS,
      })
      safeChangeLine(autoUpdateProgressWindow, {
        text: getString('progress-step-preparing'),
        type: 'default',
        idx: AUTO_PROGRESS_LINE_STEP,
      })
    }

    // Report each lookup step (database queried / rate-limit wait) into the
    // window's second line so long runs show what is currently happening.
    const onStep: StepReporter | undefined =
      silent || !autoUpdateProgressWindow
        ? undefined
        : (text: string) => safeChangeLine(autoUpdateProgressWindow, { text, idx: AUTO_PROGRESS_LINE_STEP })

    let outcome: Awaited<ReturnType<typeof updateItem>> | null = null
    try {
      outcome = await updateItem(item, databases, true, true, false, onStep)
    } catch (error) {
      ztoolkit.log('Auto update error:', error)
    }

    if (!autoUpdateInProgress) return

    if (outcome?.wrote) {
      autoUpdateUpdatedCount++
    }

    if (outcome?.transient && autoUpdateRetryCount < MAX_RETRIES) {
      autoUpdateRetryCount++
      ztoolkit.log(`Auto update: Retry ${autoUpdateRetryCount}/${MAX_RETRIES} for item ${item.id}`)
      if (!silent && autoUpdateProgressWindow) {
        safeChangeLine(autoUpdateProgressWindow, {
          text: getString('auto-update-connection-retry', {
            args: { current: autoUpdateRetryCount, max: MAX_RETRIES },
          }),
          type: 'default',
          idx: AUTO_PROGRESS_LINE_STATUS,
        })
      }
      await delay(RETRY_DELAY)
      continue
    }

    // Move on after a success, a permanent failure, or exhausted retries.
    autoUpdateRetryCount = 0
    autoUpdateIndex++
    await delay(0)
  }

  if (autoUpdateInProgress) {
    finishAutomaticUpdate(undefined, silent)
  }
}

/**
 * Finish the automatic update process
 */
function finishAutomaticUpdate(errorMessage?: string, silent: boolean = false) {
  const updatedCount = autoUpdateUpdatedCount
  const totalCount = autoUpdateQueue.length

  autoUpdateInProgress = false

  closeProgressWindow()

  // Show completion message
  if (!silent && addon.data.alive) {
    const completionWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 5000,
    })

    if (errorMessage) {
      completionWindow.createLine({
        text: getString('auto-update-stopped', { args: { error: errorMessage } }),
        type: 'fail',
        progress: 100,
      })
    } else {
      completionWindow.createLine({
        text: getString('auto-update-completed', { args: { updated: updatedCount, total: totalCount } }),
        type: 'success',
        progress: 100,
      })
    }
    completionWindow.show()
  }

  // Reset state
  resetAutoUpdateState()

  ztoolkit.log(`Auto update completed: ${updatedCount}/${totalCount} items updated`)
}

/**
 * Stop a running automatic update without showing a completion summary.
 * Called when the plugin shuts down or is disabled.
 */
function stopAutomaticUpdate(): void {
  if (!autoUpdateInProgress && !autoUpdateQueue.length) return
  autoUpdateInProgress = false
  closeProgressWindow()
  resetAutoUpdateState()
  ztoolkit.log('Auto update: stopped')
}

export { startAutomaticUpdate, stopAutomaticUpdate }
