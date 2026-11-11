import { getLocaleID, getString } from '../utils/locale'
import { getPref } from '../utils/prefs'

import {
  DATABASE_IDS,
  DATABASE_STORAGE_NAMES,
  extractIdentifiers,
  formatDate,
  normalizeArxivId,
  normalizeDoi,
  parseExtra,
  pickLatestEntry,
  trimExtraHistory,
} from './citationData'
import { fetchWithTimeout, readJson } from './http'
import { IgnoredItemsStore } from './ignoredItems'

import type { DatabaseId, ParsedExtra } from './citationData'

// Default rate limits per database (in milliseconds)
const DEFAULT_RATE_LIMITS: Record<string, number> = {
  crossref: 1000,
  inspire: 1000,
  semanticscholar: 3000,
  openalex: 1000,
}

const MAX_RATE_LIMIT_MULTIPLIER = 10

// Custom columns are sorted by their dataProvider string, so numeric values are
// zero-padded to a fixed width to make the item tree sort them numerically.
const SORT_PAD_WIDTH = 12

// Adaptive rate limiting state
class RateLimitManager {
  private static multipliers: Record<string, number> = {}
  private static lastRequestTime: Record<string, number> = {}

  static getDelay(database: string): number {
    const baseLimits = getPref('rateLimits')
    let baseDelay: number

    if (baseLimits && typeof baseLimits === 'string') {
      try {
        const parsed = JSON.parse(baseLimits) as Record<string, number>
        baseDelay = parsed[database] || DEFAULT_RATE_LIMITS[database] || 1000
      } catch {
        baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
      }
    } else {
      baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
    }

    const multiplier = this.multipliers[database] || 1
    return baseDelay * multiplier
  }

  static handleRateLimit(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    const newMultiplier = Math.min(currentMultiplier * 1.5, MAX_RATE_LIMIT_MULTIPLIER)
    this.multipliers[database] = newMultiplier

    ztoolkit.log(`Rate limit detected for ${database}: increasing multiplier to ${newMultiplier.toFixed(1)}x`)
  }

  static handleSuccess(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    if (currentMultiplier > 1) {
      // Gradually decrease multiplier on success
      const newMultiplier = Math.max(currentMultiplier * 0.9, 1)
      this.multipliers[database] = newMultiplier

      if (newMultiplier < currentMultiplier) {
        ztoolkit.log(`Success for ${database}: decreasing multiplier to ${newMultiplier.toFixed(1)}x`)
      }
    }
  }

  static async waitForRateLimit(database: string, reporter?: StepReporter): Promise<void> {
    const delay = this.getDelay(database)
    const lastRequest = this.lastRequestTime[database] || 0
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequest

    if (timeSinceLastRequest < delay) {
      const waitTime = delay - timeSinceLastRequest
      ztoolkit.log(`Rate limiting ${database}: waiting ${waitTime}ms (${this.multipliers[database] || 1}x multiplier)`)
      // Tell the progress window which API we are waiting for, so a long pause
      // is not mistaken for a hang.
      reporter?.(rateLimitStepText(database, waitTime))
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    this.lastRequestTime[database] = Date.now()
  }
}

// Citation source operations

interface LookupResult {
  count: number
  status: 'success' | 'not_found' | 'api_error' | 'no_identifier' | 'rate_limited'
  message?: string
  fwci?: number // Field-Weighted Citation Impact (OpenAlex)
}

/**
 * Callback used to report fine-grained progress while a single item is being
 * looked up. The text is a fully localized message describing the current step
 * (e.g. which database is being queried or waited on).
 */
type StepReporter = (text: string) => void

export interface UpdateOutcome {
  /** At least one configured database returned usable data. */
  success: boolean
  /** The item's Extra field was actually changed. */
  wrote: boolean
  /** At least one source failed for a temporary reason and may be retried. */
  transient: boolean
  statuses: Record<string, LookupResult['status']>
}

// Schedule periodic cleanup. A 30-day `setTimeout` overflows the 32-bit timer
// limit in Gecko and fires almost immediately, so the long period is expressed
// as a daily check plus a persisted timestamp.
const CLEANUP_CHECK_INTERVAL = 24 * 60 * 60 * 1000
const CLEANUP_MIN_INTERVAL = 30 * 24 * 60 * 60 * 1000
const CLEANUP_STARTUP_DELAY = 5000

let cleanupInterval: ReturnType<typeof setInterval> | null = null
let cleanupStartupTimeout: ReturnType<typeof setTimeout> | null = null

async function runCleanupIfDue(force = false): Promise<void> {
  if (!addon.data.alive) return
  const lastCleanup = Number(getPref('lastIgnoredCleanup') || 0)
  if (!force && Number.isFinite(lastCleanup) && Date.now() - lastCleanup < CLEANUP_MIN_INTERVAL) {
    return
  }
  await IgnoredItemsStore.cleanupNonExistentItems()
}

function scheduleMonthlyCleanup() {
  stopMonthlyCleanup()

  cleanupStartupTimeout = setTimeout(() => {
    cleanupStartupTimeout = null
    void runCleanupIfDue(true)
  }, CLEANUP_STARTUP_DELAY)

  cleanupInterval = setInterval(() => {
    void runCleanupIfDue()
  }, CLEANUP_CHECK_INTERVAL)
}

/**
 * Stop the scheduled cleanup (call on shutdown so the timers do not outlive a
 * disabled plugin).
 */
function stopMonthlyCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
  if (cleanupStartupTimeout) {
    clearTimeout(cleanupStartupTimeout)
    cleanupStartupTimeout = null
  }
}

// Localized display names for the progress UI and column tooltips. The values
// stored in Extra are the stable names from citationData.ts, not these labels.
const operationNameCache = new Map<string, string>()

function getOperationName(key: string): string {
  const cached = operationNameCache.get(key)
  if (cached) return cached
  const nameMap = {
    crossref: 'database-crossref',
    inspire: 'database-inspire',
    semanticscholar: 'database-semanticscholar',
    openalex: 'database-openalex',
  } as const
  const fluentId = nameMap[key as keyof typeof nameMap]
  const name = fluentId ? getString(fluentId) : key
  operationNameCache.set(key, name)
  return name
}

/**
 * Localized progress text for "querying a database".
 */
function queryStepText(database: string): string {
  return getString('progress-step-querying', { args: { displayName: getOperationName(database) } })
}

/**
 * Localized progress text for an adaptive rate-limit wait.
 */
function rateLimitStepText(database: string, waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000))
  return getString('progress-step-rate-limit', {
    args: { displayName: getOperationName(database), seconds },
  })
}

// Database colors for dark theme (default)
const databaseColorsDark: Record<string, string> = {
  crossref: '#1a73e8', // Blue
  inspire: '#0f9d58', // Green
  semanticscholar: '#ea4335', // Red
  openalex: '#9334e6', // Purple
}

// Database colors for light theme (higher contrast)
const databaseColorsLight: Record<string, string> = {
  crossref: '#000000', // Black
  inspire: '#0f9d58', // Green
  semanticscholar: '#cc0000', // Dark Red
  openalex: '#6a0dad', // Dark Purple
}

/**
 * Detect if Zotero is using a light color scheme
 * @returns true if light mode, false if dark mode
 */
function isLightMode(): boolean {
  try {
    // Zotero's color scheme follows Firefox's toolbar-theme pref:
    // 0 = light, 1 = dark, 2 = follow the system
    const toolbarTheme = Zotero.Prefs.get('browser.theme.toolbar-theme', true) as number | undefined

    if (toolbarTheme === 0) {
      return true
    }
    if (toolbarTheme === 1) {
      return false
    }

    // 'auto' or unset: check system preference
    const win = Zotero.getMainWindow()
    if (win) {
      const mediaQuery = win.matchMedia?.('(prefers-color-scheme: dark)')
      if (mediaQuery) {
        return !mediaQuery.matches
      }

      // Fallback: check document background color
      const docEl = win.document?.documentElement
      if (docEl) {
        const bgColor = win.getComputedStyle?.(docEl)?.backgroundColor
        if (bgColor) {
          // Parse RGB and check if it's dark (low luminance)
          const rgb = bgColor.match(/\d+/g)
          if (rgb && rgb.length >= 3) {
            const luminance = (0.299 * parseInt(rgb[0]) + 0.587 * parseInt(rgb[1]) + 0.114 * parseInt(rgb[2])) / 255
            return luminance > 0.5 // Light if luminance > 0.5
          }
        }
      }
    }
  } catch (e) {
    ztoolkit.log(`Theme detection error: ${String(e)}`)
  }

  // Default to dark mode colors if detection fails
  return false
}

