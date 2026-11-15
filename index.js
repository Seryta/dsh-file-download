/**
 * Host half: an authenticated streaming download route for original file bytes.
 *
 * `GET /api/file-download?path=<absolute>` answers the file's bytes with
 * `Content-Disposition: attachment`, so the browser's own download manager
 * performs the transfer — no client memory, no size cap, real progress, and
 * resume through `Range`. Nothing is buffered whole: the body is a
 * `ReadableStream` that pulls fixed windows through the composed filesystem, so
 * Host memory stays bounded whatever the file size.
 *
 * The connection service authenticates the request before this handler runs and
 * supplies `ctx.fs`; paths and media types do not restrict access, exactly like
 * the shipped `/api/file` route, but this route has no image-limit cap and
 * streams instead of buffering.
 */
import { isAbsolute } from 'node:path'

/** The route this plugin owns. */
const ROUTE = '/api/file-download'
/** Bytes pulled per stream pull; the Host's resident bound. */
const WINDOW = 4 * 1024 * 1024

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

/**
 * The last path segment of either separator spelling.
 * @param path - absolute Host path.
 * @returns the file name the browser saves.
 */
function fileNameOf(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
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
 * @param name - original file name, possibly non-ASCII.
 * @returns the header value.
 */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
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
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * Stream `[start, end)` of one file through bounded filesystem windows.
 * @param fs - composed filesystem that owns read authority.
 * @param target - resolved file target.
 * @param start - 0-based first byte.
 * @param end - exclusive last byte.
 * @param signal - aborts the stream when the client goes away.
 * @returns the response body.
 */
function bodyOf(fs, target, start, end, signal) {
  let offset = start
  return new ReadableStream({
    async pull(controller) {
      if (signal.aborted || offset >= end) {
        controller.close()
        return
      }
      let bytes
      try {
        bytes = await fs.readByteRange(target, { offset, length: Math.min(WINDOW, end - offset) }, signal)
      } catch (error) {
        if (signal.aborted) controller.close()
        else controller.error(error)
        return
      }
      if (bytes.byteLength === 0) {
        controller.close()
        return
      }
      offset += bytes.byteLength
      controller.enqueue(bytes)
    },
  })
}

/**
 * A strong validator for one file version, usable as an `ETag` and in `If-Range`.
 * @param version - opaque filesystem version token.
 * @param size - declared byte size, or undefined when the backend omits it.
 * @returns the quoted entity tag, free of quotes, backslashes, and control characters.
 */
function entityTag(version, size) {
  const token = `${version}${size === undefined ? '' : `-${String(size)}`}`.replace(/["\\\u0000-\u001f\u007f]/gu, '_')
  return `"${token}"`
}

/**
 * Whether a ranged request may use its `Range` header: RFC 7233 requires the
 * `If-Range` validator to match, and an absent header leaves the range in force.
 * @param header - the request's `If-Range` value, when present.
 * @param etag - this response's entity tag.
 * @returns true when the range applies; false asks for the whole file instead.
 */
function rangeApplies(header, etag) {
  if (header === null) return true
  return header.trim() === etag
}

/**
 * Answer one download request.
 * @param request - already authenticated request carrying the absolute path.
 * @param fs - composed filesystem that owns read authority.
 * @returns the streaming, ranged, or failing response.
 */
async function serve(request, fs) {
  const base = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
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
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const info = await fs.stat(target, request.signal)
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
      'Accept-Ranges': 'bytes',
      // The validator a browser sends back as `If-Range` when it resumes: the
      // same file version answers the range, a changed one restarts the download.
      ETag: etag,
    }
    if (!declared) {
      // No declared length: stream to the end, which leaves ranges unavailable.
      const { 'Accept-Ranges': _unavailable, ...unranged } = headers
      if (request.method === 'HEAD') return new Response(null, { headers: unranged })
      return new Response(bodyOf(fs, target, 0, Infinity, request.signal), { headers: unranged })
    }
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
    return new Response(bodyOf(fs, target, start, end, request.signal), { status, headers: responseHeaders })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (!(code in STATUS_BY_CODE)) throw error
    return fail(STATUS_BY_CODE[code], code)
  }
}

export const inject = ['connection', 'fs']

/** @param ctx - plugin-owned Host context. */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: request => serve(request, ctx.fs),
  }), `file-download: ${ROUTE}`)
}
