import { getLocaleID, getString } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'

// Default rate limits per database (in milliseconds)
const DEFAULT_RATE_LIMITS: Record<string, number> = {
  crossref: 1000,
  inspire: 1000,
  semanticscholar: 3000,
  openalex: 1000,
}

const MAX_RATE_LIMIT_MULTIPLIER = 10

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

  static async waitForRateLimit(database: string): Promise<void> {
    const delay = this.getDelay(database)
    const lastRequest = this.lastRequestTime[database] || 0
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequest

    if (timeSinceLastRequest < delay) {
      const waitTime = delay - timeSinceLastRequest
      ztoolkit.log(`Rate limiting ${database}: waiting ${waitTime}ms (${this.multipliers[database] || 1}x multiplier)`)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    this.lastRequestTime[database] = Date.now()
  }
}

// Citation source operations

// Ignored items tracking
type IgnoredItemsData = Record<
  string, // Database ID
  Record<
    string, // Item ID
    {
      count: number // Number of times that the database returned "not_found" for the item
      lastChecked: string // ISO date of last check
    }
  >
>

interface LookupResult {
  count: number
  status: 'success' | 'not_found' | 'api_error' | 'no_identifier' | 'rate_limited'
  message?: string
  fwci?: number // Field-Weighted Citation Impact (OpenAlex)
}

class IgnoredItemsManager {
  private static memoryCache = new Map<number, { databases: string[] }>() // Session-only cache for no_identifier
  private static loaded = false

  private static loadPersistentData(): IgnoredItemsData {
    if (!this.loaded) {
      this.loaded = true
    }
    const data = getPref('ignoredItems')
    return data ? JSON.parse(data) : {}
  }

  private static savePersistentData(data: IgnoredItemsData): void {
    setPref('ignoredItems', JSON.stringify(data))
  }

  private static shouldRetryItem(count: number, lastChecked: string): boolean {
    const now = new Date()
    const lastCheck = new Date(lastChecked)
    const timeDiff = now.getTime() - lastCheck.getTime()
    const daysDiff = timeDiff / (1000 * 3600 * 24)

    if (count === 1) {
      return daysDiff > 7 // 1 week
    } else if (count === 2) {
      return daysDiff > 30 // 1 month
    } else if (count === 3) {
      return daysDiff > 90 // 3 months
    } else if (count > 3) {
      return daysDiff > 180 // 6 months
    }
    return true // Should retry if count is 0 or unexpected
  }

  static markAsIgnored(
    itemId: number,
    database: string,
    reason: 'not_found' | 'no_identifier' | 'api_error',
    persistent = true,
  ): void {
    if (reason === 'no_identifier') {
      // Store in memory cache only for missing identifiers
      const memoryInfo = this.memoryCache.get(itemId) || { databases: [] }
      if (!memoryInfo.databases.includes(database)) {
        memoryInfo.databases.push(database)
      }
      this.memoryCache.set(itemId, memoryInfo)
      return
    }

    // Track 'not_found' and 'api_error' status persistently
    if (persistent && (reason === 'not_found' || reason === 'api_error')) {
      const data = this.loadPersistentData()
      const itemKey = itemId.toString()

      // Initialize database if not exists
      if (!data[database]) {
        data[database] = {}
      }

      // Initialize or update item data
      if (!data[database][itemKey]) {
        data[database][itemKey] = {
          count: 1,
          lastChecked: new Date().toISOString(),
        }
      } else {
        data[database][itemKey].count++
        data[database][itemKey].lastChecked = new Date().toISOString()
      }

      this.savePersistentData(data)
    }
  }

  static isIgnored(itemId: number, database: string, autoUpdateOnly = false): boolean {
    // If this is manual update, never skip
    if (!autoUpdateOnly) {
      return false
    }

    // Check memory cache first (for no_identifier items)
    if (this.memoryCache.has(itemId)) {
      return this.memoryCache.get(itemId)!.databases.includes(database)
    }

    // Check persistent storage for not_found items
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (data[database]?.[itemKey]) {
      const itemData = data[database][itemKey]
      // Check if enough time has passed to retry based on failure count
      return !this.shouldRetryItem(itemData.count, itemData.lastChecked)
    }

    return false
  }

  static clearIgnoredItem(itemId: number, database?: string): void {
    // Clear from memory cache
    if (database) {
      const memoryInfo = this.memoryCache.get(itemId)
      if (memoryInfo) {
        memoryInfo.databases = memoryInfo.databases.filter((db) => db !== database)
        if (memoryInfo.databases.length === 0) {
          this.memoryCache.delete(itemId)
        }
      }
    } else {
      this.memoryCache.delete(itemId)
    }

    // Clear from persistent storage
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (database) {
      // Clear specific database-item combination
      if (data[database]?.[itemKey]) {
        delete data[database][itemKey]
        // Clean up empty database objects
        if (Object.keys(data[database]).length === 0) {
          delete data[database]
        }
        this.savePersistentData(data)
      }
    } else {
      // Clear item from all databases
      let modified = false
      for (const dbKey of Object.keys(data)) {
        if (data[dbKey][itemKey]) {
          delete data[dbKey][itemKey]
          modified = true
          // Clean up empty database objects
          if (Object.keys(data[dbKey]).length === 0) {
            delete data[dbKey]
          }
        }
      }
      if (modified) {
        this.savePersistentData(data)
      }
    }
  }

