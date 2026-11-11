import { getPref, setPref } from '../utils/prefs'

import { shouldRetryAfter } from './citationData'

export interface IgnoredItemEntry {
  /** Number of consecutive confirmed `not_found` responses. */
  count: number
  /** ISO timestamp of the last confirmed `not_found` response. */
  lastChecked: string
  /**
   * Kept in the stored shape so entries written by older releases (which also
   * recorded transient API errors) can be discarded during the one-time
   * migration in `load()`.
   */
  reason?: 'not_found'
}

export type IgnoredItemsData = Record<string, Record<string, IgnoredItemEntry>>

const SAVE_DEBOUNCE_MS = 500

/**
 * Persistent store for confirmed `not_found` responses.
 *
 * The data is kept in memory for the lifetime of the plugin, mutated
 * synchronously, and written back as one debounced JSON update. This avoids the
 * previous O(N²) "read the whole pref, parse it, modify, serialize it" pattern
 * and removes the lost-update race between manual, automatic, and fetch-on-add
 * runs.
 */
class IgnoredItemsStore {
  private static data: IgnoredItemsData | null = null
  private static saveTimer: ReturnType<typeof setTimeout> | null = null
  private static dirty = false
  private static cleanupRunning = false

  static load(): IgnoredItemsData {
    if (this.data) return this.data

    const raw = getPref('ignoredItems')
    const parsed = this.parse(raw)
    this.data = parsed.data
    if (parsed.migrated) {
      this.dirty = true
      this.scheduleSave()
    }
    return this.data
  }

  private static parse(raw: string | undefined): { data: IgnoredItemsData; migrated: boolean } {
    const data: IgnoredItemsData = {}
    if (!raw) return { data, migrated: false }

    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (e) {
      ztoolkit.log('Failed to parse ignoredItems pref, treating as empty:', e)
      return { data, migrated: true }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { data, migrated: true }
    }

    let migrated = false
    for (const [database, entries] of Object.entries(value as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        migrated = true
        continue
      }

      const cleanEntries: Record<string, IgnoredItemEntry> = {}
      for (const [itemKey, entry] of Object.entries(entries as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          migrated = true
          continue
        }
        const candidate = entry as Record<string, unknown>
        const count = candidate.count
        const lastChecked = candidate.lastChecked
        // Legacy entries have no `reason` and may have been created from
        // transient network/HTTP failures. Discard them once; a genuine 404
        // will be recorded again on the next automatic run.
        if (candidate.reason !== 'not_found') {
          migrated = true
          continue
        }
        if (
          typeof count !== 'number' ||
          !Number.isFinite(count) ||
          count < 0 ||
          typeof lastChecked !== 'string' ||
          Number.isNaN(new Date(lastChecked).getTime())
        ) {
          migrated = true
          continue
        }
        cleanEntries[itemKey] = { count, lastChecked, reason: 'not_found' }
      }

      if (Object.keys(cleanEntries).length > 0) {
        data[database] = cleanEntries
      } else if (Object.keys(entries).length > 0) {
        migrated = true
      }
    }

    return { data, migrated }
  }

  private static scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private static save(): void {
    if (!this.dirty || !this.data) return
    try {
      setPref('ignoredItems', JSON.stringify(this.data))
      this.dirty = false
    } catch (e) {
      ztoolkit.log('Failed to save ignoredItems pref:', e)
    }
  }

  /**
   * Write pending changes immediately. Call on shutdown, when the debounce
   * timer may never fire.
   */
  static flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
  }

  static get(itemId: number, database: string): IgnoredItemEntry | undefined {
    return this.load()[database]?.[itemId.toString()]
  }

  static isBlocked(itemId: number, database: string): boolean {
    const entry = this.get(itemId, database)
    if (!entry) return false
    return !shouldRetryAfter(entry.count, entry.lastChecked)
  }

  static areAllBlocked(itemId: number, databases: readonly string[]): boolean {
    if (databases.length === 0) return false
    return databases.every((database) => this.isBlocked(itemId, database))
  }

  static markNotFound(itemId: number, database: string): void {
    const data = this.load()
    const itemKey = itemId.toString()
    if (!data[database]) data[database] = {}
    const existing = data[database][itemKey]
    data[database][itemKey] = {
      count: existing?.count ? existing.count + 1 : 1,
      lastChecked: new Date().toISOString(),
      reason: 'not_found',
    }
    this.scheduleSave()
  }

  static clear(itemId: number, database?: string): void {
    const data = this.load()
    const itemKey = itemId.toString()
    let modified = false

    if (database) {
      if (data[database]?.[itemKey]) {
        delete data[database][itemKey]
        modified = true
        if (Object.keys(data[database]).length === 0) {
          delete data[database]
        }
      }
    } else {
      for (const dbKey of Object.keys(data)) {
        if (data[dbKey][itemKey]) {
          delete data[dbKey][itemKey]
          modified = true
          if (Object.keys(data[dbKey]).length === 0) {
            delete data[dbKey]
          }
        }
      }
    }

    if (modified) this.scheduleSave()
  }

  /**
   * Drop entries for deleted or missing items. Runs once on startup and at
   * most every 30 days from the daily timer in citationTally.ts.
   */
  static async cleanupNonExistentItems(): Promise<void> {
    if (this.cleanupRunning) return
    this.cleanupRunning = true

    try {
      const data = this.load()
      let modified = false

      // Resolve the referenced items in chunks instead of one blocking
      // `Zotero.Items.get` per key.
      const referenced = new Set<number>()
      for (const database of Object.keys(data)) {
        for (const itemKey of Object.keys(data[database])) {
          const itemId = parseInt(itemKey, 10)
          if (Number.isFinite(itemId)) referenced.add(itemId)
        }
      }

      const checked = new Set<number>()
      const existing = new Set<number>()
      const ids = [...referenced]
      const chunkSize = 200

      for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize)
        try {
          const items = await Zotero.Items.getAsync(chunk)
          // getAsync omits ids it cannot resolve; every id in this chunk was
          // successfully looked up, so the missing ones can be removed.
          for (const id of chunk) checked.add(id)
          for (const item of items) {
            if (item && !item.deleted) existing.add(item.id)
          }
        } catch (e) {
          // Leave the records of this chunk untouched rather than deleting
          // them because of a transient load failure.
          ztoolkit.log('Failed to check ignored-item records:', e)
        }
        if (offset + chunkSize < ids.length) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }

      for (const database of Object.keys(data)) {
        for (const itemKey of Object.keys(data[database])) {
          const itemId = parseInt(itemKey, 10)
          if (!Number.isFinite(itemId) || (checked.has(itemId) && !existing.has(itemId))) {
            delete data[database][itemKey]
            modified = true
          }
        }

        if (Object.keys(data[database]).length === 0) {
          delete data[database]
          modified = true
        }
      }

      if (modified) {
        this.dirty = true
        this.save()
        ztoolkit.log('Cleaned up ignored-item records for deleted library items')
      }
      setPref('lastIgnoredCleanup', String(Date.now()))
    } catch (e) {
      ztoolkit.log('Failed to clean up ignored items:', e)
    } finally {
      this.cleanupRunning = false
    }
  }

  /** Test/maintenance helper: forget the in-memory copy. */
  static resetCache(): void {
    this.flush()
    this.data = null
    this.dirty = false
  }
}

export { IgnoredItemsStore }
