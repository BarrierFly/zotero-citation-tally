/**
 * Cross-platform replacement for the old `NODE_ENV=... prettier ... && eslint ...`
 * scripts. Windows `cmd.exe` does not understand the `VAR=value command` prefix,
 * and `cross-env` is not a dependency.
 *
 * Usage: node utils/lint.mjs <production|development|repo> <check|write>
 */

import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const [mode = 'production', action = 'check'] = process.argv.slice(2)
const fix = action === 'write'
const env = { ...process.env, NODE_ENV: mode }

function run(label, args) {
  console.log(`\n> ${label}`)
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

run('prettier', [
  'node_modules/prettier/bin/prettier.cjs',
  '--config',
  'prettier.config.mjs',
  fix ? '--write' : '--check',
  '.',
])

run('eslint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.config.mjs', ...(fix ? ['--fix'] : []), '.'])
