/**
 * Pure helpers for the data that lives in Zotero items and their Extra field.
 *
 * Keeping this module free of Zotero runtime access makes the parsing rules
 * testable with plain Node and, more importantly, gives every caller the same
 * notion of what an identifier, a date, or a database name is.
 */

export const DATABASE_IDS = ['crossref', 'inspire', 'semanticscholar', 'openalex'] as const
export type DatabaseId = (typeof DATABASE_IDS)[number]

/**
 * Names written into Extra. These are deliberately stable English names: Extra
 * is synchronized between machines with different Zotero UI languages, so the
 * storage format must not depend on the current locale. Old releases used the
 * localized display names, which happened to be identical for these four
 * databases; the aliases below keep those records readable.
 */
export const DATABASE_STORAGE_NAMES: Record<DatabaseId, string> = {
  crossref: 'Crossref',
  inspire: 'INSPIRE',
  semanticscholar: 'SemanticScholar',
  openalex: 'OpenAlex',
}

const DATABASE_ALIASES: Record<string, DatabaseId> = {
  crossref: 'crossref',
  inspire: 'inspire',
  inspirehep: 'inspire',
  semanticscholar: 'semanticscholar',
  semanticsscholar: 'semanticscholar',
  openalex: 'openalex',
}

export function isDatabaseId(value: string): value is DatabaseId {
  return (DATABASE_IDS as readonly string[]).includes(value)
}

/**
 * Normalize a database label found inside an Extra entry. Handles the old
 * zotero-cc names (`INSPIRE-HEP`, `Semantic Scholar`) and old formats that
 * appended the identifier type (`INSPIRE-HEP/arXiv`).
 */
export function normalizeDatabaseName(raw: string): DatabaseId | null {
  const cleaned = raw
    .split('/')[0]
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return DATABASE_ALIASES[cleaned] || null
}

export type IdentifierType = 'doi' | 'arxiv'

export interface ItemIdentifier {
  type: IdentifierType
  id: string
  source: string
}

export interface IdentifierFields {
  doi?: string
  archiveID?: string
  reportNumber?: string
  extra?: string
  url?: string
  callNumber?: string
}

const NEW_ARXIV_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/
const OLD_ARXIV_ID = /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/i
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i

/**
 * `decodeURIComponent` throws on malformed percent escapes. A single bad DOI
 * must not abort a whole update run, so decode failures return the input as-is.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Turn a DOI (plain, URL, `doi:`-prefixed, or percent-encoded) into the bare
 * form used by every API. Returns null when the value cannot be a DOI.
 */
export function normalizeDoi(raw: string | undefined | null): string | null {
  if (!raw) return null
  let doi = safeDecodeURIComponent(String(raw)).trim()
  doi = doi
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/^\/+/, '')
    .trim()
  if (!DOI_PATTERN.test(doi)) return null
  return doi
}

/**
 * Accepts new-style (`2201.02177`) and old-style (`hep-th/9901001`) arXiv IDs,
 * with an optional `arXiv:` prefix, an optional version suffix, and arXiv URLs.
 */
export function normalizeArxivId(raw: string | undefined | null): string | null {
  if (!raw) return null
  let value = String(raw).trim()
  if (!value) return null

  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+)/i.exec(value)
  if (urlMatch) {
    value = safeDecodeURIComponent(urlMatch[1]).replace(/\.pdf$/i, '')
  } else {
    value = value.replace(/^arxiv:\s*/i, '').trim()
  }

  // A field can contain `arXiv:2201.02177 [hep-th]` or similar annotations.
  const token = value.split(/[\s,;]+/)[0]?.replace(/\.pdf$/i, '')
  if (!token || !(NEW_ARXIV_ID.test(token) || OLD_ARXIV_ID.test(token))) {
    return null
  }
  // INSPIRE and Semantic Scholar both resolve without the version suffix.
  return token.replace(/v\d+$/i, '')
}

function matchArxivField(value: string | undefined): string | null {
  if (!value) return null
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // `reportNumber` can contain several identifiers; only lines that are an
    // arXiv ID or explicitly start with `arXiv:` are trusted.
    if (!/^arxiv\s*:/i.test(trimmed)) continue
    const id = normalizeArxivId(trimmed)
    if (id) return id
  }
  // `archiveID` and `callNumber` commonly contain the bare ID.
  return normalizeArxivId(value)
}

function arxivFromArxivDoi(doi: string): string | null {
  const match = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)
  return match ? normalizeArxivId(match[1]) : null
}

/**
 * Extract all usable identifiers from an item. DOI is preferred, followed by
 * arXiv IDs from the usual Zotero fields. Duplicates are removed.
 */
