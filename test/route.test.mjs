// Host-half contract test for /api/file-download: run the registered route
// handler against a filesystem-shaped fake backed by real file bytes.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, openSync, fstatSync, closeSync, readSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'fdh-'))
const bigPath = join(root, 'big.apk')
const bigBytes = randomBytes(10 * 1024 * 1024 + 137)
writeFileSync(bigPath, bigBytes)
const cjkPath = join(root, '安卓安装包.apk')
writeFileSync(cjkPath, bigBytes.subarray(0, 4096))
const dirPath = join(root, 'folder')
mkdirSync(dirPath)

/** Filesystem-shaped fake: real bytes, real windows, recorded request sizes. */
function fakeFs({ withSize = true, version = 'v1' } = {}) {
  const windows = []
  return {
    windows,
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      try {
        const info = fstatSync(openSync(target.targetKey, 'r'))
        return { version, type: info.isDirectory() ? 'directory' : 'file', ...(withSize ? { size: info.size } : {}) }
      } catch { return undefined }
    },
    async readByteRange(target, { offset, length }) {
      windows.push({ offset, length })
      const fd = openSync(target.targetKey, 'r')
      try {
        const size = fstatSync(fd).size
        const want = Math.max(0, Math.min(length, size - offset))
        if (want === 0) return new Uint8Array()
        const buffer = Buffer.allocUnsafe(want)
        const read = readSync(fd, buffer, 0, want, offset)
        return new Uint8Array(buffer.subarray(0, read))
      } finally { closeSync(fd) }
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
  check('GET full: proxy buffering opt-out', response.headers.get('x-accel-buffering') === 'no', response.headers.get('x-accel-buffering'))
  check('GET full: attachment disposition', response.headers.get('content-disposition')?.startsWith('attachment; filename="big.apk"') === true, response.headers.get('content-disposition'))
  check('GET full: windowed reads', fs.windows.length === Math.ceil(bigBytes.length / (4 * 1024 * 1024)), `pulls=${fs.windows.length}`)
  check('GET full: every window bounded', fs.windows.every(w => w.length <= 4 * 1024 * 1024))
  check('GET full: offsets advance', fs.windows.every((w, i) => w.offset === i * 4 * 1024 * 1024))
}

// 2. HEAD answers metadata only
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const response = await route.fetch(request(bigPath, { method: 'HEAD' }))
  check('HEAD: status 200', response.status === 200, String(response.status))
  check('HEAD: Content-Length', response.headers.get('content-length') === String(bigBytes.length))
  check('HEAD: reads nothing', fs.windows.length === 0, `pulls=${fs.windows.length}`)
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

// 4. suffix range
{
  const route = handlerWith(fakeFs())
  const response = await route.fetch(request(bigPath, { headers: { range: 'bytes=-256' } }))
  const body = new Uint8Array(await response.arrayBuffer())
  check('suffix range: 206 and bytes', response.status === 206 && md5(body) === md5(bigBytes.subarray(bigBytes.length - 256)), `${response.status}/${body.byteLength}`)
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
  check('permission: 403', (await handlerWith(denied).fetch(request(bigPath))).status === 403)
}

// 8. non-ASCII name keeps an RFC 5987 form
{
  const route = handlerWith(fakeFs())
  const response = await route.fetch(request(cjkPath, { method: 'HEAD' }))
  const disposition = response.headers.get('content-disposition')
  check('cjk name: ascii fallback present', /filename="[^"]*\.apk"/u.test(disposition), disposition)
  check('cjk name: utf-8 form present', disposition?.includes(`filename*=UTF-8''${encodeURIComponent('安卓安装包.apk')}`) === true, disposition)
}

// 9. client disconnect settles the stream
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const controller = new AbortController()
  const response = await route.fetch(request(bigPath, { signal: controller.signal }))
  controller.abort()
  let settled = false
  const timer = new Promise(resolve => setTimeout(resolve, 3000))
  const attempt = (async () => {
    try { await response.arrayBuffer() } catch { /* aborted */ }
    settled = true
  })()
  await Promise.race([attempt, timer])
  check('abort: stream settles without hanging', settled)
}

// 10. a backend without a declared size still streams the whole file
{
  const route = handlerWith(fakeFs({ withSize: false }))
  const response = await route.fetch(request(bigPath))
  const body = new Uint8Array(await response.arrayBuffer())
  check('unknown size: 200 without Content-Length', response.status === 200 && response.headers.get('content-length') === null, `${response.status}/${response.headers.get('content-length')}`)
  check('unknown size: bytes match', md5(body) === expected)
}

// 11. resume protocol: ETag validation, If-Range match, and a real two-part resume
{
  const fs = fakeFs()
  const route = handlerWith(fs)
  const head = await route.fetch(request(bigPath, { method: 'HEAD' }))
  const etag = head.headers.get('etag')
  check('validator: quoted ETag present', etag !== null && /^".+"$/u.test(etag), String(etag))
  check('validator: single line', etag !== null && !/[\r\n]/u.test(etag))
  check('validator: stable across requests', (await route.fetch(request(bigPath, { method: 'HEAD' }))).headers.get('etag') === etag)
  check('validator: changes with the file version', (await handlerWith(fakeFs({ version: 'v2' })).fetch(request(bigPath, { method: 'HEAD' }))).headers.get('etag') !== etag)

  const resume = await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': etag } }))
  const tail = new Uint8Array(await resume.arrayBuffer())
  check('resume: matching If-Range answers 206', resume.status === 206, String(resume.status))
  check('resume: remaining bytes only', tail.byteLength === bigBytes.length - 1048576, String(tail.byteLength))
  check('resume: remainder bytes correct', md5(tail) === md5(bigBytes.subarray(1048576)))

  const stale = await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': '"stale-version"' } }))
  const whole = new Uint8Array(await stale.arrayBuffer())
  check('resume: stale If-Range answers 200', stale.status === 200, String(stale.status))
  check('resume: stale If-Range sends the whole file', md5(whole) === expected)

  // The exact exchange a browser performs: first part, then the rest with If-Range.
  const first = new Uint8Array(await (await route.fetch(request(bigPath, { headers: { range: 'bytes=0-1048575' } }))).arrayBuffer())
  const rest = new Uint8Array(await (await route.fetch(request(bigPath, { headers: { range: 'bytes=1048576-', 'if-range': etag } }))).arrayBuffer())
  const joined = new Uint8Array(first.byteLength + rest.byteLength)
  joined.set(first)
  joined.set(rest, first.byteLength)
  check('resume: two-part assembly matches the file', md5(joined) === expected, `${first.byteLength}+${rest.byteLength}`)
}

// 12. a backend without a size still carries its validator
{
  const route = handlerWith(fakeFs({ withSize: false }))
  const response = await route.fetch(request(bigPath, { method: 'HEAD' }))
  check('unknown size: ETag present', response.headers.get('etag') !== null)
}

rmSync(root, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nall host-route checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
