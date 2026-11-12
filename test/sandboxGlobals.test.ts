import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

/**
 * Zotero creates plugin scopes with an explicit whitelist of globals
 * (`Zotero.Plugins` in plugins.js: `fetch`, `XMLHttpRequest`, `URL`,
 * `TextDecoder`, `crypto`, …). `AbortController` is not on that list, and
 * neither is `structuredClone`. Referencing them throws a `ReferenceError`
 * inside the plugin sandbox, which callers tend to swallow as a generic API
 * failure — the plugin then appears to do nothing at all.
 *
 * Node and TypeScript both provide these globals, so type-checking and unit
 * tests cannot catch the mistake; only the sandbox can. Scan the sources that
 * end up in the bundle instead.
 */
const SANDBOX_ABSENT_GLOBALS = ['AbortController', 'structuredClone', 'queueMicrotask', 'globalThis.setTimeout']

const sourceRoots = ['src/modules/citationTally.ts', 'src/modules/citationAutoupdate.ts', 'src/modules/http.ts']

test('bundled sources do not reference globals missing from the plugin sandbox', () => {
  for (const relative of sourceRoots) {
    const source = readFileSync(resolve(import.meta.dirname, '..', relative), 'utf-8')
    for (const name of SANDBOX_ABSENT_GLOBALS) {
      // Ignore matches inside comments; a commented-out note is harmless.
      const offending = source
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
          return line.includes(name)
        })

      assert.deepEqual(
        offending.map(({ index }) => index + 1),
        [],
        `${relative} references ${name}, which is not available in the Zotero plugin sandbox`,
      )
    }
  }
})

test('HTTP helper uses Zotero.HTTP so it works without AbortController', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src/modules/http.ts'), 'utf-8')
  assert.ok(source.includes('Zotero.HTTP.request('), 'getJson should go through Zotero.HTTP.request')
})