export function extractIdentifiers(fields: IdentifierFields): ItemIdentifier[] {
  const identifiers: ItemIdentifier[] = []
  const add = (type: IdentifierType, id: string, source: string) => {
    if (!id) return
    if (identifiers.some((existing) => existing.type === type && existing.id.toLowerCase() === id.toLowerCase())) {
      return
    }
    identifiers.push({ type, id, source })
  }

  const doi = normalizeDoi(fields.doi)
  if (doi) {
    add('doi', doi, 'DOI')
    const arxivFromDoi = arxivFromArxivDoi(doi)
    if (arxivFromDoi) add('arxiv', arxivFromDoi, 'DOI')
  }

  const archiveID = matchArxivField(fields.archiveID)
  if (archiveID) add('arxiv', archiveID, 'archiveID')

  const reportNumber = matchArxivField(fields.reportNumber)
  if (reportNumber) add('arxiv', reportNumber, 'reportNumber')

  if (fields.extra) {
    for (const line of fields.extra.split('\n')) {
      const match = /^arxiv\s*:\s*(.+)$/i.exec(line.trim())
      if (!match) continue
      const id = normalizeArxivId(match[1])
      if (id) add('arxiv', id, 'extra')
    }
  }

  const urlArxiv = normalizeArxivId(fields.url)
  if (urlArxiv && /arxiv\.org\//i.test(fields.url || '')) add('arxiv', urlArxiv, 'url')

  const callNumber = matchArxivField(fields.callNumber)
  if (callNumber) add('arxiv', callNumber, 'callNumber')

  return identifiers
}

export interface ExtraEntry<T> {
  value: T
  date: string | null
  dateMs: number
}

export interface ParsedExtra {
  citations: Partial<Record<DatabaseId, ExtraEntry<number>>>
  fwci: Partial<Record<DatabaseId, ExtraEntry<number>>>
  avgCite: Partial<Record<DatabaseId, ExtraEntry<number>>>
}

export interface ParsedExtraLine {
  kind: 'citations' | 'fwci' | 'avgCite'
  database: DatabaseId
}

function parseEntryDate(raw: string | undefined): { date: string | null; dateMs: number } {
  if (!raw) return { date: null, dateMs: 0 }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim())
  if (!match) return { date: null, dateMs: 0 }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const time = Date.UTC(year, month - 1, day)
  const check = new Date(time)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return { date: null, dateMs: 0 }
  }
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { date, dateMs: time }
}

function pickNewest<T>(
  current: ExtraEntry<T> | undefined,
  value: T,
  date: string | null,
  dateMs: number,
): ExtraEntry<T> {
  if (!current) return { value, date, dateMs }
  // A dated entry always supersedes an undated one. Entries with the same date
  // keep the first occurrence, which is the newest because writes prepend.
  if (dateMs > current.dateMs) return { value, date, dateMs }
  return current
}

export function parsePluginLine(line: string): ParsedExtraLine | null {
  const trimmed = line.trim()

  let match = /^Citations:\s*\d+\s*\(([^)]+)\)/i.exec(trimmed)
  if (match) {
    const database = normalizeDatabaseName(match[1])
    return database ? { kind: 'citations', database } : null
  }
  match = /^\d+\s+citations\s*\(([^)]+)\)/i.exec(trimmed)
  if (match) {
    const database = normalizeDatabaseName(match[1])
    return database ? { kind: 'citations', database } : null
  }
  match = /^Citations\s*\(([^)]+)\):/i.exec(trimmed)
  if (match) {
    const database = normalizeDatabaseName(match[1])
    return database ? { kind: 'citations', database } : null
  }

  match = /^FWCI:\s*-?\d+(?:\.\d+)?\s*\(([^)]+)\)/i.exec(trimmed)
  if (match) {
    const database = normalizeDatabaseName(match[1])
    return database ? { kind: 'fwci', database } : null
  }

  match = /^AvgCite:\s*-?\d+(?:\.\d+)?\s*\(([^)]+)\)/i.exec(trimmed)
  if (match) {
    const database = normalizeDatabaseName(match[1])
    return database ? { kind: 'avgCite', database } : null
  }

  return null
}

function parseCitationsLine(line: string): { database: DatabaseId; count: number; date: string | null } | null {
  const trimmed = line.trim()
  let match = /^Citations:\s*(\d+)\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/i.exec(trimmed)
  let database: DatabaseId | null = null
  let count: number | null = null
  let dateRaw: string | undefined

  if (match) {
    database = normalizeDatabaseName(match[2])
    count = Number(match[1])
    dateRaw = match[3]
  } else {
    match = /^(\d+)\s+citations\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/i.exec(trimmed)
    if (match) {
      count = Number(match[1])
      database = normalizeDatabaseName(match[2])
      dateRaw = match[3]
    } else {
      match = /^Citations\s*\(([^)]+)\):\s*(\d+)/i.exec(trimmed)
      if (match) {
        database = normalizeDatabaseName(match[1])
        count = Number(match[2])
      }
    }
  }

  if (!database || count === null || !Number.isFinite(count) || count < 0) return null
  return { database, count, date: parseEntryDate(dateRaw).date }
}