/**
 * Get the appropriate database colors based on current theme
 * @returns Database color mapping for current theme
 */
function getDatabaseColors(): Record<string, string> {
  return isLightMode() ? databaseColorsLight : databaseColorsDark
}

/**
 * Refresh the items tree to update column colors
 */
function refreshItemsTree(): void {
  try {
    // Refresh all item tree columns to pick up new colors
    const manager = Zotero.ItemTreeManager as { refreshColumns?: () => void }
    manager.refreshColumns?.()
    ztoolkit.log('Refreshed columns')
  } catch (e) {
    ztoolkit.log(`Failed to refresh columns: ${String(e)}`)
  }
}

// Store references for cleanup. Observers are registered once per plugin
// lifetime, not once per window; otherwise every extra Zotero window leaks
// another set of observers.
let themeMediaQueryList: MediaQueryList | null = null
let themeMediaListener: (() => void) | null = null
let themePrefObserverId: symbol | null = null
let colorPrefObserverId: symbol | null = null
let themeObserversRegistered = false

/**
 * Register observers for theme and color preference changes.
 * Idempotent: safe to call from startup and from each window load.
 */
function registerThemeObservers(): void {
  if (themeObserversRegistered) return
  themeObserversRegistered = true

  try {
    themePrefObserverId = Zotero.Prefs.registerObserver(
      'browser.theme.toolbar-theme',
      () => {
        ztoolkit.log('Zotero theme preference changed')
        refreshItemsTree()
      },
      true,
    )

    colorPrefObserverId = Zotero.Prefs.registerObserver(
      `${addon.data.config.prefsPrefix}.useColors`,
      () => {
        ztoolkit.log('Plugin color preference changed')
        refreshItemsTree()
      },
      true,
    )

    const win = Zotero.getMainWindow()
    if (win?.matchMedia) {
      const mql = win.matchMedia('(prefers-color-scheme: dark)')
      if (mql) {
        themeMediaQueryList = mql
        themeMediaListener = () => {
          ztoolkit.log('System theme changed')
          refreshItemsTree()
        }
        mql.addEventListener('change', themeMediaListener)
      }
    }

    ztoolkit.log('Theme and color observers registered')
  } catch (e) {
    themeObserversRegistered = false
    ztoolkit.log(`Failed to register theme observers: ${String(e)}`)
  }
}

/**
 * Unregister theme observers (call on shutdown)
 */
function unregisterThemeObservers(): void {
  try {
    if (themePrefObserverId) {
      Zotero.Prefs.unregisterObserver(themePrefObserverId)
      themePrefObserverId = null
    }
    if (colorPrefObserverId) {
      Zotero.Prefs.unregisterObserver(colorPrefObserverId)
      colorPrefObserverId = null
    }
    if (themeMediaQueryList && themeMediaListener) {
      themeMediaQueryList.removeEventListener('change', themeMediaListener)
    }
    themeMediaQueryList = null
    themeMediaListener = null
    themeObserversRegistered = false
    ztoolkit.log('Theme observers unregistered')
  } catch (e) {
    ztoolkit.log(`Failed to unregister theme observers: ${String(e)}`)
  }
}

class Helpers {
  /**
   * Get all possible identifiers from item (for fallback when primary fails)
   * @param item Zotero item
   * @returns Array of objects with type and id, ordered by preference
   */
  static getAllItemIdentifiers(item: Zotero.Item): { type: string; id: string; source: string }[] {
    return extractIdentifiers({
      doi: item.getField('DOI'),
      archiveID: item.getField('archiveID'),
      reportNumber: item.getField('reportNumber'),
      extra: item.getField('extra'),
      url: item.getField('url'),
      callNumber: item.getField('callNumber'),
    })
  }

  /**
   * Get DOI or arXiv ID from item
   * @param item Zotero item
   * @returns Object with type and id, or null if neither found
   */
  static getItemIdentifier(item: Zotero.Item): { type: string; id: string } | null {
    const identifiers = this.getAllItemIdentifiers(item)
    return identifiers.length > 0 ? identifiers[0] : null
  }

  static getDatabasePrefArray(): string[] {
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const databaseArray = [
      ...new Set(
        databaseOrder
          .split(',')
          .map((db: string) => db.trim())
          .filter((db) => (DATABASE_IDS as readonly string[]).includes(db)),
      ),
    ]
    if (databaseArray.length === 0) {
      ztoolkit.log('Citation debug - No valid databases configured in preferences')
    }
    return databaseArray
  }

  static getDatabaseArray(operations: string[] | string | undefined): string[] {
    if (operations === undefined) {
      return Helpers.getDatabasePrefArray()
    } else if (typeof operations === 'string') {
      return operations.split(',').map((db: string) => db.trim())
    } else if (Array.isArray(operations)) {
      return operations.map((db: string) => db.trim())
    }
    ztoolkit.log('Citation debug - No databases found')
    return []
  }
}
interface CountInfo {
  title: string // Database tag (e.g., 'crossref')
  count: number // Citation count
  fwci?: number // Field-Weighted Citation Impact (OpenAlex)
}
type CountArray = CountInfo[]

// All Extra reads/modifies/writes go through this chain. The previous code read
// Extra at the start of a lookup and wrote it after an `await`, so manual,
// automatic, and fetch-on-add runs could overwrite each other's new lines.
let extraWriteChain: Promise<unknown> = Promise.resolve()

function withExtraWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = extraWriteChain.then(task, task)
  // Keep the chain alive even when a task fails; the caller still gets the error.
  extraWriteChain = run.catch(() => undefined)
  return run
}

// Column data providers run for every visible item on every repaint. Cache the
// parsed Extra text by item id and invalidate when the field changes.
const PARSED_EXTRA_CACHE_LIMIT = 1000
const parsedExtraCache = new Map<number, { extra: string; parsed: ParsedExtra }>()

function getParsedExtra(item: Zotero.Item): ParsedExtra {
  const extra = item.getField('extra') || ''
  const cached = parsedExtraCache.get(item.id)
  if (cached && cached.extra === extra) return cached.parsed

  const parsed = parseExtra(extra)
  parsedExtraCache.delete(item.id)
  parsedExtraCache.set(item.id, { extra, parsed })
  if (parsedExtraCache.size > PARSED_EXTRA_CACHE_LIMIT) {
    const oldest = parsedExtraCache.keys().next().value
    if (oldest !== undefined) parsedExtraCache.delete(oldest)
  }
  return parsed
}

class Core {
  /**
   * Store citation count in the Extra field
   * @param item Zotero item
   * @param data citation counts to store
   * @param onStep Optional callback receiving a localized description of the current step.
   *   Only called when something is actually written — announcing "saving" for a
   *   no-op (all entries already present for today) would be misleading.
   * @returns true if the item was modified and saved, false otherwise
   */
  static async setCitationCount(item: Zotero.Item, data: CountArray, onStep?: StepReporter): Promise<boolean> {
    return withExtraWriteLock(async () => {
      if (!addon.data.alive) return false

      // Re-read under the lock. Another run may have written since the caller
      // fetched this item.
      try {
        await item.reload(['extra'], true)
      } catch (e) {
        ztoolkit.log('Citation debug - Could not reload Extra before writing:', e)
      }

      const extra = item.getField('extra') || ''
      ztoolkit.log('Citation debug - Setting citation count for item:', item.id, 'count:', data)

      const extras = extra.split('\n')
      const date = formatDate()
      let modified = false

      // Append-only: never remove user lines. Plugin-owned history is capped
      // below so a long-lived item does not accumulate thousands of entries.
      for (const { title, count, fwci } of data) {
        const newEntry = `Citations: ${count} (${title}) [${date}]`

        if (!extras.includes(newEntry)) {
          extras.unshift(newEntry)
          modified = true
        }

        // Store FWCI if available (OpenAlex-specific)
        if (fwci !== undefined && fwci !== null && Number.isFinite(fwci)) {
          const fwciEntry = `FWCI: ${Number(fwci).toFixed(2)} (${title}) [${date}]`
          if (!extras.includes(fwciEntry)) {
            extras.unshift(fwciEntry)
            modified = true
          }
        }
      }

      if (modified) {
        const newExtra = trimExtraHistory(extras.join('\n'))
        onStep?.(getString('progress-step-saving'))
        // Give the window a chance to paint the save label before the write.
        await yieldToUI()
        item.setField('extra', newExtra)
        // skipSelect: batch updates must not keep moving the library selection
        await item.saveTx({ skipSelect: true })
        ztoolkit.log('Citation debug - Updated Extra field')
      }
      return modified
    })
  }

