/**
 * Cross-platform replacement for `rm -rf .yarn node_modules yarn.lock .scaffold tsconfig.tsbuildinfo`.
 * Only removes paths inside this repository.
 *
 * Usage: node utils/scrub.mjs
 */

import console from 'node:console'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = ['.yarn', 'node_modules', 'yarn.lock', '.scaffold', 'tsconfig.tsbuildinfo']

for (const target of targets) {
  rmSync(resolve(root, target), { recursive: true, force: true })
  console.log(`Removed ${target}`)
}

console.log('Run `yarn install` to restore the toolchain.')
