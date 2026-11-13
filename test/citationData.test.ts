import assert from 'node:assert/strict'
import test from 'node:test'

import {
  colorSchemePrefToLightMode,
  extractIdentifiers,
  formatDate,
  normalizeArxivId,
  normalizeDatabaseName,
  normalizeDoi,
  parseExtra,
  pickLatestEntry,
  requiredRetryDays,
  semanticScholarArxivPath,
  shouldRetryAfter,
  trimExtraHistory,
} from '../src/modules/citationData.ts'

test('semanticScholarArxivPath keeps the slash in old-style IDs', () => {
  // Percent-encoding it yields HTTP 429 for every ID, so the slash must stay.
  assert.equal(semanticScholarArxivPath('hep-th/9901001'), 'arXiv:hep-th/9901001')
  assert.equal(semanticScholarArxivPath('2201.02177'), 'arXiv:2201.02177')
  // No other characters may leak through unencoded.
  assert.equal(semanticScholarArxivPath('hep-th/9901001v2'), 'arXiv:hep-th/9901001v2')
})

test('colorSchemePrefToLightMode follows Zotero preference values', () => {
  // Zotero's Appearance pane: 0 = Dark, 1 = Light, 2 = Automatic.
  assert.equal(colorSchemePrefToLightMode(0), false)
  assert.equal(colorSchemePrefToLightMode(1), true)
  assert.equal(colorSchemePrefToLightMode(2), null)
  assert.equal(colorSchemePrefToLightMode('1'), true)
  assert.equal(colorSchemePrefToLightMode(undefined), null)
  assert.equal(colorSchemePrefToLightMode(null), null)
})

test('normalizeDatabaseName accepts legacy spellings', () => {
  assert.equal(normalizeDatabaseName('Crossref'), 'crossref')
  assert.equal(normalizeDatabaseName('INSPIRE-HEP'), 'inspire')
  assert.equal(normalizeDatabaseName('INSPIRE-HEP/arXiv'), 'inspire')
  assert.equal(normalizeDatabaseName('Semantic Scholar'), 'semanticscholar')
  assert.equal(normalizeDatabaseName('OpenAlex'), 'openalex')
  assert.equal(normalizeDatabaseName('unknown'), null)
})

test('normalizeDoi strips prefixes and rejects non-DOIs', () => {
  assert.equal(normalizeDoi('10.1000/ABC'), '10.1000/ABC')
  assert.equal(normalizeDoi('https://doi.org/10.1000/abc'), '10.1000/abc')
  assert.equal(normalizeDoi('doi: 10.1000/abc'), '10.1000/abc')
  assert.equal(normalizeDoi('10.1000%2Fabc'), '10.1000/abc')
  assert.equal(normalizeDoi('not-a-doi'), null)
  assert.equal(normalizeDoi(undefined), null)
})

test('normalizeArxivId accepts new, old, URL, and versioned forms', () => {
  assert.equal(normalizeArxivId('2201.02177'), '2201.02177')
  assert.equal(normalizeArxivId('arXiv:2201.02177v3'), '2201.02177')
  assert.equal(normalizeArxivId('https://arxiv.org/abs/hep-th/9901001v2'), 'hep-th/9901001')
  assert.equal(normalizeArxivId('2201.02177 [hep-th]'), '2201.02177')
  assert.equal(normalizeArxivId('10.1000/abc'), null)
})

test('extractIdentifiers prefers DOI and derives arXiv from arXiv DOIs', () => {
  const identifiers = extractIdentifiers({ doi: '10.48550/arXiv.2201.02177' })
  assert.deepEqual(
    identifiers.map((identifier) => [identifier.type, identifier.id]),
    [
      ['doi', '10.48550/arXiv.2201.02177'],
      ['arxiv', '2201.02177'],
    ],
  )
})

