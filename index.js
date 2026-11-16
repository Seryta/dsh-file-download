/**
 * Host half: an authenticated streaming download route for original file bytes.
 *
 * `GET /api/file-download?path=<absolute>` answers the file's bytes with
 * `Content-Disposition: attachment`, so the browser's own download manager
 * performs the transfer — no client memory, no size cap, real progress, and
 * resume through `Range` plus a per-version `ETag` / `If-Range` validator.
 *
 * One response carries one file version: the first window is read before any
 * header is written (so an unreadable file answers 403/404 instead of a 200 that
 * fails mid-body), and every window is validated against the version the headers
 * describe before it enters the body. A changed file aborts the response, so a
 * client can never assemble bytes from two versions.
 *
 * The connection service authenticates the request before this handler runs and
 * supplies `ctx.fs`; paths and media types do not restrict access, exactly like
 * the shipped `/api/file` route, but this route has no image-limit cap and
 * streams instead of buffering.
 */
import { createHash } from 'node:crypto'
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

/**
 * Stream `[start, end)` through validated windows, starting from one already read.
 * @param fs - composed filesystem that owns read authority.
 * @param target - resolved file target.
 * @param start - 0-based first byte.
 * @param end - exclusive last byte.
 * @param expected - entity tag the response headers describe.
 * @param first - the pre-read first window.
 * @param signal - aborts the stream when the client goes away.
 * @param log - optional Host logger for aborted transfers.
 * @returns the response body.
 */
function bodyOf(fs, target, start, end, expected, first, signal, log) {
  let offset = start
  let pending = first
  return new ReadableStream({
    async pull(controller) {
      if (signal.aborted || offset >= end) {
        controller.close()
        return
      }
      let bytes
      try {
        bytes = pending
        pending = undefined
        if (bytes === undefined) {
          bytes = await readWindow(fs, target, offset, Math.min(WINDOW, end - offset), signal)
        }
        if (bytes.byteLength === 0) {
          controller.close()
          return
        }
        // One response carries one version: a window that belongs to another
        // version never enters the body, so the client cannot assemble a file
        // out of two of them.
        const current = await fs.stat(target, signal)
        if (current === undefined || tagOf(current) !== expected) {
          log?.warn(`file-download: ${target.displayPath} changed during download; response aborted`)
          controller.error(new Error('file changed during download'))
          return
        }
      } catch (error) {
        if (signal.aborted) {
          controller.close()
          return
        }
        log?.warn(`file-download: read failed for ${target.displayPath}: ${error instanceof Error ? error.message : String(error)}`)
        controller.error(error)
        return
      }
      offset += bytes.byteLength
      controller.enqueue(bytes)
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
  const size = info.size
  const declared = typeof size === 'number' && Number.isFinite(size)
  const etag = entityTag(info.version, declared ? size : undefined)
  const headers = {
    ...base,
    'Content-Type': MEDIA_TYPES[extensionOf(name)] ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(name),
    // The validator a browser sends back as `If-Range` when it resumes: the same
    // file version answers the range, a changed one restarts the download.
    ETag: etag,
  }
  if (!declared) {
    // A backend that cannot report a size gives no length and no ranges, so a
    // browser cannot resume this response. Such backends are not the local one.
    if (request.method === 'HEAD') return new Response(null, { headers })
    const first = await readWindow(fs, target, 0, WINDOW, request.signal)
    return new Response(bodyOf(fs, target, 0, Infinity, etag, first, request.signal, log), { headers })
  }
  headers['Accept-Ranges'] = 'bytes'
  const range = rangeApplies(request.headers.get('if-range'), etag)
    ? requestedRange(request.headers.get('range'), size)
    : null
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${String(size)}` } })
  }
  const start = range === null ? 0 : range.start
  const end = range === null ? size : range.end + 1
  const status = range === null ? 200 : 206
  const responseHeaders = {
    ...headers,
    'Content-Length': String(end - start),
    ...(range === null ? {} : { 'Content-Range': `bytes ${String(start)}-${String(end - 1)}/${String(size)}` }),
  }
  if (request.method === 'HEAD' || end === start) return new Response(null, { status, headers: responseHeaders })
  // Read the first window before any header goes out: a file that cannot be
  // opened answers 403/404 here, instead of a 200 that dies mid-body.
  let first
  try {
    first = await readWindow(fs, target, start, Math.min(WINDOW, end - start), request.signal)
  } catch (error) {
    if (error instanceof ReadFailure) return fail(error.status, error.message)
    throw error
  }
  return new Response(bodyOf(fs, target, start, end, etag, first, request.signal, log), { status, headers: responseHeaders })
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
