// Contract for the Loader row this package contributes.
//
// A bundle layer *inserts* its row. A bare `- id: auto-continue` row is an
// override: with no layer defining that entry, composition skips it — the
// diagnostics read `patch: entry "auto-continue" not found` and the composed
// entry list simply does not contain the plugin, so `apply()` never runs. That
// is exactly how 0.1.0 shipped without ever taking effect, and because cordis
// has no stdout exporter the warning was invisible. Hence this guard.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { name as hostName } from '../index.js'

const root = new URL('../', import.meta.url)
const raw = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/** The config keys this plugin accepts; index.js throws loudly on anything else. */
const CONFIG_KEYS = ['enabled', 'codes', 'maxContinues', 'delaysMs', 'skipActiveGoal']

/** Comments and blank lines carry no structure; keep every other line verbatim. */
const lines = raw
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))

/** Column-zero `- ` items: the patch list's own rows. */
const topLevel = lines.filter((line) => line.startsWith('- '))

test('the patch inserts its row rather than overriding one', () => {
  assert.deepEqual(
    topLevel,
    ['- insert:'],
    'a bare `- id:` row patches an entry no layer defines and is skipped silently',
  )
  assert.ok(
    !/^- id:/m.test(raw),
    'a top-level `- id:` row is the override form that never mounted this plugin',
  )
})

test('the inserted row carries this package name and the host half name', () => {
  const row = lines.filter((line) => /^\s+- id:/.test(line))
  assert.equal(row.length, 1, 'exactly one row: this plugin mounts once')
  assert.equal(row[0].trim(), `- id: ${hostName}`)

  const declared = lines.filter((line) => /^\s+name:/.test(line))
  assert.equal(declared.length, 1)
  assert.equal(declared[0].trim(), `name: ${pkg.name}`)
})

test('the row config sets exactly the documented keys', () => {
  const configAt = lines.findIndex((line) => /^\s+config:\s*$/.test(line))
  assert.notEqual(configAt, -1, 'the row carries its default policy')

  const indent = lines[configAt].search(/\S/)
  const keys = []
  for (const line of lines.slice(configAt + 1)) {
    const own = line.search(/\S/)
    if (own <= indent) break
    if (own === indent + 2) keys.push(line.trim().split(':', 1)[0])
  }
  assert.deepEqual(keys, CONFIG_KEYS)
})

test('the bundle patch this package declares is the file under test', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})