test('extractIdentifiers reads arXiv IDs from the usual fields without duplicates', () => {
  const identifiers = extractIdentifiers({
    archiveID: '2201.02177',
    reportNumber: 'arXiv:2201.02177v2',
    extra: 'arXiv: 2201.02177',
    url: 'https://arxiv.org/abs/2201.02177',
    callNumber: '2201.02177',
  })
  assert.equal(identifiers.length, 1)
  assert.equal(identifiers[0].type, 'arxiv')
  assert.equal(identifiers[0].id, '2201.02177')
})

test('parseExtra understands current and legacy entry formats', () => {
  const parsed = parseExtra(
    [
      'Citations: 12 (Crossref) [2025-01-02]',
      '5 citations (INSPIRE-HEP/arXiv) [2020-03-04]',
      'Citations (OpenAlex): 7',
      'FWCI: 1.25 (OpenAlex) [2025-01-02]',
      'AvgCite: 2.5 (Crossref) [2025-01-02]',
      'Unrelated user note',
      'Citations: NaN (Crossref) [2025-01-02]',
    ].join('\n'),
  )

  assert.equal(parsed.citations.crossref?.value, 12)
  assert.equal(parsed.citations.crossref?.date, '2025-01-02')
  assert.equal(parsed.citations.inspire?.value, 5)
  assert.equal(parsed.citations.openalex?.value, 7)
  assert.equal(parsed.fwci.openalex?.value, 1.25)
  assert.equal(parsed.avgCite.crossref?.value, 2.5)
})

test('parseExtra keeps the newest dated entry for each source', () => {
  const parsed = parseExtra(
    ['Citations: 3 (Crossref) [2024-01-01]', 'Citations: 9 (Crossref) [2025-01-01]', 'Citations: 5 (Crossref)'].join(
      '\n',
    ),
  )
  assert.equal(parsed.citations.crossref?.value, 9)
  assert.equal(parsed.citations.crossref?.date, '2025-01-01')
})

test('pickLatestEntry follows the configured database order for undated ties', () => {
  const parsed = parseExtra('Citations: 4 (Crossref)\nCitations: 8 (OpenAlex)\nCitations: 6 (INSPIRE)')
  const latest = pickLatestEntry(parsed.citations)
  assert.equal(latest?.database, 'crossref')
  assert.equal(latest?.value, 4)
})

test('trimExtraHistory caps each source and leaves user lines alone', () => {
  const lines = ['User note']
  for (let index = 0; index < 25; index++) {
    lines.push(`Citations: ${index} (Crossref) [2025-01-02]`)
  }
  for (let index = 0; index < 3; index++) {
    lines.push(`Citations: ${index} (OpenAlex) [2025-01-02]`)
  }

  const trimmed = trimExtraHistory(lines.join('\n'), 20)
  const result = trimmed.split('\n')
  assert.equal(result[0], 'User note')
  assert.equal(result.filter((line) => line.includes('(Crossref)')).length, 20)
  assert.equal(result.filter((line) => line.includes('(OpenAlex)')).length, 3)
  // The oldest Crossref entries are dropped, not the newest.
  assert.ok(result.includes('Citations: 0 (Crossref) [2025-01-02]'))
  assert.ok(!result.includes('Citations: 24 (Crossref) [2025-01-02]'))
})

test('retry backoff grows with consecutive failures and resets for zero', () => {
  assert.equal(requiredRetryDays(0), 0)
  assert.equal(requiredRetryDays(1), 7)
  assert.equal(requiredRetryDays(2), 30)
  assert.equal(requiredRetryDays(3), 90)
  assert.equal(requiredRetryDays(10), 180)

  const now = new Date('2025-02-01T00:00:00Z')
  assert.equal(shouldRetryAfter(1, '2025-01-20T00:00:00Z', now), true)
  assert.equal(shouldRetryAfter(1, '2025-01-30T00:00:00Z', now), false)
  assert.equal(shouldRetryAfter(1, 'not-a-date', now), true)
})

test('formatDate uses local calendar fields with zero padding', () => {
  assert.equal(formatDate(new Date(2025, 0, 2)), '2025-01-02')
})