  static cleanupNonExistentItems(): void {
    const data = this.loadPersistentData()
    let modified = false

    for (const database of Object.keys(data)) {
      for (const itemKey of Object.keys(data[database])) {
        const itemId = parseInt(itemKey)
        try {
          const item = Zotero.Items.get(itemId)
          if (!item || item.deleted) {
            delete data[database][itemKey]
            modified = true
          }
        } catch (e) {
          // Item doesn't exist, remove it
          delete data[database][itemKey]
          modified = true
        }
      }

      // Clean up empty database objects
      if (Object.keys(data[database]).length === 0) {
        delete data[database]
        modified = true
      }
    }

    if (modified) {
      this.savePersistentData(data)
      ztoolkit.log('Citation debug - Cleaned up ignored items for non-existent library items')
    }
  }
}

// Schedule monthly cleanup
let cleanupTimer: NodeJS.Timeout | null = null

function scheduleMonthlyCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
  }

  // Run cleanup every 30 days (30 * 24 * 60 * 60 * 1000 ms)
  cleanupTimer = setInterval(
    () => {
      void IgnoredItemsManager.cleanupNonExistentItems()
    },
    30 * 24 * 60 * 60 * 1000,
  )

  // Also run cleanup on startup
  setTimeout(() => {
    void IgnoredItemsManager.cleanupNonExistentItems()
  }, 5000) // Delay 5 seconds after startup
}

