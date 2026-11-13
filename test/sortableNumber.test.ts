import assert from 'node:assert/strict'
import test from 'node:test'

import { SORT_EMPTY_KEY, SORT_PAD_WIDTH, sortableNumber, sortableNumberToNumber } from '../src/modules/citationData.ts'

// The item tree sorts a column by comparing its dataProvider string
// lexicographically, so the encoding must keep numeric order under
// `localeCompare` (Zotero's collation behaves the same way, see
// `SORT_EMPTY_KEY`).

test('sortableNumber keeps non-negative values numerically sortable', () => {
  const values = ['0.00', '2.50', '10.00', '999.99']
  const sorted = [...values].sort((a, b) => sortableNumber(a).localeCompare(sortableNumber(b)))
  assert.deepEqual(sorted, values)
})

test('sortableNumber sorts negative values before non-negative ones', () => {
  const values = ['-3.00', '-0.50', '0.00', '1.25']
  const sorted = [...values].sort((a, b) => sortableNumber(a).localeCompare(sortableNumber(b)))
  assert.deepEqual(sorted, values)
})

test('sortableNumber preserves order across mixed magnitudes', () => {
  const values = ['-12.00', '-2.00', '0.00', '2.00', '12.00', '120.00']
  const sorted = [...values].sort((a, b) => sortableNumber(a).localeCompare(sortableNumber(b)))
  assert.deepEqual(sorted, values)
})

test('sortableNumber sorts absent values after every real value', () => {
  const values = ['-', '-12.00', '-0.50', '0.00', '2.50', '999.99']
  const sorted = [...values].sort((a, b) => sortableNumber(a).localeCompare(sortableNumber(b)))
  assert.deepEqual(sorted, ['-12.00', '-0.50', '0.00', '2.50', '999.99', '-'])
  assert.equal(sortableNumber('-'), SORT_EMPTY_KEY)
})

test('sortableNumber maps absent and malformed values to the placeholder', () => {
  assert.equal(sortableNumber('not-a-number'), SORT_EMPTY_KEY)
  assert.equal(sortableNumber(''), SORT_EMPTY_KEY)
})

test('sortableNumber keeps values that round to zero non-negative', () => {
  // -0.001 rounds to 0.00; the complemented key must stay 12 digits wide.
  const encoded = sortableNumber('-0.001')
  assert.equal(encoded.replace('-', '').length, SORT_PAD_WIDTH)
})

test('sortableNumber output has a stable width', () => {
  for (const value of ['0', '5.5', '-5.5', '1234.5678']) {
    const encoded = sortableNumber(value)
    assert.ok(
      encoded === SORT_EMPTY_KEY || encoded.replace('-', '').length === SORT_PAD_WIDTH,
      `unexpected width for ${value}: ${encoded}`,
    )
  }
})

test('sortableNumberToNumber round-trips values that the column displays', () => {
  for (const value of [0, 1, 42, 2.5, 999.99, -0.5, -12.25]) {
    const displayed = value.toFixed(2)
    assert.equal(sortableNumberToNumber(sortableNumber(displayed)), value)
  }
})

test('sortableNumberToNumber rejects the placeholder and foreign strings', () => {
  assert.equal(sortableNumberToNumber('-'), null)
  assert.equal(sortableNumberToNumber(SORT_EMPTY_KEY), null)
  assert.equal(sortableNumberToNumber(''), null)
  assert.equal(sortableNumberToNumber('12'), null)
  assert.equal(sortableNumberToNumber('000000000042'), 0.42)
})
