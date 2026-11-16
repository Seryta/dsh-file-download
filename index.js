/**
 * Host half: an authenticated streaming download route for original file bytes.
 *
 * `GET /api/file-download?path=<absolute>` answers the file's bytes with
 * `Content-Disposition: attachment`, so the browser's own download manager
 * performs the transfer — no client memory, no size cap, real progress, and
 * resume through `Range` plus a per-version `ETag` / `If-Range` validator.
 *
 * The first window is read and validated before any success header is written.
 * Host-shared files keep one open handle; provider-authorized windows must match
 * that handle, and its own metadata supplies the response identity. EOF is also
 * validated. Abstract backends retain their opaque version checks: a stronger
 * atomic snapshot guarantee requires support in the backend's byte-read API.
 *
 * The connection service authenticates the request before this handler runs and
 * supplies `ctx.fs`; paths and media types do not restrict access, exactly like
 * the shipped `/api/file` route, but this route has no image-limit cap and
 * streams instead of buffering.
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** The route this plugin owns. */
const ROUTE = '/api/file-download'
/** Bytes pulled per stream pull and per version check; the Host's resident bound. */
const WINDOW = 4 * 1024 * 1024
/** POSIX file names may contain a backslash; only Windows treats it as a separator. */
const WINDOWS_SEPARATORS = process.platform === 'win32'

/** Media types worth stating for package and archive downloads; anything else is a generic binary. */
const MEDIA_TYPES = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  ipa: 'application/octet-stream',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-redhat-package-manager',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msdownload',
  dmg: 'application/x-apple-diskimage',
  iso: 'application/x-iso9660-image',
  img: 'application/octet-stream',
  zip: 'application/zip',
  jar: 'application/java-archive',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  xz: 'application/x-xz',
  zst: 'application/zstd',
  tar: 'application/x-tar',
  pdf: 'application/pdf',
}

/** Codes the filesystem raises, mapped onto the HTTP answer the client reads. */
const STATUS_BY_CODE = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_ABORTED: 499,
  FILE_CHANGED: 409,
}

/** A failed read answered as a plain status instead of an unreadable body. */
class ReadFailure extends Error {
  /**
   * @param code - filesystem code, or an empty string for an unexpected failure.
   */
  constructor(code) {
    super(code.length === 0 ? 'read failed' : code)
    this.name = 'ReadFailure'
    this.status = STATUS_BY_CODE[code] ?? 500
  }
}

/**
 * The last path segment of the separators this platform treats as separators.
 * @param path - absolute Host path.
 * @returns the file name the browser saves.
 */
