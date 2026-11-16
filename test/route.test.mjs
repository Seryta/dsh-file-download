// Host-half contract tests for /api/file-download: drive the registered route
// handler against a filesystem-shaped fake backed by real file bytes, then
// assert the HTTP contract the browser and the shipped routes depend on.
import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'fdh-'))
const bigPath = join(root, 'big.apk')
const bigBytes = randomBytes(10 * 1024 * 1024 + 137)
writeFileSync(bigPath, bigBytes)
const tinyPath = join(root, 'tiny.apk')
writeFileSync(tinyPath, Buffer.from([1, 2, 3, 4]))
const emptyPath = join(root, 'empty.apk')
writeFileSync(emptyPath, Buffer.alloc(0))
const cjkPath = join(root, '安卓安装包.apk')
writeFileSync(cjkPath, bigBytes.subarray(0, 4096))
const newlinePath = join(root, 'bad\nname"quote\\slash.apk')
writeFileSync(newlinePath, bigBytes.subarray(0, 64))
const dirPath = join(root, 'folder')
mkdirSync(dirPath)

/**
 * Filesystem-shaped fake over real file bytes.
 * @param options - size reporting, version token, and failure/replacement injection.
 * @returns the fake plus counters the assertions read.
 */
function fakeFs(options = {}) {
  const {
    withSize = true,
    version = 'v1',
    failWindow = -1,
    failCode = 'FS_PERMISSION_DENIED',
    replaceAtWindow = -1,
  } = options
  const state = {
    windows: [],
    reads: 0,
    opened: 0,
    closed: 0,
    version,
    bytes: undefined,
    replaced: false,
  }
  return {
    ...state,
    get state() { return state },
    get windows() { return state.windows },
    get reads() { return state.reads },
    get opened() { return state.opened },
    get closed() { return state.closed },
    get replaced() { return state.replaced },
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      try {
        const fd = openSync(target.targetKey, 'r')
        state.opened += 1
        try {
          const info = fstatSync(fd)
          return {
            version: state.version,
            type: info.isDirectory() ? 'directory' : 'file',
            ...(withSize ? { size: state.bytes?.byteLength ?? info.size } : {}),
          }
        } finally {
          closeSync(fd)
          state.closed += 1
        }
      } catch { return undefined }
    },
    async readByteRange(target, { offset, length }) {
      if (state.reads === failWindow) {
        state.reads += 1
        throw Object.assign(new Error('injected read failure'), { code: failCode })
      }
      const source = state.replaced ? state.bytes : undefined
      const fd = openSync(target.targetKey, 'r')
      state.opened += 1
      state.reads += 1
      try {
        const size = fstatSync(fd).size
        const want = Math.max(0, Math.min(length, size - offset))
        if (want === 0) return new Uint8Array()
        const buffer = Buffer.allocUnsafe(want)
        const read = readSync(fd, buffer, 0, want, offset)
        state.windows.push({ offset, length })
        if (replaceAtWindow >= 0 && state.reads > replaceAtWindow && !state.replaced) {
          state.replaced = true
          state.bytes = randomBytes(size)
          state.version = `${version}-replaced`
        }
        return new Uint8Array(source === undefined ? buffer.subarray(0, read) : (() => {
          // After the swap, serve the replacement's bytes at the same offsets.
          const swapped = Buffer.allocUnsafe(read)
          source.copy(swapped, 0, offset, offset + read)
          return swapped
        })())
      } finally {
        closeSync(fd)
        state.closed += 1
      }
    },
  }
}

/** Register the plugin against a capturing context and return the route handler. */
function handlerWith(fs) {
  const routes = []
  apply({
    effect: (factory) => { factory(); return () => {} },
    connection: { fetch: { register: (route) => { routes.push(route); return async () => {} } } },
    fs,
  })
  if (routes.length !== 1) throw new Error(`expected one route, got ${routes.length}`)
  return routes[0]
}

