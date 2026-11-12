import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
 * tests cannot catch the mistake; only the sandbox can. Scan every source file
 * that ends up in the bundle instead.
 */
const SANDBOX_ABSENT_GLOBALS = ['AbortController', 'structuredClone', 'queueMicrotask']

const srcDir = resolve(import.meta.dirname, '..', 'src')

function listSources(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSources(full))
    } else if (entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

function offendingLines(source: string, name: string): number[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const trimmed = line.trim()
      // Ignore comments; a note explaining the restriction is harmless.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
      return line.includes(name)
    })
    .map(({ index }) => index + 1)
}

test('bundled sources do not reference globals missing from the plugin sandbox', () => {
  const sources = listSources(srcDir)
  assert.ok(sources.length > 0, 'expected to find source files')

  for (const file of sources) {
    const source = readFileSync(file, 'utf-8')
    for (const name of SANDBOX_ABSENT_GLOBALS) {
      const lines = offendingLines(source, name)
      assert.deepEqual(lines, [], `${file} references ${name}, which is not available in the Zotero plugin sandbox`)
    }
  }
})

test('HTTP helper uses Zotero.HTTP so it works without AbortController', () => {
  const source = readFileSync(resolve(srcDir, 'modules/http.ts'), 'utf-8')
  assert.ok(source.includes('Zotero.HTTP.request('), 'getJson should go through Zotero.HTTP.request')
})
