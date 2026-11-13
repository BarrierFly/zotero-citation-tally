/**
 * Read-only/public entry points for automation and for other plugins.
 *
 * Nothing here is required for the plugin's own UI: the module exists so tests
 * and external tooling can exercise the import/parse/update logic without
 * reaching into module-private state.
 */

import { Core, DBInterface, Helpers, updateItem } from './citationTally'
import { parseExtra, sortableNumber, sortableNumberToNumber } from './citationData'
import { IgnoredItemsStore } from './ignoredItems'
import { startAutomaticUpdate } from './citationAutoupdate'

export const api = {
  citationData: {
    parseExtra,
    sortableNumber,
    sortableNumberToNumber,
  },
  core: {
    /** Column values for one item. */
    getCitationCountForColumn: (item: Zotero.Item) => Core.getCitationCountForColumn(item),
    getFWCIForColumn: (item: Zotero.Item) => Core.getFWCIForColumn(item),
    getAvgCiteForColumn: (item: Zotero.Item) => Core.getAvgCiteForColumn(item),
    /** Identifiers extracted from an item that already has itemData loaded. */
    getIdentifiers: (item: Zotero.Item) => Helpers.getAllItemIdentifiers(item),
    computeAvgCiteEntry: (item: Zotero.Item) => Core.computeAvgCiteEntry(item),
    getPublicationDate: (item: Zotero.Item) => Core.getPublicationDate(item),
  },
  databases: {
    /** One lookup, bypassing all caches and backoff bookkeeping. */
    lookup: (database: 'crossref' | 'inspire' | 'semanticscholar' | 'openalex', item: Zotero.Item) => {
      switch (database) {
        case 'crossref':
          return DBInterface.getCrossrefCountEnhanced(item)
        case 'inspire':
          return DBInterface.getInspireCountEnhanced(item)
        case 'semanticscholar':
          return DBInterface.getSemanticScholarCountEnhanced(item)
        case 'openalex':
          return DBInterface.getOpenAlexCountEnhanced(item)
      }
    },
  },
  items: {
    /** Full manual-style update for one item (does not touch the UI queue). */
    updateItem: (item: Zotero.Item, operations?: string[]) => updateItem(item, operations, true, false, false),
  },
  backoff: {
    isBlocked: (itemID: number, database: string) => IgnoredItemsStore.isBlocked(itemID, database),
    clear: (itemID: number, database?: string) => IgnoredItemsStore.clear(itemID, database),
  },
  scan: {
    /** Runs the same outdated-item scan as the Tools menu entry. */
    retallyOutdated: () => startAutomaticUpdate(true, true),
  },
}