  /**
   * Extract citation count from the Extra field for display in custom column
   * @param item Zotero item
   * @returns Object with counts and databases for rendering
   */
  static getCitationCountForColumn(item: Zotero.Item): { counts: string[]; databases: string[] } | null {
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const operationsIncluded = databaseOrder.split(',').map((db: string) => db.trim())
    const parsed = getParsedExtra(item)

    const counts: string[] = []
    const databases: string[] = []
    for (const tag of operationsIncluded) {
      const entry = parsed.citations[tag as DatabaseId]
      counts.push(entry ? String(entry.value) : '-')
      databases.push(tag)
    }

    const hasAnyCount = counts.some((count) => count !== '-')
    return hasAnyCount ? { counts, databases } : null
  }

  /**
   * Extract FWCI from Extra field for display in custom column
   * @param item Zotero item
   * @returns FWCI string or '-' if not found
   */
  static getFWCIForColumn(item: Zotero.Item): string {
    // Scan all known sources, not just configured ones: FWCI data may exist
    // from previous plugins (e.g. zotero-cc) regardless of current settings.
    const best = pickLatestEntry(getParsedExtra(item).fwci)
    return best ? best.value.toFixed(2) : '-'
  }

  /**
   * Extract publication date from a Zotero item's date field.
   * Returns year, month (1-12), and optionally day for precise age calculation.
   * @param item Zotero item
   * @returns Object with year, month, day fields, or null if year unparseable
   */
  static getPublicationDate(item: Zotero.Item): { year: number; month: number; day: number | null } | null {
    const dateStr = item.getField('date')
    if (!dateStr) return null

    // Try YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
    const fullDateMatch = dateStr.match(/\b(1[0-9]{3}|20[0-9]{2}|2100)[-/.](\d{1,2})[-/.](\d{1,2})\b/)
    if (fullDateMatch) {
      const year = parseInt(fullDateMatch[1], 10)
      const month = parseInt(fullDateMatch[2], 10)
      const day = parseInt(fullDateMatch[3], 10)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return { year, month, day }
      }
    }

    // Try YYYY-MM or YYYY/MM
    const yearMonthMatch = dateStr.match(/\b(1[0-9]{3}|20[0-9]{2}|2100)[-/.](\d{1,2})\b/)
    if (yearMonthMatch) {
      const year = parseInt(yearMonthMatch[1], 10)
      const month = parseInt(yearMonthMatch[2], 10)
      if (month >= 1 && month <= 12) {
        return { year, month, day: null }
      }
    }

    // Fallback: bare 4-digit year
    const yearMatch = dateStr.match(/\b(1[0-9]{3}|20[0-9]{2}|2100)\b/)
    if (yearMatch) {
      return { year: parseInt(yearMatch[1], 10), month: 0, day: null }
    }
    return null
  }

  /**
   * Extract publication year from a Zotero item's date field.
   * Convenience wrapper for getPublicationDate.
   * @param item Zotero item
   * @returns Publication year or null if unparseable
   */
  static getPublicationYear(item: Zotero.Item): number | null {
    const date = this.getPublicationDate(item)
    return date ? date.year : null
  }

  /**
   * Find the most recent citation count across ALL known sources in the Extra field
   * @param extra The Extra field content
   * @returns The latest citation count and its source name, or null if none found
   */
  static findLatestCitationFromExtra(extra: string): { count: number; sourceName: string; date: string | null } | null {
    const best = pickLatestEntry(parseExtra(extra).citations)
    if (!best) return null
    return { count: best.value, sourceName: best.database, date: best.date }
  }

  /**
   * Compute the average citations per year entry for an item without saving.
   * Uses the latest citation count (across all sources) divided by years since publication.
   * The endpoint for the time span is the citation count's own date (when the citation
   * data was fetched), not the current date — this keeps the metric stable and meaningful
   * even if the user recomputes it long after fetching.
   * @param item Zotero item
   * @returns the new Extra entry, or null if it cannot/should not be computed
   */
  static computeAvgCiteEntry(item: Zotero.Item): string | null {
    const extra = item.getField('extra') || ''
    const citationInfo = Core.findLatestCitationFromExtra(extra)
    if (!citationInfo) {
      ztoolkit.log('AvgCite debug - No citation data found for item:', item.id)
      return null
    }

    const pubDate = Core.getPublicationDate(item)
    if (pubDate === null) {
      ztoolkit.log('AvgCite debug - No publication year for item:', item.id)
      return null
    }

    // Parse the citation's date as the endpoint for the time span.
    // If the citation entry has no date, fall back to the current date.
    let endDate: Date
    let dateStr: string
    if (citationInfo.date) {
      const parts = citationInfo.date.split('-')
      endDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
      dateStr = citationInfo.date
    } else {
      endDate = new Date()
      dateStr = formatDate(endDate)
    }

    // Compute fractional years since publication for higher precision.
    // If only year is known (month === 0), assume mid-year (July 2 ≈ day 183).
    // If year + month are known (day === null), assume mid-month (15th).
    let yearsSincePub: number
    if (pubDate.month === 0) {
      // Bare year: assume July 2 (mid-year, ~183 days in)
      const pubTime = new Date(pubDate.year, 6, 2).getTime()
      yearsSincePub = (endDate.getTime() - pubTime) / (365.25 * 24 * 60 * 60 * 1000)
    } else if (pubDate.day === null) {
      // Year + month: assume 15th of the month
      const pubTime = new Date(pubDate.year, pubDate.month - 1, 15).getTime()
      yearsSincePub = (endDate.getTime() - pubTime) / (365.25 * 24 * 60 * 60 * 1000)
    } else {
      // Full date: use exact day
      const pubTime = new Date(pubDate.year, pubDate.month - 1, pubDate.day).getTime()
      yearsSincePub = (endDate.getTime() - pubTime) / (365.25 * 24 * 60 * 60 * 1000)
    }
    // Floor at ~1 month (0.08 year) to prevent inflated averages for brand-new papers
    yearsSincePub = Math.max(0.08, yearsSincePub)
    const avgCite = citationInfo.count / yearsSincePub

    const storageName = DATABASE_STORAGE_NAMES[citationInfo.sourceName as DatabaseId] || citationInfo.sourceName
    const newEntry = `AvgCite: ${avgCite.toFixed(2)} (${storageName}) [${dateStr}]`

    const extras = extra.split('\n')
    if (extras.includes(newEntry)) {
      ztoolkit.log('AvgCite debug - Skipping exact duplicate:', newEntry)
      return null
    }

    return newEntry
  }

  /**
   * Store a precomputed AvgCite entry in an item's Extra field.
   * Separate from {@link computeAvgCiteEntry} so a batch run can compute every
   * item first and then write them all inside one transaction.
   * @param item Zotero item
   * @param newEntry entry produced by computeAvgCiteEntry
   */
  static async storeAvgCiteEntry(item: Zotero.Item, newEntry: string): Promise<void> {
    // The batch path computes entries before it writes. Re-read here so a
    // citation update that landed in between is not overwritten.
    try {
      await item.reload(['extra'], true)
    } catch (e) {
      ztoolkit.log('AvgCite debug - Could not reload Extra before writing:', e)
    }
    const extra = item.getField('extra') || ''
    const extras = extra.split('\n')
    if (extras.includes(newEntry)) return

    extras.unshift(newEntry)
    item.setField('extra', trimExtraHistory(extras.join('\n')))
    // skipSelect: batch updates must not keep moving the library selection.
    // save() when already inside a transaction, so we don't nest a second one.
    if (Zotero.DB.inTransaction()) {
      await item.save({ skipSelect: true })
    } else {
      await item.saveTx({ skipSelect: true })
    }
    ztoolkit.log('AvgCite debug - Stored avg cite:', newEntry)
  }

  /**
   * Compute and store average citations per year in the Extra field.
   * Convenience wrapper for a single item (one transaction per call). Batch
   * callers should use computeAvgCiteEntry + a single batch transaction.
   * @param item Zotero item
   * @param onStep Optional callback receiving a localized description of the current step
   * @returns true if a new entry was stored, false otherwise
   */
  static async computeAndSetAvgCiteForItem(item: Zotero.Item, onStep?: StepReporter): Promise<boolean> {
    return withExtraWriteLock(async () => {
      if (!addon.data.alive) return false
      onStep?.(getString('progress-step-avgcite-reading'))
      try {
        await item.reload(['extra'], true)
      } catch (e) {
        ztoolkit.log('AvgCite debug - Could not reload Extra before writing:', e)
      }
      const newEntry = Core.computeAvgCiteEntry(item)
      if (newEntry === null) return false

      onStep?.(getString('progress-step-saving'))
      await Core.storeAvgCiteEntry(item, newEntry)
      return true
    })
  }

  /**
   * Extract average citations per year from the Extra field for display in custom column
   * @param item Zotero item
   * @returns AvgCite value string or '-' if not found
   */
  static getAvgCiteForColumn(item: Zotero.Item): string {
    const best = pickLatestEntry(getParsedExtra(item).avgCite)
    return best ? best.value.toFixed(2) : '-'
  }
}

function parseCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

class DBInterface {
  /**
   * Get citation count from Crossref
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getCrossrefCount(item: Zotero.Item): Promise<number> {
    const result = await this.getCrossrefCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from Crossref with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getCrossrefCountEnhanced(item: Zotero.Item, reporter?: StepReporter): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    const doi = identifier?.type === 'doi' ? normalizeDoi(identifier.id) : null
    if (!doi) {
      ztoolkit.log('Citation debug - No DOI found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found' }
    }

    await RateLimitManager.waitForRateLimit('crossref', reporter)
    reporter?.(queryStepText('crossref'))

    try {
      // The search route with an explicit `select` is ~250 bytes instead of the
      // ~200 KB CSL transform, and still returns the citation count.
      const url = `https://api.crossref.org/works?filter=doi:${encodeURIComponent(
        doi,
      )}&rows=1&select=DOI,is-referenced-by-count`
      const response = await fetchWithTimeout(url, {
        headers: { Accept: 'application/json' },
      })

      if (response.status === 404) {
        return { count: 0, status: 'not_found', message: 'DOI not found in Crossref' }
      }
      if (response.status === 429) {
        RateLimitManager.handleRateLimit('crossref')
        return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
      }
      if (!response.ok) {
        return { count: -1, status: 'api_error', message: `Crossref HTTP ${response.status}` }
      }

      const body = await readJson(response)
      const items = body?.message?.items
      if (!Array.isArray(items) || items.length === 0) {
        return { count: 0, status: 'not_found', message: 'DOI not found in Crossref' }
      }

      const count = parseCount(items[0]?.['is-referenced-by-count'])
      if (count === null) {
        return { count: -1, status: 'api_error', message: 'Invalid citation count in Crossref response' }
      }

      RateLimitManager.handleSuccess('crossref')
      return { count, status: 'success' }
    } catch (err) {
      ztoolkit.log('Error getting citation count from Crossref', err)
      return { count: -1, status: 'api_error', message: (err as Error).message }
    }
  }

  /**
   * Get citation count from INSPIRE
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getInspireCount(item: Zotero.Item): Promise<number> {
    const result = await this.getInspireCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from INSPIRE with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getInspireCountEnhanced(item: Zotero.Item, reporter?: StepReporter): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    let sawNotFound = false
    let sawApiError = false
    let sawIdentifier = false

    // Try each identifier until one succeeds. A 404 only means "not found"
    // when no request failed for a transient reason.
    for (const identifier of identifiers) {
      let path: string
      if (identifier.type === 'doi') {
        const doi = normalizeDoi(identifier.id)
        if (!doi) {
          sawApiError = true
          continue
        }
        path = `doi/${encodeURIComponent(doi)}`
      } else {
        path = `arxiv/${encodeURIComponent(identifier.id)}`
      }
      sawIdentifier = true

      await RateLimitManager.waitForRateLimit('inspire', reporter)
      reporter?.(queryStepText('inspire'))

      try {
        const url = `https://inspirehep.net/api/${path}`
        const fetchResponse = await fetchWithTimeout(url)

        if (fetchResponse.status === 404) {
          sawNotFound = true
          continue
        }
        if (fetchResponse.status === 429) {
          RateLimitManager.handleRateLimit('inspire')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }
        if (!fetchResponse.ok) {
          sawApiError = true
          continue
        }

        const response = await readJson(fetchResponse)
        if (response === null) {
          sawApiError = true
          continue
        }

        const count = parseCount(response?.metadata?.citation_count)
        if (count === null) {
          sawApiError = true
          continue
        }

        RateLimitManager.handleSuccess('inspire')
        return { count, status: 'success' }
      } catch (err) {
        ztoolkit.log(`Error getting citation count from INSPIRE for ${identifier.type} ID ${identifier.id}:`, err)
        sawApiError = true
      }
    }

    if (!sawIdentifier) {
      return { count: -1, status: 'no_identifier', message: 'No valid DOI or arXiv ID found' }
    }
    if (sawApiError) {
      return { count: -1, status: 'api_error', message: 'INSPIRE request failed' }
    }
    if (sawNotFound) {
      return { count: 0, status: 'not_found', message: 'No valid identifiers found in INSPIRE' }
    }
    return { count: -1, status: 'api_error', message: 'Unexpected INSPIRE result' }
  }

  /**
   * Get citation count from Semantic Scholar
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getSemanticScholarCount(item: Zotero.Item): Promise<number> {
    const result = await this.getSemanticScholarCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from Semantic Scholar with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getSemanticScholarCountEnhanced(item: Zotero.Item, reporter?: StepReporter): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    let sawNotFound = false
    let sawApiError = false
    let sawIdentifier = false

    for (const identifier of identifiers) {
      let apiPath: string

      if (identifier.type === 'arxiv') {
        apiPath = `arXiv:${encodeURIComponent(identifier.id)}`
      } else {
        const doi = normalizeDoi(identifier.id)
        if (!doi) {
          sawApiError = true
          continue
        }
        const arxivFromDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)
        if (arxivFromDoi) {
          // Semantic Scholar does not resolve arXiv DOIs, but it does resolve
          // the equivalent `arXiv:<id>` form.
          const arxivId = normalizeArxivId(arxivFromDoi[1])
          if (!arxivId) {
            sawApiError = true
            continue
          }
          apiPath = `arXiv:${encodeURIComponent(arxivId)}`
        } else {
          // Keep the DOI slash readable; encode everything else.
          apiPath = encodeURIComponent(doi).replace(/%2F/gi, '/')
        }
      }
      sawIdentifier = true

      await RateLimitManager.waitForRateLimit('semanticscholar', reporter)
      reporter?.(queryStepText('semanticscholar'))

      try {
        const url = `https://api.semanticscholar.org/graph/v1/paper/${apiPath}?fields=citationCount`
        const fetchResponse = await fetchWithTimeout(url)

        if (fetchResponse.status === 404) {
          sawNotFound = true
          continue
        }
        if (fetchResponse.status === 429) {
          RateLimitManager.handleRateLimit('semanticscholar')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }
        if (!fetchResponse.ok) {
          sawApiError = true
          continue
        }

        const response = await readJson(fetchResponse)
        if (response === null) {
          sawApiError = true
          continue
        }

        const count = parseCount(response?.citationCount)
        if (count === null) {
          sawApiError = true
          continue
        }

        RateLimitManager.handleSuccess('semanticscholar')
        return { count, status: 'success' }
      } catch (err) {
        ztoolkit.log(
          `Error getting citation count from Semantic Scholar for ${identifier.type} ID ${identifier.id}:`,
          err,
        )
        sawApiError = true
      }
    }

    if (!sawIdentifier) {
      return { count: -1, status: 'no_identifier', message: 'No valid DOI or arXiv ID found' }
    }
    if (sawApiError) {
      return { count: -1, status: 'api_error', message: 'Semantic Scholar request failed' }
    }
    if (sawNotFound) {
      return { count: 0, status: 'not_found', message: 'No valid identifiers found in Semantic Scholar' }
    }
    return { count: -1, status: 'api_error', message: 'Unexpected Semantic Scholar result' }
  }

  /**
   * Get citation count from OpenAlex
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getOpenAlexCount(item: Zotero.Item): Promise<number> {
    const result = await this.getOpenAlexCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from OpenAlex with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count, status, and optional FWCI
   */
  static async getOpenAlexCountEnhanced(item: Zotero.Item, reporter?: StepReporter): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    const doi = identifier?.type === 'doi' ? normalizeDoi(identifier.id) : null
    if (!doi) {
      ztoolkit.log('Citation debug - No DOI found for OpenAlex lookup:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found (OpenAlex requires DOI)' }
    }

    await RateLimitManager.waitForRateLimit('openalex', reporter)
    reporter?.(queryStepText('openalex'))