// Operation display names (lazy-loaded to avoid startup issues)
function getOperationName(key: string): string {
  const nameMap = {
    crossref: 'database-crossref',
    inspire: 'database-inspire',
    semanticscholar: 'database-semanticscholar',
    openalex: 'database-openalex',
  } as const
  const fluentId = nameMap[key as keyof typeof nameMap]
  return fluentId ? getString(fluentId) : key
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
    // Try Zotero's theme preference first (Zotero 7+)
    const zoteroTheme = Zotero.Prefs.get('theme', true) as string | undefined

    if (zoteroTheme === 'light') {
      return true
    }
    if (zoteroTheme === 'dark') {
      return false
    }

    // If theme is 'system' or undefined, check system preference
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

// Store references for cleanup
let themeMediaQueryList: MediaQueryList | null = null
let themePrefObserverId: symbol | null = null
let colorPrefObserverId: symbol | null = null

/**
 * Register observers for theme and color preference changes
 * Listens to Zotero's theme preference, system theme, and plugin color preference
 */
function registerThemeObservers(): void {
  try {
    // Observe Zotero's theme preference changes
    themePrefObserverId = Zotero.Prefs.registerObserver(
      'theme',
      () => {
        ztoolkit.log('Zotero theme preference changed')
        refreshItemsTree()
      },
      true,
    )

    // Observe plugin's useColors preference changes (need full pref name)
    colorPrefObserverId = Zotero.Prefs.registerObserver(
      `${addon.data.config.prefsPrefix}.useColors`,
      () => {
        ztoolkit.log('Plugin color preference changed')
        refreshItemsTree()
      },
      true,
    )

    // Observe system theme changes via matchMedia
    const win = Zotero.getMainWindow()
    if (win?.matchMedia) {
      const mql = win.matchMedia('(prefers-color-scheme: dark)')
      if (mql) {
        themeMediaQueryList = mql
        mql.addEventListener('change', () => {
          ztoolkit.log('System theme changed')
          refreshItemsTree()
        })
      }
    }

    ztoolkit.log('Theme and color observers registered')
  } catch (e) {
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
    // MediaQueryList listeners are automatically cleaned up when the window closes
    themeMediaQueryList = null
    ztoolkit.log('Theme observers unregistered')
  } catch (e) {
    ztoolkit.log(`Failed to unregister theme observers: ${String(e)}`)
  }
}

function insertBeforeMatch(arr: string[], pattern: RegExp, newItem: string): void {
  const index = arr.findIndex((item) => pattern.test(item))
  if (index !== -1) {
    arr.splice(index, 0, newItem)
  } else {
    arr.push(newItem) // If no match, append at the end
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

class Helpers {
  /**
   * Get all possible identifiers from item (for fallback when primary fails)
   * @param item Zotero item
   * @returns Array of objects with type and id, ordered by preference
   */
  static getAllItemIdentifiers(item: Zotero.Item): { type: string; id: string; source: string }[] {
    const identifiers: { type: string; id: string; source: string }[] = []

    // Regex for extracting arXiv IDs from text fields (handles "arXiv:0803.3042" or "0803.3042")
    const arXivIdRegex = /(?:arXiv:\s*)?([a-z-]+\/\d+|\d+\.\d+)/i

    // Regex for extracting arXiv IDs from URLs (handles "http://arxiv.org/abs/0803.3042")
    const arXivUrlRegex = /arxiv\.org\/abs\/([a-z-]+\/\d+|\d+\.\d+)/i

    // Check DOI field first (highest priority)
    const doi = item.getField('DOI')
    if (doi) {
      identifiers.push({ type: 'doi', id: doi, source: 'DOI' })
    }

    // Check archiveID field (primary field for preprint identifiers)
    const archiveID = item.getField('archiveID')
    if (archiveID) {
      const arXivMatch = arXivIdRegex.exec(archiveID)
      if (arXivMatch) {
        identifiers.push({ type: 'arxiv', id: arXivMatch[1], source: 'archiveID' })
      }
    }

    // Check reportNumber field (often used for arXiv IDs)
    const reportNumber = item.getField('reportNumber')
    if (reportNumber) {
      const arXivMatch = arXivIdRegex.exec(reportNumber)
      if (arXivMatch) {
        identifiers.push({ type: 'arxiv', id: arXivMatch[1], source: 'reportNumber' })
      }
    }

    // Check for arXiv ID in Extra field
    const extra = item.getField('extra')
    if (extra) {
      const arXivMatch = arXivIdRegex.exec(extra)
      if (arXivMatch) {
        identifiers.push({ type: 'arxiv', id: arXivMatch[1], source: 'extra' })
      }
    }

    // Check URL field for arXiv URLs
    const url = item.getField('url')
    if (url) {
      const urlArXivMatch = arXivUrlRegex.exec(url)
      if (urlArXivMatch) {
        identifiers.push({ type: 'arxiv', id: urlArXivMatch[1], source: 'url' })
      }
    }

    // Check callNumber field (sometimes used for archive identifiers)
    const callNumber = item.getField('callNumber')
    if (callNumber) {
      const arXivMatch = arXivIdRegex.exec(callNumber)
      if (arXivMatch) {
        identifiers.push({ type: 'arxiv', id: arXivMatch[1], source: 'callNumber' })
      }
    }

    return identifiers
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
    const databaseArray = databaseOrder.split(',').map((db: string) => db.trim())
    if (databaseArray.length === 0) {
      ztoolkit.log('Citation debug - No databases configured in preferences')
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

class Core {
  /**
   * Store citation count in the Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @param count Citation count number
   */
  static async setCitationCount(item: Zotero.Item, data: CountArray) {
    let extra = item.getField('extra')
    if (!extra) {
      extra = ''
    }

    ztoolkit.log('Citation debug - Setting citation count for item:', item.id, 'count:', data)
    ztoolkit.log('Citation debug - Original Extra field:', extra)

    const extras = extra.split('\n')

    // Format date
    const today = new Date()
    const dd = String(today.getDate()).padStart(2, '0')
    const mm = String(today.getMonth() + 1).padStart(2, '0') // January is 0!
    const yyyy = today.getFullYear()
    const date = `${yyyy}-${mm}-${dd}`

    let modified = false

    // Append-only: never remove existing lines, only skip exact duplicates
    for (const { title, count, fwci } of data) {
      const newEntry = `Citations: ${count} (${title}) [${date}]` ///REGEXP

      if (!extras.includes(newEntry)) {
        // Insert at the top of the Extra field
        extras.unshift(newEntry)
        modified = true
        ztoolkit.log('Citation debug - Prepended entry:', newEntry)
      } else {
        ztoolkit.log('Citation debug - Skipping exact duplicate:', newEntry)
      }

      // Store FWCI if available (OpenAlex-specific)
      if (fwci !== undefined && fwci !== null && !isNaN(fwci)) {
        const fwciEntry = `FWCI: ${Number(fwci).toFixed(2)} (${title}) [${date}]` ///REGEXP
        if (!extras.includes(fwciEntry)) {
          // Insert at the top of the Extra field
          extras.unshift(fwciEntry)
          modified = true
          ztoolkit.log('Citation debug - Prepended FWCI entry:', fwciEntry)
        } else {
          ztoolkit.log('Citation debug - Skipping exact duplicate FWCI:', fwciEntry)
        }
      }
    }

    if (modified) {
      const newExtra = extras.join('\n')
      item.setField('extra', newExtra)
      await item.saveTx()
      ztoolkit.log('Citation debug - Updated Extra field')
    }
  }

  /**
   * Extract citation count from the Extra field for display in custom column
   * @param item Zotero item
   * @returns Object with counts and databases for rendering
   */
  static getCitationCountForColumn(item: Zotero.Item): { counts: string[]; databases: string[] } | null {
    // Get user's preferred database order
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const operationsIncluded = databaseOrder.split(',').map((db: string) => db.trim())

    const extra = item.getField('extra')
    if (!extra) {
      return null
    }

    const extras = extra.split('\n')

    // For each source, find the entry with the most recent date
    const latestCounts: Record<string, { count: number; date: string }> = {}

    for (const tag of operationsIncluded) {
      const tagName = getOperationName(tag)
      const escapedTag = escapeRegex(tagName)

      // Pattern 1: Current format "Citations: N (SourceName) [YYYY-MM-DD]"
      const pattNew = new RegExp(
        `^Citations: *(\\d+) *\\(${escapedTag}\\) *\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\]`, 'i'
      )
      // Pattern 2: Current format without date "Citations: N (SourceName)"
      const pattNewNoDate = new RegExp(
        `^Citations: *(\\d+) *\\(${escapedTag}\\)`, 'i'
      )
      // Pattern 3: Old format "N citations (SourceName/IDType) [YYYY-MM-DD]"
      const pattOld = new RegExp(
        `^(\\d+) citations \\(${escapedTag}(?:\\/\\w+)?\\) *(?:\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\])?`, 'i'
      )
      // Pattern 4: Very old format "Citations (SourceName): N"
      const pattVeryOld = new RegExp(
        `^Citations \\(${escapedTag}\\): *(\\d+)`, 'i'
      )

      for (const line of extras) {
        let count: number | null = null
        let dateStr: string | null = null

        let match = pattNew.exec(line)
        if (match) {
          count = parseInt(match[1])
          dateStr = match[2] || null
        }
        if (count === null) {
          match = pattNewNoDate.exec(line)
          if (match) {
            count = parseInt(match[1])
            dateStr = null
          }
        }
        if (count === null) {
          match = pattOld.exec(line)
          if (match) {
            count = parseInt(match[1])
            dateStr = match[2] || null
          }
        }
        if (count === null) {
          match = pattVeryOld.exec(line)
          if (match) {
            count = parseInt(match[1])
            dateStr = null
          }
        }

        if (count !== null) {
          if (!latestCounts[tag] || (dateStr && (!latestCounts[tag].date || dateStr > latestCounts[tag].date))) {
            latestCounts[tag] = { count, date: dateStr || '' }
          }
        }
      }
    }

    // Format output
    const counts: string[] = []
    const databases: string[] = []

    for (const tag of operationsIncluded) {
      const entry = latestCounts[tag]
      counts.push(entry ? entry.count.toString() : '-')
      databases.push(tag)
    }

    // Only return if at least one count was found
    const hasAnyCount = counts.some((count) => count !== '-')
    return hasAnyCount ? { counts, databases } : null
  }

  /**
   * Extract FWCI from Extra field for display in custom column
   * @param item Zotero item
   * @returns FWCI string or '-' if not found
   */
  static getFWCIForColumn(item: Zotero.Item): string {
    // Scan ALL known sources, not just configured ones — FWCI data may exist
    // from previous plugins (e.g. zotero-cc) regardless of current settings
    const allSources = ['crossref', 'inspire', 'semanticscholar', 'openalex']

    const extra = item.getField('extra')
    if (!extra) return '-'

    const extras = extra.split('\n')
    let bestFwci: number | null = null
    let bestDate: string | null = null

    for (const tag of allSources) {
      const tagName = getOperationName(tag)
      const escapedTag = escapeRegex(tagName)

      // Current format: "FWCI: N.NN (SourceName) [YYYY-MM-DD]"
      const pattNew = new RegExp(
        `^FWCI: *(\\d+\\.?\\d*) *\\(${escapedTag}\\) *\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\]`, 'i'
      )
      // Without date: "FWCI: N.NN (SourceName)"
      const pattNoDate = new RegExp(
        `^FWCI: *(\\d+\\.?\\d*) *\\(${escapedTag}\\)`, 'i'
      )
      // Old zotero-cc format: "FWCI: N.NN (SourceName/IDType) [YYYY-MM-DD]"
      const pattOld = new RegExp(
        `^FWCI: *(\\d+\\.?\\d*) *\\(${escapedTag}(?:\\/\\w+)?\\) *(?:\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\])?`, 'i'
      )

      for (const line of extras) {
        let match = pattNew.exec(line)
        let fwciVal: number | null = null
        let dateStr: string | null = null

        if (match) {
          fwciVal = parseFloat(match[1])
          dateStr = match[2] || null
        }
        if (fwciVal === null) {
          match = pattNoDate.exec(line)
          if (match) {
            fwciVal = parseFloat(match[1])
            dateStr = null
          }
        }
        if (fwciVal === null) {
          match = pattOld.exec(line)
          if (match) {
            fwciVal = parseFloat(match[1])
            dateStr = match[2] || null
          }
        }

        if (fwciVal !== null && !isNaN(fwciVal)) {
          if (bestFwci === null || (dateStr && (!bestDate || dateStr > bestDate))) {
            bestFwci = fwciVal
            bestDate = dateStr || null
          }
        }
      }
    }

    return bestFwci !== null ? bestFwci.toFixed(2) : '-'
  }

  /**
   * Extract citation count from Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @returns Citation count or -1 if not found
   */
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
  static async getCrossrefCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (identifier?.type !== 'doi') {
      ztoolkit.log('Citation debug - No DOI found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found' }
    }
    const edoi = encodeURIComponent(identifier.id)
    ztoolkit.log('Citation debug - Encoded DOI:', edoi)

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('crossref')

    let response: any = null

    try {
      const style = 'vnd.citationstyles.csl+json'
      const xform = `transform/application/${style}`
      const url = `https://api.crossref.org/works/${edoi}/${xform}`
      ztoolkit.log('Citation debug - Fetching from Crossref API:', url)

      response = await fetch(url)
        .then((response) => {
          ztoolkit.log('Citation debug - Crossref API response status:', response.status)
          return response.json()
        })
        .catch((error) => {
          ztoolkit.log('Citation debug - Crossref API fetch error:', error)
          return null
        })

      if (response === null) {
        ztoolkit.log('Citation debug - Crossref API failed, trying DOI.org')
        const url = `https://doi.org/${edoi}`
        const doiResponse = await fetch(url, {
          headers: {
            Accept: `application/${style}`,
          },
        })

        if (doiResponse.status === 404) {
          return { count: 0, status: 'not_found', message: 'DOI not found in Crossref' }
        }

        if (doiResponse.status === 429) {
          RateLimitManager.handleRateLimit('crossref')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }

        response = await doiResponse.json().catch((error) => {
          ztoolkit.log('Citation debug - DOI.org fetch error:', error)
          return null
        })
      }

      if (response === null) {
        // Something went wrong
        ztoolkit.log('Citation debug - Both API requests failed')
        return { count: -1, status: 'api_error', message: 'API requests failed' }
      }

      ztoolkit.log('Citation debug - API response:', JSON.stringify(response).substring(0, 500) + '...')

      const count: unknown = response['is-referenced-by-count']
      if (count === undefined) {
        ztoolkit.log('Citation debug - No is-referenced-by-count field in response')
        return { count: 0, status: 'not_found', message: 'No citation count field in response' }
      }
      if (typeof count === 'number') {
        ztoolkit.log('Citation debug - is-referenced-by-count is not a number:', count)
        RateLimitManager.handleSuccess('crossref')
        return { count, status: 'success' }
      }
      if (typeof count === 'string') {
        ztoolkit.log('Citation debug - is-referenced-by-count is a string:', count)
        ztoolkit.log('Citation debug - Citation count from API:', count)
        RateLimitManager.handleSuccess('crossref')
        return { count: parseInt(count), status: 'success' }
      }
      return { count: -1, status: 'api_error', message: 'Invalid response format' }
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
  static async getInspireCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Try each identifier until one succeeds
    for (const identifier of identifiers) {
      ztoolkit.log(
        `Citation debug - Trying INSPIRE with ${identifier.type} ID: ${identifier.id} from ${identifier.source}`,
      )

      // Apply adaptive rate limiting
      await RateLimitManager.waitForRateLimit('inspire')

      let response: any = null

      try {
        const type = identifier.type === 'doi' ? 'dois' : 'arxiv'
        const url = `https://inspirehep.net/api/${type}/${identifier.id}`
        ztoolkit.log('Citation debug - Fetching from INSPIRE API:', url)

        const fetchResponse = await fetch(url)

        if (fetchResponse.status === 404) {
          ztoolkit.log(
            `Citation debug - ${identifier.type} ID ${identifier.id} not found in INSPIRE, trying next identifier`,
          )
          continue
        }

        if (fetchResponse.status === 429) {
          RateLimitManager.handleRateLimit('inspire')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }

        response = await fetchResponse.json().catch((error) => {
          ztoolkit.log('Citation debug - INSPIRE API fetch error:', error)
          return null
        })

        if (response === null) {
          ztoolkit.log(
            `Citation debug - INSPIRE API request failed for ${identifier.type} ID ${identifier.id}, trying next identifier`,
          )
          continue
        }

        ztoolkit.log('Citation debug - INSPIRE API response:', JSON.stringify(response).substring(0, 500) + '...')

        const count = response?.metadata?.citation_count
        if (count === undefined) {
          ztoolkit.log(
            `Citation debug - No citation_count field in INSPIRE response for ${identifier.type} ID ${identifier.id}, trying next identifier`,
          )
          continue
        }
        if (typeof count === 'number') {
          ztoolkit.log(
            `Citation debug - INSPIRE citation count: ${count} (found using ${identifier.type} ID ${identifier.id} from ${identifier.source})`,
          )
          RateLimitManager.handleSuccess('inspire')
          return { count, status: 'success' }
        }
        if (typeof count === 'string') {
          ztoolkit.log(
            `Citation debug - INSPIRE citation count (string): ${count} (found using ${identifier.type} ID ${identifier.id} from ${identifier.source})`,
          )
          RateLimitManager.handleSuccess('inspire')
          return { count: parseInt(count), status: 'success' }
        }
        ztoolkit.log(
          `Citation debug - Invalid response format for ${identifier.type} ID ${identifier.id}, trying next identifier`,
        )
        continue
      } catch (err) {
        ztoolkit.log(`Error getting citation count from INSPIRE for ${identifier.type} ID ${identifier.id}:`, err)
        continue
      }
    }

    // All identifiers failed
    return { count: 0, status: 'not_found', message: 'No valid identifiers found in INSPIRE' }
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
  static async getSemanticScholarCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Try each identifier until one succeeds
    for (const identifier of identifiers) {
      ztoolkit.log(
        `Citation debug - Trying Semantic Scholar with ${identifier.type} ID: ${identifier.id} from ${identifier.source}`,
      )

      // Apply adaptive rate limiting
      await RateLimitManager.waitForRateLimit('semanticscholar')

      let response: any = null

      try {
        // For arXiv DOIs, extract the arXiv ID since Semantic Scholar doesn't recognize arXiv DOIs
        let prefix = ''
        let apiId = identifier.id

        if (identifier.type === 'doi' && identifier.id.includes('arXiv')) {
          // Extract arXiv ID from DOI like "10.48550/arXiv.2201.02177"
          const arxivMatch = /arXiv\.(\d+\.\d+)/i.exec(identifier.id)
          if (arxivMatch) {
            prefix = 'arXiv:'
            apiId = arxivMatch[1]
            ztoolkit.log(`Citation debug - Using arXiv ID ${apiId} instead of arXiv DOI for Semantic Scholar`)
          }
        } else if (identifier.type === 'arxiv') {
          prefix = 'arXiv:'
          apiId = identifier.id
        }
        // For regular DOIs, use no prefix

        const url = `https://api.semanticscholar.org/graph/v1/paper/${prefix}${apiId}?fields=citationCount`
        ztoolkit.log('Citation debug - Fetching from Semantic Scholar API:', url)

        const fetchResponse = await fetch(url)

        if (fetchResponse.status === 404) {
          ztoolkit.log(
            `Citation debug - ${identifier.type} ID ${identifier.id} not found in Semantic Scholar, trying next identifier`,
          )
          continue
        }

        if (fetchResponse.status === 429) {
          RateLimitManager.handleRateLimit('semanticscholar')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }

        response = await fetchResponse.json().catch((error) => {
          ztoolkit.log('Citation debug - Semantic Scholar API fetch error:', error)
          return null
        })

        if (response === null) {
          ztoolkit.log(
            `Citation debug - Semantic Scholar API request failed for ${identifier.type} ID ${identifier.id}, trying next identifier`,
          )
          continue
        }

        ztoolkit.log(
          'Citation debug - Semantic Scholar API response:',
          JSON.stringify(response).substring(0, 500) + '...',
        )

        const count = response?.citationCount
        if (count === undefined) {
          ztoolkit.log(
            `Citation debug - No citationCount field in Semantic Scholar response for ${identifier.type} ID ${identifier.id}, trying next identifier`,
          )
          continue
        }

        if (typeof count === 'number') {
          ztoolkit.log(
            `Citation debug - Semantic Scholar citation count: ${count} (found using ${identifier.type} ID ${identifier.id} from ${identifier.source})`,
          )
          RateLimitManager.handleSuccess('semanticscholar')
          return { count, status: 'success' }
        }
        if (typeof count === 'string') {
          ztoolkit.log(
            `Citation debug - Semantic Scholar citation count (string): ${count} (found using ${identifier.type} ID ${identifier.id} from ${identifier.source})`,
          )
          RateLimitManager.handleSuccess('semanticscholar')
          return { count: parseInt(count), status: 'success' }
        }
        ztoolkit.log(
          `Citation debug - Invalid response format for ${identifier.type} ID ${identifier.id}, trying next identifier`,
        )
        continue
      } catch (err) {
        ztoolkit.log(
          `Error getting citation count from Semantic Scholar for ${identifier.type} ID ${identifier.id}:`,
          err,
        )
        continue
      }
    }

    // All identifiers failed
    return { count: 0, status: 'not_found', message: 'No valid identifiers found in Semantic Scholar' }
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
  static async getOpenAlexCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (identifier?.type !== 'doi') {
      ztoolkit.log('Citation debug - No DOI found for OpenAlex lookup:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found (OpenAlex requires DOI)' }
    }

    // DOI normalization: strip common prefixes, then URL-decode
    const decodedDoi = decodeURIComponent(identifier.id)
    const normalizedDoi = decodedDoi
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:/i, '')
      .trim()

    if (!normalizedDoi) {
      ztoolkit.log('Citation debug - DOI normalization produced empty string for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'DOI normalization failed' }
    }

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('openalex')

    const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalizedDoi)}?select=cited_by_count,fwci&mailto=openalex@citationtally.org`
    ztoolkit.log('Citation debug - Fetching from OpenAlex API:', url)

    try {
      const fetchResponse = await fetch(url)

      if (fetchResponse.status === 404) {
        ztoolkit.log('Citation debug - DOI not found in OpenAlex:', identifier.id)
        return { count: 0, status: 'not_found', message: 'DOI not found in OpenAlex' }
      }

      if (fetchResponse.status === 429) {
        RateLimitManager.handleRateLimit('openalex')
        return { count: -1, status: 'rate_limited', message: 'OpenAlex API rate limit exceeded' }
      }

      const response: any = await fetchResponse.json().catch((error) => {
        ztoolkit.log('Citation debug - OpenAlex API response parse error:', error)
        return null
      })

      if (response === null) {
        return { count: -1, status: 'api_error', message: 'OpenAlex API response parsing failed' }
      }

      ztoolkit.log('Citation debug - OpenAlex API response:', JSON.stringify(response).substring(0, 500) + '...')

      const count: unknown = response.cited_by_count
      const fwci: unknown = response.fwci

      if (count === undefined && fwci === undefined) {
        return { count: 0, status: 'not_found', message: 'No data in OpenAlex response' }
      }

      const resultCount = typeof count === 'number' ? count : typeof count === 'string' ? parseInt(count) : 0

      RateLimitManager.handleSuccess('openalex')
      return {
        count: isNaN(resultCount) ? 0 : resultCount,
        status: 'success',
        fwci: typeof fwci === 'number' ? fwci : undefined,
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
        updateItems(items)
      }
    }
  },
}

// Progress window tracking
let progressWindow: any
let currentIndex = -1
let totalItems = 0
let itemsToUpdate: Zotero.Item[] = []
let updatedCount = 0

/**
 * Reset the state of the citation count update process
 */
function resetState() {
  if (progressWindow) {
    progressWindow.close()
    progressWindow = null
  }
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
    // Create progress window
    progressWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

    progressWindow.createLine({
      text: getString('progress-getting-citation-tallies'),
      type: 'default',
      progress: 0,
    })
  }

  updateNextItem(operations, silent)
}

/**
 * Process the next item in the queue
 * @param operation Citation source to use
 */
function updateNextItem(operations?: string[] | string, silent: boolean = false) {
  // Move to next item
  currentIndex++

  // Check if processing is complete
  if (currentIndex >= totalItems) {
    if (progressWindow) {
      progressWindow.close()
      progressWindow = null
    }
    if (!silent) {
      const successWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

      successWindow.createLine({
        text: getString('progress-items-updated', { args: { count: updatedCount } }),
        type: 'success',
        progress: 100,
      })
      successWindow.show()
      successWindow.startCloseTimer(4000)
    }
    return
  }

  // Update progress
  const percent = Math.round((currentIndex / totalItems) * 100)
  if (!silent && progressWindow) {
    progressWindow.changeLine({
      text: getString('progress-item-counter', { args: { current: currentIndex + 1, total: totalItems } }),
      progress: percent,
    })
    progressWindow.show()
  }

  // Process current item
  const item = itemsToUpdate[currentIndex]

  void updateItem(item, operations, silent, false) // Manual updates don't respect unlisted cache
}

/**
 * Update a single item's citation count
 * @param item Zotero item to update
 * @param operation Citation source to use
 * @param isAutoUpdate Whether this is called from auto-update (to respect unlisted cache)
 */
async function updateItem(
  item: Zotero.Item,
  operations?: string[] | string,
  silent: boolean = false,
  isAutoUpdate: boolean = false,
) {
  try {
    ztoolkit.log('Citation debug - Updating item:', item.id, 'title:', item.getField('title'))

    const databases = Helpers.getDatabaseArray(operations)
    if (databases.length === 0) {
      ztoolkit.log('Citation debug - No databases configured, skipping item:', item.id)
      return
    }

    const data: CountArray = []
    for (const operation of databases) {
      // Check if this item is marked as ignored for this database (auto-update only)
      if (isAutoUpdate && IgnoredItemsManager.isIgnored(item.id, operation, true)) {
        ztoolkit.log(`Citation debug - Skipping ${operation} for item ${item.id} (marked as ignored)`)
        continue
      }

      let result: LookupResult
      let displayName = ''
      if (operation === 'crossref') {
        ztoolkit.log('Citation debug - DOI:', item.getField('DOI'))
        result = await DBInterface.getCrossrefCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'inspire') {
        result = await DBInterface.getInspireCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'semanticscholar') {
        result = await DBInterface.getSemanticScholarCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'openalex') {
        result = await DBInterface.getOpenAlexCountEnhanced(item)
        displayName = getOperationName(operation)
      } else {
        continue
      }

      // Handle the result and update tracking
      if (result.status === 'not_found') {
        ztoolkit.log(`Citation debug - ${operation} confirmed item ${item.id} as not found`)
        IgnoredItemsManager.markAsIgnored(item.id, operation, 'not_found', true)
      } else if (result.status === 'no_identifier') {
        ztoolkit.log(`Citation debug - ${operation} no identifier for item ${item.id}`)
        IgnoredItemsManager.markAsIgnored(item.id, operation, 'no_identifier', false)
      } else if (result.status === 'success' && result.count >= 0) {
        // Clear any previous ignored status on successful result
        ztoolkit.log(`Citation debug - ${operation} success for item ${item.id}: count=${result.count}`)
        IgnoredItemsManager.clearIgnoredItem(item.id, operation)
        data.push({ title: displayName, count: result.count, fwci: result.fwci })
      } else if (result.status === 'rate_limited') {
        ztoolkit.log(`Citation debug - ${operation} rate limited for item ${item.id}: ${result.message}`)
        // Don't mark as ignored for rate limits - purely temporary
      } else if (result.status === 'api_error') {
        ztoolkit.log(`Citation debug - ${operation} API error for item ${item.id}: ${result.message}`)

        // Track persistent API errors during autoupdate to prevent repeated attempts
        if (isAutoUpdate) {
          IgnoredItemsManager.markAsIgnored(item.id, operation, 'api_error', true)
        }
      }
    }

    ztoolkit.log('Citation debug - Retrieved count:', data)

    if (data.length > 0) {
      await Core.setCitationCount(item, data)
      ztoolkit.log('Citation debug - Item saved with new citation count')
      updatedCount++
    } else {
      ztoolkit.log('Citation debug - No valid count retrieved, skipping update')
    }
  } catch (e) {
    ztoolkit.log('Error updating citation count for item', e)
  }

  // Process next item
  void updateNextItem(operations, silent)
}

class BasicRegistrar {
  static registerPrefs() {
    void Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + 'content/preferences.xhtml',
      label: getString('prefs-title'),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    })
  }
}

class UIRegistrar {
  /**
   * Register custom column to display citation counts
   */
  static registerCitationColumn() {
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
        ztoolkit.log('Citation debug - Data provider called for item:', item.id)

        // Debug the raw item info
        try {
          ztoolkit.log('Citation debug - Item fields available:', Object.keys(item))
          ztoolkit.log('Citation debug - Item type:', item.itemTypeID, item.itemType)

          // // Log all available fields for this item
          // const fields = Zotero.ItemFields.getItemTypeFields(item.itemTypeID)
          // ztoolkit.log('Citation debug - Available fields:', fields)

          // // Check if the item has extra field data
          // if (item.hasOwnProperty('_extraFields')) {
          //   ztoolkit.log('Citation debug - Extra fields:', JSON.stringify(item._extraFields))
          // } else {
          //   ztoolkit.log('Citation debug - Extra fields - not found')
          // }

          // // Check for the DCounts field mentioned in the error
          // if (item.hasOwnProperty('_fieldData')) {
          //   ztoolkit.log('Citation debug - Field data:', JSON.stringify(item._fieldData))
          // } else {
          //   ztoolkit.log('Citation debug - Field data - not found')
          // }

          // Check for parent item if this is a child item
          if (item.isAttachment() || item.isNote()) {
            const parentItemID = item.parentItemID
            ztoolkit.log('Citation debug - Parent item ID:', parentItemID)
            if (parentItemID) {
              const parentItem = Zotero.Items.get(parentItemID)
              ztoolkit.log('Citation debug - Parent item type:', parentItem.itemTypeID)
            }
          }
        } catch (error) {
          ztoolkit.log('Citation debug - Error inspecting item:', error)
        }

        const result = Core.getCitationCountForColumn(item)
        // Return JSON string that renderCell will parse
        return result ? JSON.stringify(result) : ''
      },
      // iconPath: 'chrome://zotero/skin/citations.png',
      renderCell(index, data: any, column, isFirstColumn, doc) {
        ztoolkit.log('Citation debug - Rendering cell with data:', data)
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

        dataToUse.counts.forEach((count: string, idx: number) => {
          if (idx > 0) {
            const separator = doc.createElement('span')
            separator.innerText = ' | '
            separator.style.opacity = '0.25'
            span.appendChild(separator)
          }

          const countSpan = doc.createElement('span')
          countSpan.innerText = count
          if (useColors) {
            countSpan.style.color = getDatabaseColors()[dataToUse.databases[idx]] || '#000'
            countSpan.style.fontWeight = '500'
          }
          span.appendChild(countSpan)
        })

        // Add tooltip with database names
        const tooltip = dataToUse.databases
          .map((db: string, idx: number) => {
            const displayName = getOperationName(db)
            return getString('tooltip-citation-tallies', { args: { displayName, count: dataToUse.counts[idx] } })
          })
          .join(', ')
        span.title = tooltip

        return span
      },
    })
    ztoolkit.log('Citation debug - Column registration complete')
  }

  /**
   * Register custom column to display FWCI (Field-Weighted Citation Impact)
   */
  static registerFWCIColumn() {
    ztoolkit.log('Citation debug - Registering FWCI column')
    Zotero.ItemTreeManager.registerColumn({
      pluginID: addon.data.config.addonID,
      dataKey: 'fwci',
      label: getString('column-fwci'),
      width: '60',
      flex: 0,
      zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
      dataProvider: (item: Zotero.Item) => {
        return Core.getFWCIForColumn(item)
      },
      renderCell(index, data: any, column, isFirstColumn, doc) {
        const span = doc.createElement('span')
        span.className = `cell ${column.className}`
        span.style.textAlign = 'center'
        span.innerText = data || '-'
        return span
      },
    })
    ztoolkit.log('Citation debug - FWCI Column registration complete')
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
   * Uses MenuManager on Zotero 9, falls back to DOM injection on Zotero 7.
   */
  static registerCitationCountMenuItem() {
    // Zotero 9 path: use MenuManager API
    if ((Zotero as any).MenuManager?.registerMenu) {
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

      ;(Zotero as any).MenuManager.registerMenu({
        menuID: `${addon.data.config.addonID}-update-citations`,
        pluginID: addon.data.config.addonID,
        target: 'main/library/item',
        menus: [
          {
            menuType: 'menuitem',
            l10nID: getLocaleID('menuitem-update-citation-tallies'),
            icon: 'chrome://zotero/skin/toolbar-advanced-search.png',
            onShowing: showWhen,
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
              onCommand: () => addon.hooks.onDialogEvents(`updateCitationCounts-${source.key}`),
            },
          ],
        })
      }
      return
    }

    // Zotero 7 fallback: inject menuitems into the item context menu via DOM
    if (UIRegistrar._zotero7MenuInjected) return
    UIRegistrar._zotero7MenuInjected = true

    for (const win of Zotero.getMainWindows()) {
      const doc = win.document
      const itemMenu = doc.getElementById('zotero-itemmenu')
      if (!itemMenu) continue

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
      for (const src of sourceDefs) {
        const menuItem = UIRegistrar._createZotero7MenuItem(doc, src.l10n, () => {
          addon.hooks.onDialogEvents(`updateCitationCounts-${src.key}`)
        })
        itemMenu.appendChild(menuItem)
      }
    }
  }

  private static _zotero7MenuInjected = false

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
   * Register a menubar item to retally outdated item citations
   */
  static registerRetallyCitationsMenuItem() {
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
}

// Export functions needed by autoupdate module
export { DBInterface, Core, Helpers, UIRegistrar, BasicRegistrar, UX, updateItem, scheduleMonthlyCleanup }
