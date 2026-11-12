import assert from 'node:assert/strict'
import test from 'node:test'

import { SORT_PAD_WIDTH, sortableNumber, sortableNumberToNumber } from '../src/modules/citationData.ts'

// The item tree sorts a column by comparing its dataProvider string
// lexicographically, so the encoding must keep numeric order under
// `localeCompare`.

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

test('sortableNumber maps absent and malformed values to the placeholder', () => {
  assert.equal(sortableNumber('-'), '-')
  assert.equal(sortableNumber('not-a-number'), '-')
  assert.equal(sortableNumber(''), '-')
})

test('sortableNumber output has a stable width', () => {
  for (const value of ['0', '5.5', '-5.5', '1234.5678']) {
    const encoded = sortableNumber(value)
    assert.ok(
      encoded === '-' || encoded.replace('-', '').length === SORT_PAD_WIDTH,
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
  assert.equal(sortableNumberToNumber(''), null)
  assert.equal(sortableNumberToNumber('12'), null)
  assert.equal(sortableNumberToNumber('000000000042'), 0.42)
})