    try {
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?select=cited_by_count,fwci`
      const fetchResponse = await fetchWithTimeout(url)

      if (fetchResponse.status === 404) {
        return { count: 0, status: 'not_found', message: 'DOI not found in OpenAlex' }
      }
      if (fetchResponse.status === 429) {
        RateLimitManager.handleRateLimit('openalex')
        return { count: -1, status: 'rate_limited', message: 'OpenAlex API rate limit exceeded' }
      }
      if (!fetchResponse.ok) {
        return { count: -1, status: 'api_error', message: `OpenAlex HTTP ${fetchResponse.status}` }
      }

      const response = await readJson(fetchResponse)
      if (response === null) {
        return { count: -1, status: 'api_error', message: 'OpenAlex API response parsing failed' }
      }

      const count = parseCount(response.cited_by_count)
      const fwciValue = parseCount(response.fwci)
      if (count === null && fwciValue === null) {
        if (response.cited_by_count === undefined && response.fwci === undefined) {
          return { count: 0, status: 'not_found', message: 'No data in OpenAlex response' }
        }
        return { count: -1, status: 'api_error', message: 'Invalid citation data in OpenAlex response' }
      }

      RateLimitManager.handleSuccess('openalex')
      return {
        count: count ?? 0,
        status: 'success',
        fwci: fwciValue ?? undefined,
      }
    } catch (err) {
      ztoolkit.log('Error getting citation count from OpenAlex', err)
      return { count: -1, status: 'api_error', message: (err as Error).message }
    }
  }
}

// Notifier callback to detect newly added items
const notifierCallback = {
  notify: function (event: string, type: string, ids: number[] | string[], extraData: any) {
    if (event === 'add' && type === 'item') {
      // Check if fetching on add is enabled
      const fetchOnAdd = getPref('fetchOnAdd')
      if (fetchOnAdd !== 'true') {
        ztoolkit.log('Fetch on add disabled, skipping citation fetch for new items')
        return
      }

      const items = ids
        .map((id) => Zotero.Items.get(id as number))
        .filter((item) => !item.isFeedItem && item.isRegularItem())
      if (items.length > 0) {
        ztoolkit.log(
          'New regular items added with IDs:',
          items.map((item) => item.id),
        )
        // Do not go through `updateItems`: that resets the shared manual queue
        // and would cancel an update the user explicitly started.
        void updateNewItemsSilently(items)
      }
    }
  },
}

async function updateNewItemsSilently(items: Zotero.Item[]): Promise<void> {
  for (const item of items) {
    if (!addon.data.alive) return
    try {
      await updateItem(item, undefined, true, false, false)
    } catch (e) {
      ztoolkit.log('Fetch-on-add failed for item:', item.id, e)
    }
  }
}

// Progress window tracking
let progressWindow: any
let currentIndex = -1
let totalItems = 0
let itemsToUpdate: Zotero.Item[] = []
let updatedCount = 0
// Incremented on every new manual run. In-flight callbacks from a superseded
// run (user started another update) check it and bail out, so two chains cannot
// interleave and close each other's progress window.
let manualRunToken = 0

// Line indexes inside the progress window:
// 0 = item counter / overall status, 1 = current step (database being queried or waited on)
const PROGRESS_LINE_STATUS = 0
const PROGRESS_LINE_STEP = 1

// How many items to save per transaction during a batch run. Each chunk commits
// and then yields, so the progress counter can repaint between chunks. Kept
// small so the counter advances in visible steps on large selections.
const SAVE_CHUNK_SIZE = 5

/**
 * Change a line of a progress window, ignoring failures.
 * The user can dismiss the window at any time (closeOnClick), after which
 * updating a line throws — that must never abort the running update.
 */
function safeChangeLine(win: any, options: { text?: string; type?: string; progress?: number; idx?: number }): void {
  if (!win) return
  try {
    win.changeLine(options)
  } catch (e) {
    ztoolkit.log('Failed to update progress window:', e)
  }
}

/**
 * Hand control back to the event loop so the progress window can repaint.
 * This is a 0 ms yield, not a delay: purely local loops (e.g. computing avg
 * citations) would otherwise run to completion without the window ever drawing
 * the intermediate step lines.
 */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Create the two-line progress window used by every update run.
 * `closeTime: -1` is essential: the toolkit defaults to closing the window after
 * 5 seconds, which would hide it while the run is still going. We close it
 * explicitly when the run finishes.
 * @param statusText text for line 0 (overall status / item counter)
 * @param stepText text for line 1 (current step)
 */
function createStepProgressWindow(statusText: string, stepText: string): any {
  return new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: statusText,
      type: 'default',
      progress: 0,
    })
    .createLine({
      text: stepText,
      type: 'default',
    })
    .show()
}

/**
 * Reset the state of the citation count update process
 */
function resetState() {
  if (progressWindow) {
    try {
      progressWindow.close()
    } catch (e) {
      ztoolkit.log('Failed to close progress window:', e)
    }
    progressWindow = null
  }
  // Invalidate callbacks still in flight from a previous run
  manualRunToken++
  currentIndex = -1
  totalItems = 0
  itemsToUpdate = []
  updatedCount = 0
}

/**
 * Update citation counts for an array of items
 * @param items Array of Zotero items to update
 * @param operation Citation source to use (e.g., 'crossref')
 */
function updateItems(items: Zotero.Item[], operations?: string[] | string, silent: boolean = false) {
  // Filter out non-regular items
  const regularItems = items.filter((item) => item.isRegularItem())

  if (regularItems.length === 0) {
    if (!silent) {
      // Show message if no regular items are selected
      new ztoolkit.ProgressWindow('Citation Counts', {
        closeOnClick: true,
      })
        .createLine({
          text: getString('progress-no-valid-items'),
          type: 'error',
        })
        .show()
        .startCloseTimer(3000)
    }
    return
  }

  resetState()
  totalItems = regularItems.length
  itemsToUpdate = regularItems

  if (!silent) {
    // Create and show the progress window up front: the user should see it as
    // soon as the run starts, not only after the first item finished.
    progressWindow = createStepProgressWindow(
      getString('progress-getting-citation-tallies'),
      getString('progress-step-preparing'),
    )
  }

  updateNextItem(operations, silent)
}

/**
 * Process the next item in the queue
 * @param operation Citation source to use
 */
function updateNextItem(operations?: string[] | string, silent: boolean = false, runToken: number = manualRunToken) {
  // A newer manual run has started, or the plugin is shutting down; this chain
  // is stale and must not touch the shared queue or progress window any more.
  if (runToken !== manualRunToken || !addon.data.alive) return

  // Move to next item
  currentIndex++

  // Check if processing is complete
  if (currentIndex >= totalItems) {
    if (progressWindow) {
      try {
        progressWindow.close()
      } catch (e) {
        ztoolkit.log('Failed to close progress window:', e)
      }
      progressWindow = null
    }
    if (!silent) {
      const successWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: 4000,
      })

      successWindow.createLine({
        text: getString('progress-items-updated', { args: { count: updatedCount } }),
        type: 'success',
        progress: 100,
      })
      successWindow.show()
    }
    return
  }

  const item = itemsToUpdate[currentIndex]

  // Update the status line (counter + overall progress) and reset the step line
  if (!silent && progressWindow) {
    const percent = Math.round((currentIndex / totalItems) * 100)
    safeChangeLine(progressWindow, {
      text: getString('progress-item-counter', { args: { current: currentIndex + 1, total: totalItems } }),
      progress: percent,
      idx: PROGRESS_LINE_STATUS,
    })
    safeChangeLine(progressWindow, {
      text: getString('progress-step-preparing'),
      type: 'default',
      idx: PROGRESS_LINE_STEP,
    })
  }

  // Report each lookup step into the progress window's second line
  const onStep: StepReporter | undefined =
    silent || !progressWindow
      ? undefined
      : (text: string) => {
          if (runToken !== manualRunToken) return
          safeChangeLine(progressWindow, { text, idx: PROGRESS_LINE_STEP })
        }

  // Process current item
  void updateItem(item, operations, silent, false, true, onStep, runToken) // Manual updates don't respect unlisted cache
}

/**
 * Update a single item's citation count
 * @param item Zotero item to update
 * @param operation Citation source to use
 * @param isAutoUpdate Whether this is called from auto-update (to respect unlisted cache)
 * @param advanceQueue Whether to advance the shared manual-update queue after this
 *   item. Callers that drive their own queue (auto-update) must pass false, otherwise
 *   they would silently process leftovers of the last manual run.
 * @param onStep Optional callback receiving a localized description of the current
 *   lookup step (e.g. which database is queried or rate-limit waited on).
 * @param runToken Token of the manual run that queued this item (see manualRunToken).
 *   Defaults are only used by callers that drive their own queue.
 */
async function updateItem(
  item: Zotero.Item,
  operations?: string[] | string,
  silent: boolean = false,
  isAutoUpdate: boolean = false,
  advanceQueue: boolean = true,
  onStep?: StepReporter,
  runToken: number = manualRunToken,
): Promise<UpdateOutcome> {
  const outcome: UpdateOutcome = { success: false, wrote: false, transient: false, statuses: {} }

  try {
    if (!addon.data.alive) return outcome
    ztoolkit.log('Citation debug - Updating item:', item.id, 'title:', item.getField('title'))

    const databases = Helpers.getDatabaseArray(operations)
    if (databases.length === 0) {
      ztoolkit.log('Citation debug - No databases configured, skipping item:', item.id)
      return outcome
    }

    const data: CountArray = []
    for (const operation of databases) {
      // Manual updates bypass the backoff; automatic updates respect it.
      if (isAutoUpdate && IgnoredItemsStore.isBlocked(item.id, operation)) {
        outcome.statuses[operation] = 'not_found'
        ztoolkit.log(`Citation debug - Skipping ${operation} for item ${item.id} (backoff active)`)
        continue
      }

      let result: LookupResult
      // Announce the lookup before dispatching: some databases return early
      // (e.g. missing identifier), and the step line should still name them.
      onStep?.(queryStepText(operation))
      const lookupStart = Date.now()
      if (operation === 'crossref') {
        result = await DBInterface.getCrossrefCountEnhanced(item, onStep)
      } else if (operation === 'inspire') {
        result = await DBInterface.getInspireCountEnhanced(item, onStep)
      } else if (operation === 'semanticscholar') {
        result = await DBInterface.getSemanticScholarCountEnhanced(item, onStep)
      } else if (operation === 'openalex') {
        result = await DBInterface.getOpenAlexCountEnhanced(item, onStep)
      } else {
        continue
      }
      outcome.statuses[operation] = result.status
      const took = Date.now() - lookupStart
      ztoolkit.log(`Citation timing - ${operation} lookup for item ${item.id} took ${took}ms (${result.status})`)

      if (result.status === 'success' && result.count >= 0) {
        IgnoredItemsStore.clear(item.id, operation)
        data.push({
          title: DATABASE_STORAGE_NAMES[operation as DatabaseId] || operation,
          count: result.count,
          fwci: result.fwci,
        })
        outcome.success = true
      } else if (result.status === 'not_found') {
        // Only a confirmed 404, and only from automatic runs, may increase the
        // persistent backoff. Manual checks must not make future auto-updates
        // slower, and transient failures must not be remembered as 404s.
        if (isAutoUpdate) {
          IgnoredItemsStore.markNotFound(item.id, operation)
        }
      } else if (result.status === 'rate_limited' || result.status === 'api_error') {
        outcome.transient = true
        ztoolkit.log(`Citation debug - ${operation} temporary failure for item ${item.id}: ${result.message}`)
      } else if (result.status === 'no_identifier') {
        ztoolkit.log(`Citation debug - ${operation} has no applicable identifier for item ${item.id}`)
      }
    }

    if (data.length > 0) {
      const saveStart = Date.now()
      outcome.wrote = await Core.setCitationCount(item, data, onStep)
      ztoolkit.log(
        `Citation timing - saving item ${item.id} took ${Date.now() - saveStart}ms (wrote: ${outcome.wrote})`,
      )
      // Only count real writes for the manual summary; a no-op means today's
      // entries were already there. Ignore results from a superseded run.
      if (outcome.wrote && !isAutoUpdate && runToken === manualRunToken) updatedCount++
    } else {
      ztoolkit.log('Citation debug - No valid count retrieved, skipping update')
    }
  } catch (e) {
    ztoolkit.log('Error updating citation count for item', e)
    outcome.transient = true
  } finally {
    // Process next item in the manual queue
    if (advanceQueue) {
      void updateNextItem(operations, silent, runToken)
    }
  }

  return outcome
}

class BasicRegistrar {
  static async registerPrefs(): Promise<void> {
    try {
      await Zotero.PreferencePanes.register({
        pluginID: addon.data.config.addonID,
        src: rootURI + 'content/preferences.xhtml',
        label: getString('prefs-title'),
        image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      })
    } catch (e) {
      ztoolkit.log('Failed to register preference pane:', e)
    }
  }
}

// MenuManager registrations are global, not per window. Registering the same
// menu IDs again for every window throws on some Zotero versions.
let citationMenuManagerRegistered = false
let retallyMenuManagerRegistered = false

class UIRegistrar {
  /**
   * Register custom column to display citation counts
   */
  static registerCitationColumn() {
    try {
      ztoolkit.log('Citation debug - Registering citation count column')
      Zotero.ItemTreeManager.registerColumn({
        pluginID: addon.data.config.addonID,
        dataKey: 'citationCount',
        label: getString('column-citations'),
        width: '80',
        // staticWidth: true,
        flex: 0,
        zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
        dataProvider: (item: Zotero.Item) => {
          const result = Core.getCitationCountForColumn(item)
          if (!result) {
            return ''
          }
          // Zero-pad the counts so the tree's string-based sort is numeric;
          // renderCell strips the padding for display.
          const counts = result.counts.map((count) => (count === '-' ? count : count.padStart(SORT_PAD_WIDTH, '0')))
          return JSON.stringify({ counts, databases: result.databases })
        },
        // iconPath: 'chrome://zotero/skin/citations.png',
        renderCell(index, data: any, column, isFirstColumn, doc) {
          const span = doc.createElement('span')
          span.className = `cell ${column.className}`
          span.style.textAlign = 'center'

          // Parse JSON data if it's a string
          let parsedData: { counts: string[]; databases: string[] } | null = null
          if (data && typeof data === 'string') {
            try {
              parsedData = JSON.parse(data)
            } catch (e) {
              // Display as text if JSON parsing fails
              span.innerText = data
              return span
            }
          } else if (!data) {
            span.innerText = ''
            return span
          }

          // Create colored spans for each count
          const dataToUse = parsedData || data
          const useColors = getPref('useColors') === 'color' && dataToUse.databases.length > 1
          const databaseColors = getDatabaseColors()
          // Unknown sources must remain readable in both themes; black text is
          // invisible on a dark background.
          const fallbackColor = isLightMode() ? '#000000' : '#ffffff'

          // Strip the zero-padding used for sorting before displaying
          const displayCounts = dataToUse.counts.map((count: string) =>
            count === '-' ? count : String(parseInt(count, 10)),
          )

          displayCounts.forEach((count: string, idx: number) => {
            if (idx > 0) {
              const separator = doc.createElement('span')
              separator.innerText = ' | '
              separator.style.opacity = '0.25'
              span.appendChild(separator)
            }

            const countSpan = doc.createElement('span')
            countSpan.innerText = count
            if (useColors) {
              countSpan.style.color = databaseColors[dataToUse.databases[idx]] || fallbackColor
              countSpan.style.fontWeight = '500'
            }
            span.appendChild(countSpan)
          })

          // Add tooltip with database names
          const tooltip = dataToUse.databases
            .map((db: string, idx: number) => {
              const displayName = getOperationName(db)
              return getString('tooltip-citation-tallies', { args: { displayName, count: displayCounts[idx] } })
            })
            .join(', ')
          span.title = tooltip

          return span
        },
      })
      ztoolkit.log('Citation debug - Column registration complete')
    } catch (e) {
      ztoolkit.log('Failed to register citation column:', e)
    }
  }

  /**
   * Register custom column to display FWCI (Field-Weighted Citation Impact)
   */
  static registerFWCIColumn() {
    try {
      ztoolkit.log('Citation debug - Registering FWCI column')
      Zotero.ItemTreeManager.registerColumn({
        pluginID: addon.data.config.addonID,
        dataKey: 'fwci',
        label: getString('column-fwci'),
        width: '60',
        flex: 0,
        zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
        dataProvider: (item: Zotero.Item) => {
          const value = Core.getFWCIForColumn(item)
          return value === '-' ? '-' : value.padStart(SORT_PAD_WIDTH, '0')
        },
        renderCell(index, data: any, column, isFirstColumn, doc) {
          const span = doc.createElement('span')
          span.className = `cell ${column.className}`
          span.style.textAlign = 'center'
          const num = parseFloat(data)
          span.innerText = data && !isNaN(num) ? num.toFixed(2) : '-'
          return span
        },
      })
      ztoolkit.log('Citation debug - FWCI Column registration complete')
    } catch (e) {
      ztoolkit.log('Failed to register FWCI column:', e)
    }
  }

  /**
   * Register custom column to display average citations per year
   */
  static registerAvgCiteColumn() {
    try {
      ztoolkit.log('Citation debug - Registering AvgCite column')
      Zotero.ItemTreeManager.registerColumn({
        pluginID: addon.data.config.addonID,
        dataKey: 'avgCite',
        label: getString('column-avgcite'),
        width: '60',
        flex: 0,
        zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
        dataProvider: (item: Zotero.Item) => {
          const value = Core.getAvgCiteForColumn(item)
          return value === '-' ? '-' : value.padStart(SORT_PAD_WIDTH, '0')
        },
        renderCell(index, data: any, column, isFirstColumn, doc) {
          const span = doc.createElement('span')
          span.className = `cell ${column.className}`
          span.style.textAlign = 'center'
          const num = parseFloat(data)
          span.innerText = data && !isNaN(num) ? num.toFixed(2) : '-'
          return span
        },
      })
      ztoolkit.log('Citation debug - AvgCite Column registration complete')
    } catch (e) {
      ztoolkit.log('Failed to register AvgCite column:', e)
    }
  }

  /**
   * Register the notifier to detect new items
   */
  static registerNotifier() {
    const notifierID = Zotero.Notifier.registerObserver(notifierCallback, ['item'])

    // Unregister when the addon is disabled/uninstalled
    Zotero.Plugins.addObserver({
      shutdown: ({ id }: { id: string }) => {
        if (id === addon.data.config.addonID) {
          Zotero.Notifier.unregisterObserver(notifierID)
        }
      },
    })
  }

  /**
   * Register observers for theme changes to update column colors
   */
  static registerThemeObservers() {
    registerThemeObservers()
  }

  /**
   * Unregister theme observers (call on shutdown)
   */
  static unregisterThemeObservers() {
    unregisterThemeObservers()
  }

  /**
   * Register context menu items to update citation counts for selected items.
   * Uses MenuManager on Zotero 8+, falls back to DOM injection on Zotero 7.
   */
  static registerCitationCountMenuItem() {
    // Zotero 8+/9 path: use MenuManager API
    if ((Zotero as any).MenuManager?.registerMenu) {
      if (citationMenuManagerRegistered) return
      const showWhen = () => {
        try {
          const zoteroPane = Zotero.getActiveZoteroPane()
          if (!zoteroPane) return false
          const selectedItems = zoteroPane.getSelectedItems()
          if (!selectedItems || selectedItems.length === 0) return false
          return selectedItems.some((item: Zotero.Item) => item.isRegularItem())
        } catch {
          return false
        }
      }

      // MenuManager's onShowing cannot control visibility via its return value;
      // visibility must be set on the context passed to the handler.
      const onShowing = (_event: unknown, context: any) => {
        context?.setVisible?.(showWhen())
      }

      ;(Zotero as any).MenuManager.registerMenu({
        menuID: `${addon.data.config.addonID}-update-citations`,
        pluginID: addon.data.config.addonID,
        target: 'main/library/item',
        menus: [
          {
            menuType: 'menuitem',
            l10nID: getLocaleID('menuitem-update-citation-tallies'),
            icon: 'chrome://zotero/skin/toolbar-advanced-search.png',
            onShowing,
            onCommand: () => addon.hooks.onDialogEvents('updateCitationCounts'),
          },
        ],
      })

      const sources = [
        { key: 'crossref', l10nSuffix: 'crossref' },
        { key: 'inspire', l10nSuffix: 'inspire' },
        { key: 'semanticscholar', l10nSuffix: 'semanticscholar' },
        { key: 'openalex', l10nSuffix: 'openalex' },
      ]

      for (const source of sources) {
        ;(Zotero as any).MenuManager.registerMenu({
          menuID: `${addon.data.config.addonID}-update-citations-${source.key}`,
          pluginID: addon.data.config.addonID,
          target: 'main/library/item',
          menus: [
            {
              menuType: 'menuitem',
              l10nID: getLocaleID(`menuitem-update-${source.l10nSuffix}`),
              onShowing,
              onCommand: () => addon.hooks.onDialogEvents(`updateCitationCounts-${source.key}`),
            },
          ],
        })
      }

      // Average citations per year (locally computed)
      ;(Zotero as any).MenuManager.registerMenu({
        menuID: `${addon.data.config.addonID}-update-avgcite`,
        pluginID: addon.data.config.addonID,
        target: 'main/library/item',
        menus: [
          {
            menuType: 'menuitem',
            l10nID: getLocaleID('menuitem-update-avgcite'),
            onShowing,
            onCommand: () => addon.hooks.onDialogEvents('updateCitationCounts-avgcite'),
          },
        ],
      })
      // Only mark the group as registered after every menu was accepted, so a
      // failure in one call can be retried the next time a window loads.
      citationMenuManagerRegistered = true
      return
    }

    // Zotero 7 fallback: inject menuitems into the item context menu via DOM
    for (const win of Zotero.getMainWindows()) {
      const doc = win.document
      const itemMenu = doc.getElementById('zotero-itemmenu')
      if (!itemMenu || UIRegistrar.isZotero7MenuInjected(itemMenu)) continue

      // Create separator
      const sep = doc.createXULElement?.('menuseparator') || doc.createElement('menuseparator')
      itemMenu.appendChild(sep)

      // "Update Citation Tallies" (all sources)
      const menuAll = UIRegistrar._createZotero7MenuItem(doc, 'menuitem-update-citation-tallies', () => {
        addon.hooks.onDialogEvents('updateCitationCounts')
      })
      itemMenu.appendChild(menuAll)

      // Per-source items
      const sourceDefs = [
        { key: 'crossref', l10n: 'menuitem-update-crossref' },
        { key: 'inspire', l10n: 'menuitem-update-inspire' },
        { key: 'semanticscholar', l10n: 'menuitem-update-semanticscholar' },
        { key: 'openalex', l10n: 'menuitem-update-openalex' },
      ]
      const injected: Element[] = [sep, menuAll]
      for (const src of sourceDefs) {
        const menuItem = UIRegistrar._createZotero7MenuItem(doc, src.l10n, () => {
          addon.hooks.onDialogEvents(`updateCitationCounts-${src.key}`)
        })
        itemMenu.appendChild(menuItem)
        injected.push(menuItem)
      }

      // Average citations per year (locally computed)
      const menuAvgCite = UIRegistrar._createZotero7MenuItem(doc, 'menuitem-update-avgcite', () => {
        addon.hooks.onDialogEvents('updateCitationCounts-avgcite')
      })
      itemMenu.appendChild(menuAvgCite)
      injected.push(menuAvgCite)

      UIRegistrar.markZotero7MenuInjected(...injected)
    }
  }

  /**
   * Helper: create a localized menuitem for Zotero 7 DOM injection
   */
  static _createZotero7MenuItem(doc: Document, l10nId: string, onCommand: () => void): Element {
    const item = doc.createXULElement?.('menuitem') || doc.createElement('menuitem')
    item.setAttribute('data-l10n-id', getLocaleID(l10nId))
    item.addEventListener('command', onCommand)
    return item
  }

  /**
   * Register a menubar item to retally outdated item citations.
   * Uses MenuManager on Zotero 8+, falls back to DOM injection on Zotero 7.
   */
  static registerRetallyCitationsMenuItem() {
    // Zotero 8+/9 path: use MenuManager API
    if ((Zotero as any).MenuManager?.registerMenu) {
      if (retallyMenuManagerRegistered) return
      ;(Zotero as any).MenuManager.registerMenu({
        menuID: `${addon.data.config.addonID}-retally-citations`,
        pluginID: addon.data.config.addonID,
        target: 'main/menubar/tools',
        menus: [
          {
            menuType: 'menuitem',
            l10nID: getLocaleID('menuitem-retally-outdated-citations'),
            onCommand: () => addon.hooks.onDialogEvents('retallyOutdatedCitations'),
          },
        ],
      })
      retallyMenuManagerRegistered = true
      return
    }

    // Zotero 7 fallback: inject into the Tools menubar popup via DOM
    for (const win of Zotero.getMainWindows()) {
      const doc = win.document
      const toolsPopup = doc.getElementById('menu_ToolsPopup')
      if (!toolsPopup) {
        ztoolkit.log('Tools menupopup not found; retally menu item not registered')
        continue
      }
      if (UIRegistrar.isZotero7MenuInjected(toolsPopup)) continue

      const menuItem = UIRegistrar._createZotero7MenuItem(doc, 'menuitem-retally-outdated-citations', () => {
        addon.hooks.onDialogEvents('retallyOutdatedCitations')
      })
      toolsPopup.appendChild(menuItem)
      UIRegistrar.markZotero7MenuInjected(menuItem)
    }
  }

  /**
   * Attribute marking menu items injected into Zotero 7 menus by this plugin,
   * so they can be found again for duplicate prevention and cleanup.
   */
  private static get zotero7InjectedAttr(): string {
    return `data-${addon.data.config.addonRef}-injected`
  }

  private static isZotero7MenuInjected(container: Element): boolean {
    return !!container.querySelector(`[${UIRegistrar.zotero7InjectedAttr}]`)
  }

  private static markZotero7MenuInjected(...elements: Element[]): void {
    for (const element of elements) {
      element.setAttribute(UIRegistrar.zotero7InjectedAttr, 'true')
    }
  }

  /**
   * Remove menu items injected into Zotero 7 menus (the MenuManager path is
   * cleaned up by Zotero itself). Call on window unload and plugin shutdown.
   */
  static unregisterZotero7Menus(win?: Window): void {
    // On window unload only this window's DOM exists; cleaning every window
    // would remove the menus from windows that are still open.
    const windows = win ? [win] : Zotero.getMainWindows()
    for (const target of windows) {
      target.document
        .querySelectorAll(`[${UIRegistrar.zotero7InjectedAttr}]`)
        .forEach((element: Element) => element.remove())
    }
  }
}

class UX {
  /**
   * Update citation counts for all selected items
   */
  static updateSelectedItemsCitationCounts(operations?: string) {
    // Get selected items
    const items = Zotero.getActiveZoteroPane().getSelectedItems()

    // // Log diagnostic info about the selected items
    // ztoolkit.log('Citation debug - Selected items count:', items.length)
    // for (const item of items) {
    //   ztoolkit.log('Citation debug - Selected item ID:', item.id, 'Type:', item.itemType)

    //   // Check Extra field content
    //   const extra = item.getField('extra')
    //   ztoolkit.log('Citation debug - Extra field content:', extra)

    //   // Check for the DCounts field mentioned in the error
    //   try {
    //     // Attempt to access raw item data to debug the "DCounts" field
    //     const itemData = item.toJSON()
    //     ztoolkit.log('Citation debug - Item JSON data:', JSON.stringify(itemData).substring(0, 500))

    //     // Check for custom fields/properties
    //     ztoolkit.log('Citation debug - Item field names:', Object.getOwnPropertyNames(item))

    //     // Check if this is a library item
    //     const libraryID = item.libraryID
    //     ztoolkit.log('Citation debug - Item library ID:', libraryID)

    //     // Check if the item has a DOI
    //     const doi = item.getField('DOI')
    //     ztoolkit.log('Citation debug - Item DOI:', doi)
    //   } catch (error) {
    //     ztoolkit.log('Citation debug - Error inspecting selected item:', error)
    //   }
    // }

    // Filter for regular items
    // const regularItems = items.filter((item) => item.isRegularItem())
    // ztoolkit.log('Citation debug - Regular items count:', regularItems.length)

    // if (regularItems.length === 0) {
    //   // Show message if no regular items are selected
    //   new ztoolkit.ProgressWindow('Citation Counts', {
    //     closeOnClick: true,
    //   })
    //     .createLine({
    //       text: 'No valid items selected for citation count update.',
    //       type: 'error',
    //     })
    //     .show()
    //     .startCloseTimer(3000)
    //   return
    // }

    // Update citation counts for selected items using the existing function

    // new ztoolkit.ProgressWindow('DEBUG', {
    //   closeOnClick: true,
    // })
    //   .createLine({
    //     text: getPref('databaseOrder'),
    //     type: 'error',
    //   })
    //   .show()
    //   .startCloseTimer(3000)
    // return

    updateItems(items, operations)
  }

  /**
   * Compute and store average citations per year for all selected items.
   * This is a locally computed metric — no API calls needed.
   */
  static async updateSelectedItemsAvgCite() {
    const items = Zotero.getActiveZoteroPane().getSelectedItems()
    const regularItems = items.filter((item) => item.isRegularItem())

    if (regularItems.length === 0) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString('progress-no-valid-items'),
          type: 'error',
        })
        .show()
        .startCloseTimer(3000)
      return
    }

    // Local computation with no API calls. Two phases so the step line reflects
    // reality instead of being dominated by per-item transactions:
    //   1. read + compute every item (fast, no I/O)
    //   2. write the pending entries in short committed chunks
    const progressWindow = createStepProgressWindow(
      getString('progress-getting-avgcite'),
      getString('progress-step-preparing'),
    )

    const pending: { item: Zotero.Item; entry: string }[] = []

    // The run has two phases; split the bar between them so it keeps moving
    // during the write phase instead of sitting at 100%.
    const COMPUTE_PHASE_SHARE = 50

    for (let i = 0; i < regularItems.length; i++) {
      const item = regularItems[i]
      const percent = Math.round((i / regularItems.length) * COMPUTE_PHASE_SHARE)
      safeChangeLine(progressWindow, {
        text: getString('progress-item-counter', { args: { current: i + 1, total: regularItems.length } }),
        progress: percent,
        idx: PROGRESS_LINE_STATUS,
      })
      safeChangeLine(progressWindow, {
        text: getString('progress-step-avgcite-reading'),
        type: 'default',
        idx: PROGRESS_LINE_STEP,
      })
      // Let the window actually paint this item's lines before doing the work.
      await yieldToUI()

      const entry = Core.computeAvgCiteEntry(item)
      if (entry) pending.push({ item, entry })
    }

    let updatedCount = 0
    if (pending.length > 0) {
      // The compute loop is over, so the status line would otherwise stay frozen
      // at "item N of N" for the whole write phase. Show write progress instead.
      safeChangeLine(progressWindow, {
        text: getString('progress-saving-counter', { args: { current: 0, total: pending.length } }),
        progress: COMPUTE_PHASE_SHARE,
        idx: PROGRESS_LINE_STATUS,
      })
      safeChangeLine(progressWindow, {
        text: getString('progress-step-saving'),
        type: 'default',
        idx: PROGRESS_LINE_STEP,
      })
      // Paint the save label before the first write burst.
      await yieldToUI()

      // Write in chunks, one transaction each. All writes must NOT be done in a
      // single transaction: inside one transaction the awaits resolve as
      // microtasks, so the UI never repaints and the counter appears stuck at 0.
      // Committing per chunk also keeps transactions short.
      let committed = 0
      try {
        for (let offset = 0; offset < pending.length; offset += SAVE_CHUNK_SIZE) {
          const chunk = pending.slice(offset, offset + SAVE_CHUNK_SIZE)
          await withExtraWriteLock(() =>
            Zotero.DB.executeTransaction(async () => {
              for (const { item, entry } of chunk) {
                await Core.storeAvgCiteEntry(item, entry)
              }
            }),
          )
          committed += chunk.length
          safeChangeLine(progressWindow, {
            text: getString('progress-saving-counter', { args: { current: committed, total: pending.length } }),
            progress: COMPUTE_PHASE_SHARE + Math.round((committed / pending.length) * (100 - COMPUTE_PHASE_SHARE)),
            idx: PROGRESS_LINE_STATUS,
          })
          // Yield a macrotask so the counter above actually becomes visible.
          await yieldToUI()
        }
        updatedCount = pending.length
      } catch (e) {
        ztoolkit.log('AvgCite debug - Batch save failed:', e)
        // Already-committed chunks stay saved; reload the rest so their in-memory
        // Extra text matches the database again.
        for (const { item } of pending.slice(committed)) {
          try {
            await item.reload([], true)
          } catch (reloadError) {
            ztoolkit.log('AvgCite debug - Failed to reload item:', item.id, reloadError)
          }
        }
        updatedCount = committed
      }
    }

    try {
      progressWindow.close()
    } catch (e) {
      ztoolkit.log('Failed to close progress window:', e)
    }

    const successWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 4000,
    })
    successWindow.createLine({
      text: getString('progress-avgcite-updated', { args: { count: updatedCount } }),
      type: 'success',
      progress: 100,
    })
    successWindow.show()
  }
}

// Export functions needed by autoupdate module
export type { StepReporter }
export {
  DBInterface,
  Core,
  Helpers,
  UIRegistrar,
  BasicRegistrar,
  UX,
  updateItem,
  safeChangeLine,
  scheduleMonthlyCleanup,
  stopMonthlyCleanup,
}
