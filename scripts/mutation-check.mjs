// Mutation check: prove the contract tests actually guard the behaviour they
// claim to cover. Each mutation breaks one guarantee in a throwaway copy of the
// tree; the test suite must go red for it. A surviving mutation means the suite
// is decorative there.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')

/** Each mutation: file, the exact text to replace, its replacement, and what it undoes. */
const mutations = [
  {
    name: 'drop the client-abort check',
    file: 'index.js',
    from: 'if (signal.aborted || offset >= end) {',
    to: 'if (offset >= end) {',
    undoes: 'a cancelled client stops the read loop',
  },
  {
    name: 'drop the per-window version check',
    file: 'index.js',
    from: 'if (current === undefined || tagOf(current) !== expected) {',
    to: 'if (false) {',
    undoes: 'a file replaced mid-download aborts instead of mixing versions',
  },
  {
    name: 'drop header sanitization',
    file: 'index.js',
    from: `.replace(/["\\\\]/gu, '_')`,
    to: '',
    undoes: 'quotes and backslashes never reach Content-Disposition',
  },
  {
    name: 'swallow read errors instead of mapping them to a status',
    file: 'index.js',
    from: 'throw new ReadFailure(code)',
    to: 'return new Uint8Array()',
    undoes: 'an unreadable first window answers 403/404 rather than a dead 200',
  },
  {
    name: 'drop the If-Range validator comparison',
    file: 'index.js',
    from: `  if (header === null) return true
  return header.trim() === etag`,
    to: '  return header !== undefined',
    undoes: 'a stale If-Range restarts with the whole file',
  },
]

/** Run the suite in one tree. @param dir - tree root. @returns true when it passes. */
function passes(dir) {
  const result = spawnSync(process.execPath, ['test/route.test.mjs'], { cwd: dir, encoding: 'utf8' })
  return result.status === 0
}

const work = mkdtempSync(join(tmpdir(), 'fd-mutation-'))
let survived = 0
try {
  const control = join(work, 'control')
  cpSync(repo, control, { recursive: true, filter: source => !source.includes('/.git') })
  if (!passes(control)) {
    console.log('FAIL baseline suite does not pass; mutations would prove nothing')
    process.exit(2)
  }
  console.log('ok   baseline passes')
  mutations.forEach((mutation, index) => {
    const tree = join(work, `m${String(index + 1)}`)
    cpSync(control, tree, { recursive: true })
    const file = join(tree, mutation.file)
    const source = readFileSync(file, 'utf8')
    if (!source.includes(mutation.from)) {
      console.log(`FAIL mutation ${String(index + 1)} (${mutation.name}): anchor not found in ${mutation.file}`)
      survived += 1
      return
    }
    writeFileSync(file, source.replace(mutation.from, mutation.to))
    const green = passes(tree)
    if (green) {
      console.log(`FAIL mutation ${String(index + 1)} survived (${mutation.name}) — it undoes: ${mutation.undoes}`)
      survived += 1
      return
    }
    console.log(`ok   mutation ${String(index + 1)} caught (${mutation.name})`)
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(survived === 0 ? `\nall ${String(mutations.length)} mutations caught` : `\n${String(survived)} mutation(s) survived`)
process.exit(survived === 0 ? 0 : 1)