function parseFwciLine(line: string): { database: DatabaseId; value: number; date: string | null } | null {
  const match = /^FWCI:\s*(-?\d+(?:\.\d+)?)\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/i.exec(line.trim())
  if (!match) return null
  const database = normalizeDatabaseName(match[2])
  const value = Number(match[1])
  if (!database || !Number.isFinite(value)) return null
  return { database, value, date: parseEntryDate(match[3]).date }
}

function parseAvgCiteLine(line: string): { database: DatabaseId; value: number; date: string | null } | null {
  const match = /^AvgCite:\s*(-?\d+(?:\.\d+)?)\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/i.exec(line.trim())
  if (!match) return null
  const database = normalizeDatabaseName(match[2])
  const value = Number(match[1])
  if (!database || !Number.isFinite(value)) return null
  return { database, value, date: parseEntryDate(match[3]).date }
}

/**
 * Parse the three plugin-owned entry types in one pass. Unknown lines and
 * malformed values are ignored rather than producing `NaN` in the UI.
 */
export function parseExtra(extra: string | undefined | null): ParsedExtra {
  const parsed: ParsedExtra = { citations: {}, fwci: {}, avgCite: {} }
  if (!extra) return parsed

  for (const line of extra.split('\n')) {
    const citation = parseCitationsLine(line)
    if (citation) {
      const { date, dateMs } = parseEntryDate(citation.date || undefined)
      parsed.citations[citation.database] = pickNewest(
        parsed.citations[citation.database],
        citation.count,
        date,
        dateMs,
      )
      continue
    }

    const fwci = parseFwciLine(line)
    if (fwci) {
      const { date, dateMs } = parseEntryDate(fwci.date || undefined)
      parsed.fwci[fwci.database] = pickNewest(parsed.fwci[fwci.database], fwci.value, date, dateMs)
      continue
    }

    const avgCite = parseAvgCiteLine(line)
    if (avgCite) {
      const { date, dateMs } = parseEntryDate(avgCite.date || undefined)
      parsed.avgCite[avgCite.database] = pickNewest(parsed.avgCite[avgCite.database], avgCite.value, date, dateMs)
    }
  }

  return parsed
}

/**
 * Pick the entry with the newest date across all databases.
 */
export function pickLatestEntry<T>(
  entries: Partial<Record<DatabaseId, ExtraEntry<T>>>,
  order: readonly DatabaseId[] = DATABASE_IDS,
): (ExtraEntry<T> & { database: DatabaseId }) | null {
  let best: (ExtraEntry<T> & { database: DatabaseId }) | null = null
  for (const database of order) {
    const entry = entries[database]
    if (!entry) continue
    if (!best || entry.dateMs > best.dateMs) {
      best = { ...entry, database }
    }
  }
  return best
}

export const MAX_HISTORY_PER_SOURCE = 20

/**
 * Keep the newest `MAX_HISTORY_PER_SOURCE` plugin-written lines for each
 * entry kind and database. Non-plugin lines are never touched. Writes prepend,
 * so scanning from the top keeps the newest entries.
 */
export function trimExtraHistory(extra: string, maxPerSource = MAX_HISTORY_PER_SOURCE): string {
  const kept: string[] = []
  const counts = new Map<string, number>()

  for (const line of extra.split('\n')) {
    const parsed = parsePluginLine(line)
    if (!parsed) {
      kept.push(line)
      continue
    }
    const key = `${parsed.kind}:${parsed.database}`
    const count = counts.get(key) || 0
    if (count >= maxPerSource) continue
    counts.set(key, count + 1)
    kept.push(line)
  }

  return kept.join('\n')
}

export function formatDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Number of consecutive failed automatic lookups before an item is considered
 * blocked for a database.
 */
export function requiredRetryDays(count: number): number {
  if (count === 1) return 7
  if (count === 2) return 30
  if (count === 3) return 90
  return count > 3 ? 180 : 0
}

export function shouldRetryAfter(count: number, lastChecked: string, now: Date = new Date()): boolean {
  const requiredDays = requiredRetryDays(count)
  if (requiredDays === 0) return true
  const last = new Date(lastChecked)
  if (Number.isNaN(last.getTime())) return true
  return now.getTime() - last.getTime() > requiredDays * 24 * 60 * 60 * 1000
}