const failures = []
function check(name, condition, detail) {
  if (condition) { console.log(`ok   ${name}`); return }
  failures.push(name)
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const request = (path, { method = 'GET', headers = {}, signal } = {}) => new Request(
  `http://dsh.internal/api/file-download?path=${encodeURIComponent(path)}`, { method, headers, ...(signal === undefined ? {} : { signal }) },
)
const md5 = (bytes) => createHash('md5').update(Buffer.from(bytes)).digest('hex')
const expected = md5(bigBytes)
const settle = async (promise, ms = 3000) => {
  let timer
  try {
    return await Promise.race([
      promise.then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// 1. complete file streams in bounded windows
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const response = await route.fetch(request(bigPath))
  const body = new Uint8Array(await response.arrayBuffer())
  check('GET full: status 200', response.status === 200, String(response.status))
  check('GET full: bytes match', md5(body) === expected)
  check('GET full: Content-Length', response.headers.get('content-length') === String(bigBytes.length), response.headers.get('content-length'))
  check('GET full: apk media type', response.headers.get('content-type') === 'application/vnd.android.package-archive', response.headers.get('content-type'))
  check('GET full: attachment disposition', response.headers.get('content-disposition')?.startsWith('attachment; filename="big.apk"') === true, response.headers.get('content-disposition'))
  check('GET full: proxy buffering opt-out', response.headers.get('x-accel-buffering') === 'no', response.headers.get('x-accel-buffering'))
  check('GET full: document sandbox header', response.headers.get('content-security-policy')?.includes('sandbox') === true, response.headers.get('content-security-policy'))
  check('GET full: windowed reads', fs.windows.length === Math.ceil(bigBytes.length / (4 * 1024 * 1024)), `pulls=${fs.windows.length}`)
  check('GET full: every window bounded', fs.windows.every(w => w.length <= 4 * 1024 * 1024))
  check('GET full: offsets advance', fs.windows.every((w, i) => w.offset === i * 4 * 1024 * 1024))
  check('GET full: no descriptor leak', fs.opened === fs.closed, `${fs.opened}/${fs.closed}`)
}

// 2. HEAD answers metadata only
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const response = await route.fetch(request(bigPath, { method: 'HEAD' }))
  check('HEAD: status 200', response.status === 200, String(response.status))
  check('HEAD: Content-Length', response.headers.get('content-length') === String(bigBytes.length))
  check('HEAD: reads nothing', fs.windows.length === 0 && fs.reads === 0, `reads=${fs.reads}`)
}

// 3. leading range
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const response = await route.fetch(request(bigPath, { headers: { range: 'bytes=0-1023' } }))
  const body = new Uint8Array(await response.arrayBuffer())
  check('Range 0-1023: status 206', response.status === 206, String(response.status))
  check('Range 0-1023: length', body.byteLength === 1024, String(body.byteLength))
  check('Range 0-1023: bytes', md5(body) === md5(bigBytes.subarray(0, 1024)))
  check('Range 0-1023: Content-Range', response.headers.get('content-range') === `bytes 0-1023/${String(bigBytes.length)}`, response.headers.get('content-range'))
}

// 4. suffix range, multi-range fallback, HEAD + Range
{
  const route = handlerWith(fakeFs())
  const suffix = await route.fetch(request(bigPath, { headers: { range: 'bytes=-256' } }))
  const suffixBody = new Uint8Array(await suffix.arrayBuffer())
  check('suffix range: 206 and bytes', suffix.status === 206 && md5(suffixBody) === md5(bigBytes.subarray(bigBytes.length - 256)), `${suffix.status}/${suffixBody.byteLength}`)

  const multi = await route.fetch(request(bigPath, { headers: { range: 'bytes=0-9,20-29' } }))
  const multiBody = new Uint8Array(await multi.arrayBuffer())
  check('multi range: falls back to the whole file', multi.status === 200 && multiBody.byteLength === bigBytes.length, `${multi.status}/${multiBody.byteLength}`)

  const headRange = await route.fetch(request(bigPath, { method: 'HEAD', headers: { range: 'bytes=1024-2047' } }))
  check('HEAD + Range: 206 without a body', headRange.status === 206 && headRange.headers.get('content-range') === `bytes 1024-2047/${String(bigBytes.length)}`, `${headRange.status}/${headRange.headers.get('content-range')}`)
  check('HEAD + Range: Content-Length is the window', headRange.headers.get('content-length') === '1024')
}

// 5. unsatisfiable range
{
  const route = handlerWith(fakeFs())
  const response = await route.fetch(request(bigPath, { headers: { range: `bytes=${String(bigBytes.length + 10)}-` } }))
  check('bad range: 416', response.status === 416, String(response.status))
  check('bad range: Content-Range', response.headers.get('content-range') === `bytes */${String(bigBytes.length)}`, response.headers.get('content-range'))
}

// 6. path validation
{
  const route = handlerWith(fakeFs())
  for (const [label, path] of [['missing', ''], ['relative', 'relative/file.apk'], ['nul', '/tmp/a\0b']]) {
    const response = await route.fetch(request(path))
    check(`path ${label}: 400`, response.status === 400, String(response.status))
  }
}

// 7. absent file, directory, filesystem error codes
{
  const route = handlerWith(fakeFs())
  check('absent file: 404', (await route.fetch(request(join(root, 'nope.apk')))).status === 404)
  check('directory: 403', (await route.fetch(request(dirPath))).status === 403)
  const denied = fakeFs()
  denied.resolve = async () => { throw Object.assign(new Error('denied'), { code: 'FS_PERMISSION_DENIED' }) }
  check('resolve permission: 403', (await handlerWith(denied).fetch(request(bigPath))).status === 403)
}

// 8. file names: non-ASCII, control characters, backslashes
{
  const route = handlerWith(fakeFs())
  const cjk = await route.fetch(request(cjkPath, { method: 'HEAD' }))
  const disposition = cjk.headers.get('content-disposition')
  check('cjk name: ascii fallback present', /filename="[^"]*\.apk"/u.test(disposition), disposition)
  check('cjk name: utf-8 form present', disposition?.includes(`filename*=UTF-8''${encodeURIComponent('安卓安装包.apk')}`) === true, disposition)

  const hostile = (await route.fetch(request(newlinePath, { method: 'HEAD' }))).headers.get('content-disposition')
  check('hostile name: no CR or LF in the header', hostile !== null && !/[\r\n]/u.test(hostile), hostile)
  check('hostile name: quotes and backslashes neutralized', hostile?.includes('filename="bad_name_quote_slash.apk"') === true, hostile)
  check('hostile name: utf-8 form keeps the real name', hostile?.includes(encodeURIComponent('bad\nname"quote\\slash.apk')) === true, hostile)

  const posixBackslash = join(root, 'a\\b.txt')
  writeFileSync(posixBackslash, Buffer.from('x'))
  const kept = (await handlerWith(fakeFs()).fetch(request(posixBackslash, { method: 'HEAD' }))).headers.get('content-disposition')
  check('posix backslash: name not truncated', kept?.includes(`filename*=UTF-8''${encodeURIComponent('a\\b.txt')}`) === true, kept)
}

// 9. zero-byte file
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const response = await route.fetch(request(emptyPath))
  const body = new Uint8Array(await response.arrayBuffer())
  check('empty file: 200 with no body', response.status === 200 && body.byteLength === 0 && response.headers.get('content-length') === '0', `${response.status}/${body.byteLength}`)
  check('empty file: HEAD 200', (await route.fetch(request(emptyPath, { method: 'HEAD' }))).status === 200)
}

// 10. validators
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const head = await route.fetch(request(bigPath, { method: 'HEAD' }))
  const etag = head.headers.get('etag')
  check('validator: quoted sha1 tag', etag !== null && /^"[0-9a-f]{40}"$/u.test(etag), String(etag))
  check('validator: no raw version material', etag !== null && !etag.includes('v1'))
  check('validator: stable across requests', (await route.fetch(request(bigPath, { method: 'HEAD' }))).headers.get('etag') === etag)
  check('validator: changes with the file version', (await handlerWith(fakeFs({ version: 'v2' })).fetch(request(bigPath, { method: 'HEAD' }))).headers.get('etag') !== etag)

  const resume = await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': etag } }))
  const tail = new Uint8Array(await resume.arrayBuffer())
  check('resume: matching If-Range answers 206', resume.status === 206, String(resume.status))
  check('resume: remaining bytes only', tail.byteLength === bigBytes.length - 1048576, String(tail.byteLength))
  check('resume: remainder bytes correct', md5(tail) === md5(bigBytes.subarray(1048576)))

  for (const [label, header] of [['stale', '"stale-version"'], ['date form', 'Wed, 21 Oct 2015 07:28:00 GMT'], ['weak', `W/${String(etag)}`]]) {
    const response = await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': header } }))
    const body = new Uint8Array(await response.arrayBuffer())
    check(`resume: ${label} If-Range answers 200 full`, response.status === 200 && md5(body) === expected, `${response.status}/${body.byteLength}`)
  }

  const first = new Uint8Array(await (await route.fetch(request(bigPath, { headers: { range: 'bytes=0-1048575' } }))).arrayBuffer())
  const rest = new Uint8Array(await (await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': etag } }))).arrayBuffer())
  const joined = new Uint8Array(first.byteLength + rest.byteLength)
  joined.set(first)
  joined.set(rest, first.byteLength)
  check('resume: two-part assembly matches the file', md5(joined) === expected, `${first.byteLength}+${rest.byteLength}`)
}

// 11. a backend without a declared size streams, offers no ranges, and ignores Range
{
  const fs = fakeFs({ withSize: false })
  const route = handlerWith(fs)
  const head = await route.fetch(request(bigPath, { method: 'HEAD' }))
  check('unknown size: no Content-Length', head.headers.get('content-length') === null)
  check('unknown size: no Accept-Ranges', head.headers.get('accept-ranges') === null)
  check('unknown size: ETag present', head.headers.get('etag') !== null)
  const ranged = await route.fetch(request(bigPath, { headers: { range: 'bytes=0-1023' } }))
  const body = new Uint8Array(await ranged.arrayBuffer())
  check('unknown size: Range ignored, whole file answered', ranged.status === 200 && md5(body) === expected, `${ranged.status}/${body.byteLength}`)
}

// 12. a file that cannot be opened is answered as a status, never as a dead 200
{
  const denied = fakeFs({ failWindow: 0, failCode: 'FS_PERMISSION_DENIED' })
  const response = await handlerWith(denied).fetch(request(bigPath))
  check('first window denied: 403 (not 200)', response.status === 403, String(response.status))
  const missing = fakeFs({ failWindow: 0, failCode: 'FS_NOT_FOUND' })
  check('first window vanished: 404', (await handlerWith(missing).fetch(request(bigPath))).status === 404)
}

// 13. a failure after the first window terminates the response instead of hanging
{
  const route = handlerWith(fakeFs({ failWindow: 2 }))
  const response = await route.fetch(request(bigPath))
  const outcome = await settle(response.arrayBuffer())
  check('mid-stream read failure: response rejects', outcome === 'rejected', outcome)
}

// 14. a file replaced mid-download can never mix versions into one body
{
  const fs = fakeFs({ replaceAtWindow: 1 })
  const route = handlerWith(fs)
  const response = await route.fetch(request(bigPath))
  // A mixed body would resolve; the version check must make it reject instead.
  const outcome = await response.arrayBuffer().then(() => 'resolved', () => 'rejected')
  check('replaced file: response rejects instead of delivering a mixed body', outcome === 'rejected', outcome)
  check('replaced file: the change was actually served once', fs.replaced === true, String(fs.replaced))
}

// 15. an aborted client stops the read loop (driven through the body itself, so
// the assertion does not depend on the fetch implementation cancelling for us)
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const controller = new AbortController()
  const response = await route.fetch(request(bigPath, { signal: controller.signal }))
  const reader = response.body.getReader()
  await reader.read()
  const before = fs.reads
  controller.abort()
  const next = await reader.read()
  check('abort: stream ends without another window', next.done === true, JSON.stringify(next.done))
  check('abort: no further reads after cancellation', fs.reads === before, `${before} -> ${fs.reads}`)
}

// 16. two downloads may run at once without sharing state
{
  const route = handlerWith(fakeFs())
  const [left, right] = await Promise.all([
    route.fetch(request(bigPath)).then(r => r.arrayBuffer()).then(b => md5(new Uint8Array(b))),
    route.fetch(request(tinyPath)).then(r => r.arrayBuffer()).then(b => md5(new Uint8Array(b))),
  ])
  check('concurrent: both bodies correct', left === expected && right === md5(Buffer.from([1, 2, 3, 4])), `${left}/${right}`)
}

// 17. Empty suffix ranges must not manufacture a negative last-byte position.
{
  for (const method of ['GET', 'HEAD']) {
    const response = await handlerWith(fakeFs()).fetch(request(emptyPath, { method, headers: { range: 'bytes=-1' } }))
    check(`empty suffix ${method}: 416 with a valid Content-Range`, response.status === 416 && response.headers.get('content-range') === 'bytes */0', `${response.status}/${response.headers.get('content-range')}`)
  }
}

// 18. RFC 5987 attr-char excludes apostrophes, parentheses and asterisks.
{
  const path = join(root, "O'Reilly(中文)*.pdf")
  writeFileSync(path, 'pdf')
  const response = await handlerWith(fakeFs()).fetch(request(path, { method: 'HEAD' }))
  const value = response.headers.get('content-disposition')
  check('filename*: special characters are percent-encoded', value?.includes("filename*=UTF-8''O%27Reilly%28%E4%B8%AD%E6%96%87%29%2A.pdf") === true, value)
}

// 19. Unknown-size providers have the same first-read failure contract.
{
  for (const [code, status] of [['FS_PERMISSION_DENIED', 403], ['FS_NOT_FOUND', 404], ['FS_ABORTED', 499]]) {
    const fs = fakeFs({ withSize: false, failWindow: 0, failCode: code })
    const outcome = await handlerWith(fs).fetch(request(bigPath)).then(r => r.status, e => e.name)
    check(`unknown size first read ${code}: HTTP ${status}`, outcome === status, String(outcome))
  }
}

// 20. EOF is data too: validate its version before closing an unbounded body.
{
  const fs = fakeFs({ withSize: false })
  const read = fs.readByteRange.bind(fs)
  fs.readByteRange = async (...args) => {
    if (args[1].offset >= 4 * 1024 * 1024) {
      fs.state.version = 'truncated'
      return new Uint8Array()
    }
    return read(...args)
  }
  const response = await handlerWith(fs).fetch(request(bigPath))
  const outcome = await settle(response.arrayBuffer())
  check('unknown size changed at EOF: rejects instead of succeeding with a prefix', outcome === 'rejected', outcome)
}

// 21. A zero-length read before a declared end is not a successful completion.
{
  const fs = fakeFs()
  const read = fs.readByteRange.bind(fs)
  fs.readByteRange = async (...args) => args[1].offset >= 4 * 1024 * 1024 ? new Uint8Array() : read(...args)
  const response = await handlerWith(fs).fetch(request(bigPath))
  const outcome = await settle(response.arrayBuffer())
  check('premature EOF: rejects even if a provider keeps its version token', outcome === 'rejected', outcome)
}

// 22. Capability discovery needs a positive marker, including on the pathless probe.
{
  const route = handlerWith(fakeFs())
  const response = await route.fetch(new Request('http://dsh.internal/api/file-download', { method: 'HEAD' }))
  check('capability: pathless HEAD carries the route marker', response.status === 400 && response.headers.get('x-dsh-file-download') === '1')
}

/** Local-provider shape, with genuine inode and freshness metadata. */
function localFs() {
  const fallback = fakeFs()
  return {
    ...fallback,
    async resolve(path) { return { targetKey: realpathSync(path), displayPath: path } },
    processPath(target) { return target.targetKey },
    processPathFromHostPath(path) { return path },
    async stat(target) {
      const info = statSync(target.targetKey, { bigint: true })
      return { type: info.isFile() ? 'file' : 'directory', version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, size: Number(info.size) }
    },
  }
}

// 23. Reversibly switching the containing directory defeats a path-only stat.
{
  const home = join(root, 'live')
  const other = join(root, 'other')
  const parked = join(root, 'parked')
  mkdirSync(home)
  mkdirSync(other)
  const path = join(home, 'payload.bin')
  const original = Buffer.alloc(8 * 1024 * 1024, 0xaa)
  writeFileSync(path, original)
  writeFileSync(join(other, 'payload.bin'), Buffer.alloc(original.length, 0x55))
  const fs = localFs()
  const stat = fs.stat.bind(fs)
  let checks = 0
  let switched = false
  let restored = false
  fs.stat = async target => {
    checks += 1
    if (checks === 3) {
      renameSync(home, other)
      renameSync(parked, home)
      restored = true
    }
    const info = await stat(target)
    if (checks === 2) {
      renameSync(home, parked)
      renameSync(other, home)
      switched = true
    }
    return info
  }
  const response = await handlerWith(fs).fetch(request(path))
  const result = await response.arrayBuffer().then(bytes => Buffer.from(bytes), () => undefined)
  check('directory rollback: fixture really switched and restored the directory', switched && restored)
  check('directory rollback: never succeeds with mixed bytes', response.status >= 400 || result === undefined || result.equals(original), result === undefined ? 'rejected' : md5(result))
}

// 24. A native handle must remain bounded and close on normal completion/cancel/abort.
if (process.platform === 'linux') {
  const count = () => readdirSync('/proc/self/fd').length
  const before = count()
  await (await handlerWith(localFs()).fetch(request(bigPath))).arrayBuffer()
  check('local reader: completion closes its handle', count() === before, `${before} -> ${count()}`)
  const cancelled = await handlerWith(localFs()).fetch(request(bigPath))
  await cancelled.body.cancel()
  check('local reader: cancellation closes its handle', count() === before, `${before} -> ${count()}`)
  const controller = new AbortController()
  const aborted = await handlerWith(localFs()).fetch(request(bigPath, { signal: controller.signal }))
  controller.abort()
  await aborted.body.cancel()
  check('local reader: abort closes its handle', count() === before, `${before} -> ${count()}`)
}

// 25. Host path sharing must not bypass a provider's independent read policy.
{
  const fs = localFs()
  fs.readByteRange = async () => { throw Object.assign(new Error('policy denied'), { code: 'FS_SANDBOX_DENIED' }) }
  const response = await handlerWith(fs).fetch(request(bigPath))
  check('local reader: provider read policy still answers 403', response.status === 403, String(response.status))
}

// 26. A process path without a same-host mapping must never be opened on this host.
{
  const fs = fakeFs()
  fs.processPath = () => '/not-a-shared-host-file.bin'
  fs.processPathFromHostPath = () => undefined
  const response = await handlerWith(fs).fetch(request(bigPath))
  const bytes = new Uint8Array(await response.arrayBuffer())
  check('remote provider: no unproven host open', response.status === 200 && md5(bytes) === expected)
}

// 27. An ABA change inside a provider read must disagree with the pinned fd.
{
  const live = join(root, 'window-live')
  const other = join(root, 'window-other')
  const parked = join(root, 'window-parked')
  mkdirSync(live)
  mkdirSync(other)
  const path = join(live, 'payload.bin')
  const original = Buffer.alloc(8 * 1024 * 1024, 0xaa)
  writeFileSync(path, original)
  writeFileSync(join(other, 'payload.bin'), Buffer.alloc(original.length, 0x55))
  const fs = localFs()
  const read = fs.readByteRange.bind(fs)
  let swapped = false
  fs.readByteRange = async (target, range, signal) => {
    if (range.offset !== 4 * 1024 * 1024 || swapped) return read(target, range, signal)
    renameSync(live, parked)
    renameSync(other, live)
    try {
      const bytes = await read(target, range, signal)
      swapped = true
      return bytes
    } finally {
      renameSync(live, other)
      renameSync(parked, live)
    }
  }
  const response = await handlerWith(fs).fetch(request(path))
  const result = await response.arrayBuffer().then(bytes => Buffer.from(bytes), () => undefined)
  check('local provider ABA: change actually occurred within the read', swapped)
  check('local provider ABA: mismatched pinned bytes reject the body', result === undefined, result === undefined ? 'rejected' : md5(result))
}

// 28. The first opened object, not an earlier path stat, owns the native ETag.
{
  const live = join(root, 'open-live')
  const other = join(root, 'open-other')
  const parked = join(root, 'open-parked')
  mkdirSync(live)
  mkdirSync(other)
  const path = join(live, 'payload.bin')
  const original = Buffer.alloc(1024, 0xaa)
  const replacement = Buffer.alloc(2048, 0x55)
  writeFileSync(path, original)
  writeFileSync(join(other, 'payload.bin'), replacement)
  const oldTag = (await handlerWith(localFs()).fetch(request(path, { method: 'HEAD' }))).headers.get('etag')
  const fs = localFs()
  const read = fs.readByteRange.bind(fs)
  let swapped = false
  let restored = false
  fs.processPath = target => {
    renameSync(live, parked)
    renameSync(other, live)
    swapped = true
    return target.targetKey
  }
  fs.readByteRange = async (...args) => {
    const bytes = await read(...args)
    if (swapped && !restored) {
      renameSync(live, other)
      renameSync(parked, live)
      restored = true
    }
    return bytes
  }
  const response = await handlerWith(fs).fetch(request(path))
  const bytes = Buffer.from(await response.arrayBuffer())
  check('first-open race: fixture swapped before open and restored after read', swapped && restored)
  check('first-open race: successful body is the opened object', response.status === 200 && bytes.equals(replacement))
  check('first-open race: Content-Length belongs to the opened object', response.headers.get('content-length') === String(replacement.length))
  check('first-open race: replacement never carries the old ETag', response.headers.get('etag') !== oldTag)
}

// 29. The native ETag is stable across HEAD/GET and supports real ranged assembly.
{
  const route = handlerWith(localFs())
  const tag = (await route.fetch(request(bigPath, { method: 'HEAD' }))).headers.get('etag')
  const resumed = await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': tag } }))
  const bytes = new Uint8Array(await resumed.arrayBuffer())
  check('local resume: stable validator and correct ranged bytes', resumed.status === 206 && resumed.headers.get('etag') === tag && md5(bytes) === md5(bigBytes.subarray(1048576)))
}

// 30. Consumer cancellation must reach an already-running provider read.
for (const local of [false, true]) {
  const fs = local ? localFs() : fakeFs()
  const read = fs.readByteRange.bind(fs)
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  let cancelled = false
  fs.readByteRange = async (target, range, signal) => {
    if (range.offset === 0) return read(target, range, signal)
    entered()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        cancelled = true
        reject(Object.assign(new Error('cancelled'), { code: 'FS_ABORTED' }))
      }, { once: true })
    })
  }
  const response = await handlerWith(fs).fetch(request(bigPath))
  const reader = response.body.getReader()
  await reader.read()
  const next = reader.read()
  await waiting
  await reader.cancel()
  check(`${local ? 'local' : 'abstract'} cancellation: in-flight provider read receives abort`, cancelled)
  check(`${local ? 'local' : 'abstract'} cancellation: pending consumer ends cleanly`, (await next).done === true)
}