function fileNameOf(path) {
  let at = path.lastIndexOf('/')
  if (WINDOWS_SEPARATORS) at = Math.max(at, path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}

/**
 * The lowercased suffix after the last dot, when there is one.
 * @param name - file name.
 * @returns the suffix without a dot, or an empty string.
 */
function extensionOf(name) {
  const at = name.lastIndexOf('.')
  return at < 0 || at === name.length - 1 ? '' : name.slice(at + 1).toLowerCase()
}

/**
 * `Content-Disposition` keeping an ASCII-safe fallback and the exact UTF-8 name.
 * Control characters (including CR and LF) never reach the header.
 * @param name - original file name, possibly non-ASCII.
 * @returns the header value.
 */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * One strong validator for a filesystem version. `FsVersion` is opaque, so it is
 * digested rather than exposed: the tag reveals nothing about the path.
 * @param version - opaque filesystem version token.
 * @param size - declared byte size, or undefined when the backend omits it.
 * @returns the quoted entity tag.
 */
function entityTag(version, size) {
  return `"${createHash('sha1').update(`${version}:${size === undefined ? '' : String(size)}`).digest('hex')}"`
}

/**
 * The `ETag`-comparable identity of one observed file state.
 * @param info - filesystem metadata of the file right now.
 * @returns its entity tag.
 */
function tagOf(info) {
  return entityTag(info.version, info.size)
}

/**
 * One byte range requested by the browser.
 * @param header - the `Range` header, when present.
 * @param size - complete file size.
 * @returns the range to serve, `null` for the whole file, or `'unsatisfiable'`.
 */
function requestedRange(header, size) {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return null
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return null
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * Whether a ranged request may use its `Range` header: RFC 7233 requires the
 * `If-Range` validator to match exactly, and an absent header leaves it in force.
 * @param header - the request's `If-Range` value, when present.
 * @param etag - this response's entity tag.
 * @returns true when the range applies; false asks for the whole file instead.
 */
function rangeApplies(header, etag) {
  if (header === null) return true
  return header.trim() === etag
}

/**
 * Read one bounded window, turning filesystem rejections into a status-bearing error.
 * @param fs - composed filesystem that owns read authority.
 * @param target - resolved file target.
 * @param offset - 0-based first byte.
 * @param length - largest byte count.
 * @param signal - aborts the read.
 * @returns the window's bytes.
 */
async function readWindow(fs, target, offset, length, signal) {
  try {
    return await fs.readByteRange(target, { offset, length }, signal)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    throw new ReadFailure(code)
  }
}

/** Own metadata from an open local file; this never decodes an opaque FsVersion. */
function handleVersion(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/** Convert provider failures and native open/read failures to the same HTTP contract. */
function readFailure(error) {
  if (error instanceof ReadFailure) return error
  const raw = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const code = ({ ENOENT: 'FS_NOT_FOUND', ENOTDIR: 'FS_NOT_FOUND', EACCES: 'FS_PERMISSION_DENIED', EPERM: 'FS_PERMISSION_DENIED' })[raw] ?? raw
  return new ReadFailure(code)
}

/**
 * One request owns one reader and its close promise. Host-shared files are pinned
 * to a handle; all byte ranges still go through the provider's read authority.
 * Their bytes must match the pinned object before entering the response.
 * Providers without a host mapping retain the abstract window/version protocol.
 */
async function openReader(fs, target, info, signal, log) {
  const expected = tagOf(info)
  const check = async () => {
    if (signal.aborted) throw new ReadFailure('FS_ABORTED')
    const current = await fs.stat(target, signal)
    if (signal.aborted) throw new ReadFailure('FS_ABORTED')
    if (current === undefined || tagOf(current) !== expected) throw new ReadFailure('FILE_CHANGED')
  }
  const reader = {
    info,
    check,
    close: async () => {},
    async read(offset, length) {
      const bytes = await readWindow(fs, target, offset, length, signal)
      // Even an empty window is checked: EOF may have come from a new version.
      await check()
      return bytes
    },
  }
  const processPath = fs.processPath?.(target)
  const hostPath = processPath !== undefined && fs.processPathFromHostPath?.(processPath) === processPath ? processPath : undefined
  if (hostPath === undefined) return reader

  if (signal.aborted) throw new ReadFailure('FS_ABORTED')
  // NONBLOCK prevents a file swapped for a FIFO between stat/open from hanging.
  const handle = await open(hostPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  let closing
  const close = () => {
    if (closing === undefined) {
      signal.removeEventListener('abort', onAbort)
      closing = handle.close()
    }
    return closing
  }
  const onAbort = () => { void close().catch(error => { log?.warn(`file-download: close failed: ${String(error)}`) }) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw new ReadFailure('FS_ABORTED')
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new ReadFailure('FS_NOT_REGULAR_FILE')
    const version = handleVersion(opened)
    const verifyHandle = async () => {
      if (signal.aborted) throw new ReadFailure('FS_ABORTED')
      if (handleVersion(await handle.stat({ bigint: true })) !== version) throw new ReadFailure('FILE_CHANGED')
    }
    return {
      // Headers describe the object actually opened, including the first-open race.
      info: { ...info, version: `local:${version}`, ...(info.size === undefined ? {} : { size: Number(opened.size) }) },
      close,
      async check() { await verifyHandle(); await check() },
      async read(offset, length) {
        await verifyHandle()
        // Preserve provider-specific read policy, even on a host-shared backend.
        const bytes = await readWindow(fs, target, offset, length, signal)
        const pinned = Buffer.allocUnsafe(length)
        let total = 0
        while (total < length) {
          if (signal.aborted) throw new ReadFailure('FS_ABORTED')
          const { bytesRead } = await handle.read(pinned, total, length - total, offset + total)
          if (bytesRead === 0) break
          total += bytesRead
        }
        await verifyHandle()
        await check()
        if (total !== bytes.byteLength || !pinned.subarray(0, total).equals(bytes)) throw new ReadFailure('FILE_CHANGED')
        return bytes
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

/** Stream validated windows; completion, cancellation and errors share cleanup. */
function bodyOf(reader, start, end, first, signal, cancel, log) {
  let offset = start
  let pending = first
  let cancelled = false
  let completed = false
  let closing
  const release = () => { closing ??= reader.close(); return closing }
  return new ReadableStream({
    async pull(controller) {
      if (cancelled || completed) return
      try {
        if (signal.aborted || offset >= end) {
          completed = true
          await release()
          if (!cancelled) controller.close()
          return
        }
        let bytes = pending
        pending = undefined
        if (bytes === undefined) bytes = await reader.read(offset, Math.min(WINDOW, end - offset))
        await reader.check()
        if (cancelled) return
        if (signal.aborted) {
          completed = true
          await release()
          if (!cancelled) controller.close()
          return
        }
        if (bytes.byteLength === 0) {
          if (offset < end && Number.isFinite(end)) throw new ReadFailure('FILE_CHANGED')
          completed = true
          await release()
          if (!cancelled) controller.close()
          return
        }
        offset += bytes.byteLength
        controller.enqueue(bytes)
        if (offset >= end) {
          completed = true
          await release()
          if (!cancelled) controller.close()
        }
      } catch (error) {
        completed = true
        try { await release() } catch (closeError) { log?.warn(`file-download: close failed: ${String(closeError)}`) }
        if (cancelled) return
        if (signal.aborted) { controller.close(); return }
        log?.warn(`file-download: response aborted: ${error instanceof Error ? error.message : String(error)}`)
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      cancel.abort(reason)
      await release()
    },
  })
}

/**
 * Answer one download request.
 * @param request - already authenticated request carrying the absolute path.
 * @param fs - composed filesystem that owns read authority.
 * @param log - optional Host logger.
 * @returns the streaming, ranged, or failing response.
 */
async function serve(request, fs, log) {
  const base = {
    'X-DSH-File-Download': '1',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // Same defence in depth as the shipped route: these bytes are a download,
    // never a document, even if something opens one directly.
    'Content-Security-Policy': "sandbox; default-src 'none'",
    // A reverse proxy in front of the Host must forward this response instead of
    // spooling it to its own temp files: nginx honours this per-response header.
    'X-Accel-Buffering': 'no',
  }
  const fail = (status, text) => new Response(request.method === 'HEAD' ? null : text, {
    status,
    headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8' },
  })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    return fail(400, 'absolute path required')
  }
  let target
  let info
  try {
    target = await fs.resolve(path, { signal: request.signal })
    info = await fs.stat(target, request.signal)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (!(code in STATUS_BY_CODE)) throw error
    return fail(STATUS_BY_CODE[code], code)
  }
  if (info === undefined) return fail(404, 'not found')
  if (info.type !== 'file') return fail(403, 'not a regular file')
  const name = fileNameOf(path)
  const cancel = new AbortController()
  const signal = AbortSignal.any([request.signal, cancel.signal])
  let reader
  let streaming = false
  try {
    reader = await openReader(fs, target, info, signal, log)
    info = reader.info
    const size = info.size
    const declared = typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
    const etag = entityTag(info.version, declared ? size : undefined)
    const headers = {
      ...base,
      'Content-Type': MEDIA_TYPES[extensionOf(name)] ?? 'application/octet-stream',
      'Content-Disposition': contentDisposition(name),
      ETag: etag,
    }
    let start = 0
    let end = Infinity
    let status = 200
    if (declared) {
      headers['Accept-Ranges'] = 'bytes'
      const range = rangeApplies(request.headers.get('if-range'), etag)
        ? requestedRange(request.headers.get('range'), size)
        : null
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${String(size)}` } })
      }
      start = range === null ? 0 : range.start
      end = range === null ? size : range.end + 1
      status = range === null ? 200 : 206
      headers['Content-Length'] = String(end - start)
      if (range !== null) headers['Content-Range'] = `bytes ${String(start)}-${String(end - 1)}/${String(size)}`
    }
    if (request.method === 'HEAD' || end === start) return new Response(null, { status, headers })
    // Both sized and unsized backends finish the first read and its validation
    // before a successful Response can escape. Failures share one status mapper.
    const first = await reader.read(start, Math.min(WINDOW, end - start))
    if (first.byteLength === 0 && start < end && Number.isFinite(end)) throw new ReadFailure('FILE_CHANGED')
    const response = new Response(bodyOf(reader, start, end, first, signal, cancel, log), { status, headers })
    streaming = true
    return response
  } catch (error) {
    const failure = readFailure(error)
    return fail(failure.status, failure.message)
  } finally {
    if (!streaming) await reader?.close()
  }
}

export const inject = ['connection', 'fs']

/** @param ctx - plugin-owned Host context. */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: request => serve(request, ctx.fs, ctx.logger),
  }), `file-download: ${ROUTE}`)
}
