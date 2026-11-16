// Each mutation breaks one observable guarantee. It must fail the behavioural
// suite in an isolated copy; a surviving mutation is a missing regression guard.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const mutations = [
  {
    name: 'drop the client-abort check',
    edits: [{ from: 'if (signal.aborted || offset >= end) {', to: 'if (offset >= end) {' }],
  },
  {
    name: 'drop the provider-version check',
    edits: [{ from: "if (current === undefined || tagOf(current) !== expected) throw new ReadFailure('FILE_CHANGED')", to: 'void current' }],
  },
  {
    name: 'drop quoted filename sanitization',
    edits: [{ from: `.replace(/["\\\\]/gu, '_')`, to: '' }],
  },
  {
    name: 'swallow first-window read failures',
    edits: [{ from: 'throw new ReadFailure(code)', to: 'return new Uint8Array()' }],
  },
  {
    name: 'ignore the If-Range validator',
    edits: [{ from: `  if (header === null) return true
  return header.trim() === etag`, to: '  return header !== undefined' }],
  },
  {
    name: 'turn a mid-stream failure into normal EOF',
    edits: [{ from: 'controller.error(error)', to: 'controller.close()' }],
  },
  {
    name: 'disable native handle binding',
    edits: [{ from: 'if (hostPath === undefined) return reader', to: 'return reader' }],
  },
  {
    name: 'allow provider bytes that disagree with the pinned object',
    edits: [{ from: "if (total !== bytes.byteLength || !pinned.subarray(0, total).equals(bytes)) throw new ReadFailure('FILE_CHANGED')", to: 'void pinned' }],
  },
  {
    name: 'drop RFC 5987 special-character encoding',
    edits: [{ from: ".replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)", to: '' }],
  },
  {
    name: 'skip version validation for an empty window',
    edits: [
      { from: '      await check()\n      return bytes', to: '      if (bytes.byteLength > 0) await check()\n      return bytes' },
      { from: '        await reader.check()', to: '        if (bytes.byteLength > 0) await reader.check()' },
    ],
  },
]

function runSuite(dir) {
  return spawnSync(process.execPath, ['test/route.test.mjs'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
}

const work = mkdtempSync(join(tmpdir(), 'fd-mutation-'))
let survived = 0
try {
  const control = join(work, 'control')
  cpSync(repo, control, { recursive: true, filter: source => !source.includes('/.git') && !source.includes('/node_modules') })
  const baseline = runSuite(control)
  if (baseline.status !== 0) throw new Error(`baseline did not pass: ${baseline.error ?? baseline.stderr}\n${baseline.stdout.slice(-4000)}`)
  console.log('ok   baseline passes')
  mutations.forEach((mutation, index) => {
    const tree = join(work, `m${index + 1}`)
    cpSync(control, tree, { recursive: true })
    const file = join(tree, 'index.js')
    let source = readFileSync(file, 'utf8')
    for (const edit of mutation.edits) {
      if (!source.includes(edit.from)) throw new Error(`mutation ${index + 1} (${mutation.name}): anchor not found`)
      source = source.replace(edit.from, edit.to)
    }
    writeFileSync(file, source)
    const result = runSuite(tree)
    if (result.error !== undefined) throw result.error
    if (result.status === 0) {
      console.log(`FAIL mutation ${index + 1} survived (${mutation.name})`)
      survived += 1
    } else {
      console.log(`ok   mutation ${index + 1} caught (${mutation.name})`)
    }
  })
} catch (error) {
  console.error(error)
  process.exitCode = 2
} finally {
  // work is the exact absolute directory returned by our mkdtemp, never a caller path.
  if (resolve(work) !== work || !work.startsWith(join(tmpdir(), 'fd-mutation-'))) throw new Error('unexpected mutation workspace')
  rmSync(work, { recursive: true, force: true })
}
if (process.exitCode !== 2) {
  console.log(survived === 0 ? `\nall ${mutations.length} mutations caught` : `\n${survived} mutation(s) survived`)
  process.exitCode = survived === 0 ? 0 : 1
}