// 31. Policy may deny a later window; native pinning never bypasses it.
{
  const fs = localFs()
  const read = fs.readByteRange.bind(fs)
  fs.readByteRange = async (target, range, signal) => {
    if (range.offset > 0) throw Object.assign(new Error('policy changed'), { code: 'FS_SANDBOX_DENIED' })
    return read(target, range, signal)
  }
  const response = await handlerWith(fs).fetch(request(bigPath))
  check('local reader: later provider policy denial rejects the body', (await settle(response.arrayBuffer())) === 'rejected')
}

// 32. Backpressure must not hold the handle after an abort with no more reads.
if (process.platform === 'linux') {
  const count = () => readdirSync('/proc/self/fd').length
  const before = count()
  const fs = localFs()
  const stat = fs.stat.bind(fs)
  let validated
  const ready = new Promise(resolve => { validated = resolve })
  let checks = 0
  fs.stat = async (...args) => {
    const info = await stat(...args)
    if (++checks === 3) validated()
    return info
  }
  const controller = new AbortController()
  const response = await handlerWith(fs).fetch(request(bigPath, { signal: controller.signal }))
  await ready
  // The pending first window's final metadata check is complete; let its
  // enqueue finish so highWaterMark backpressure prevents any further pull.
  await new Promise(resolve => setImmediate(resolve))
  check('local idle abort: a pinned handle is held while the queue is full', count() === before + 1)
  controller.abort()
  const deadline = Date.now() + 2000
  while (count() !== before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  check('local idle abort: closes without reader.cancel or further consumption', count() === before)
  // Keep the Response alive until after checking, so GC cannot provide cleanup.
  check('local idle abort: response remained unconsumed', response.body.locked === false)
}

rmSync(root, { recursive: true, force: true })
console.log(failures.length === 0 ? `\nall host-route checks passed (${String(0)} failed)` : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
