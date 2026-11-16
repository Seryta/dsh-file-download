// Browser-free behavioural checks for the dynamically loaded Client plugin.
// The DOM, network, timers and online event are controlled; no real browser or
// external dependencies are needed, and clicking must start saving synchronously.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let assertions = 0
const equal = (actual, expected, message) => { assertions += 1; assert.equal(actual, expected, message) }
const check = (condition, message) => { assertions += 1; assert.ok(condition, message) }
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

function harness({ desktop = false, baseURI = 'https://dsh.example/mounted/', obeyAbort = true } = {}) {
  const cleanups = []
  const registrations = []
  const fetches = []
  const timers = new Map()
  const listeners = new Map()
  const styles = new Set()
  const anchors = new Set()
  const downloads = []
  const notifications = []
  let now = 0
  let nextTimer = 0
  let plugin
  const state = { effects: 0, injections: 0, created: 0, locales: 0 }
  const document = {
    baseURI,
    head: { append(node) { styles.add(node) } },
    body: { append(node) { anchors.add(node) } },
    createElement(type) {
      state.created += 1
      const node = {
        dataset: {}, style: {},
        remove() { styles.delete(node); anchors.delete(node) },
        click() { downloads.push({ href: node.href, name: node.download, rel: node.rel, attached: anchors.has(node), type }) },
      }
      return node
    },
  }
  const window = {
    ...(desktop ? { dshDesktop: {} } : {}),
    __ModuleLoader__: { load(module) { plugin = module.factory(name => {
      assert.equal(name, 'react')
      return { createElement: (type, props, ...children) => ({ type, props, children }) }
    }) } },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  }
  const setTimeout = (run, delay = 0) => {
    const id = ++nextTimer
    timers.set(id, { run, at: now + delay })
    return id
  }
  const clearTimeout = id => { timers.delete(id) }
  const fetch = (url, options) => new Promise((resolve, reject) => {
    const entry = { url: String(url), options, resolve, reject }
    fetches.push(entry)
    if (obeyAbort && options.signal !== undefined) {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }
  })
  const effect = factory => {
    state.effects += 1
    const cleanup = factory()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup
  }
  const child = {
    effect,
    locale: {
      register() { state.locales += 1; return () => { state.locales -= 1 } },
      bind: () => key => key,
    },
    contextMenus: { notify: (text, success) => { notifications.push({ text, success }) } },
    slots: {
      inject: (_name, factory) => effect(factory),
      register(config, component) {
        const entry = { config, component }
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    },
  }
  vm.runInNewContext(source, { window, document, URL, AbortController, fetch, setTimeout, clearTimeout })
  const apply = () => plugin.apply({ effect, inject: (_services, callback) => { state.injections += 1; callback(child) } })
  const save = () => registrations[0].config.inject().save
  const button = (index = 0, absolutePath = '/tmp/large.apk') => {
    const registration = registrations[index]
    return registration.component({ ...registration.config.inject(), t: key => key, absolutePath })
  }
  const click = (index = 0, path) => button(index, path).props.onClick()
  const respond = async (status, marker, index = fetches.length - 1) => {
    fetches[index].resolve({ status, headers: { get: name => name.toLowerCase() === 'x-dsh-file-download' ? marker ?? null : null } })
    await flush()
  }
  const reject = async (index = fetches.length - 1) => { fetches[index].reject(new Error('temporary offline')); await flush() }
  const advance = async () => {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
    assert.ok(next, 'the requested timer must exist')
    timers.delete(next[0])
    now = next[1].at
    next[1].run()
    await flush()
  }
  const online = async () => { for (const listener of [...listeners.get('online') ?? []]) listener(); await flush() }
  const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
  return { apply, state, registrations, fetches, timers, listeners, styles, anchors, downloads, notifications, save, button, click, respond, reject, advance, online, dispose }
}

const cases = []
const test = (name, run) => { cases.push({ name, run }) }
const streamPath = href => new URL(href).pathname === '/mounted/api/file-download'
const legacyPath = href => new URL(href).pathname === '/mounted/api/file'

test('module factory has no effects; pending probes use stream and clicks are synchronous', async () => {
  const h = harness()
  try {
    equal(h.fetches.length, 0, 'module evaluation must not fetch')
    equal(h.state.created, 0, 'module evaluation must not touch DOM')
    h.apply()
    equal(h.registrations.length, 2, 'both download entries register')
    equal(h.styles.size, 1, 'the controls share one stylesheet')
    equal(h.fetches.length, 1, 'apply starts one capability probe')
    equal(h.fetches[0].options.method, 'HEAD', 'probe uses HEAD')
    equal(h.fetches[0].options.credentials, 'same-origin', 'probe carries browser credentials')
    check(h.fetches[0].options.signal instanceof AbortSignal, 'probe can be cancelled')
    equal(h.fetches[0].url, 'https://dsh.example/mounted/api/file-download', 'probe preserves application mount')
    const path = '/tmp/安卓 & report#1.apk'
    const returned = h.click(0, path)
    equal(returned, undefined, 'button callback stays synchronous')
    equal(h.downloads.length, 1, 'save begins before the click returns')
    check(streamPath(h.downloads[0].href), 'pending detection must not impose legacy size limit')
    equal(new URL(h.downloads[0].href).searchParams.get('path'), path, 'download preserves and encodes the host path')
    equal(h.downloads[0].name, '安卓 & report#1.apk', 'download keeps the original basename')
    check(h.downloads[0].attached, 'anchor is attached during the synchronous click')
    equal(h.anchors.size, 0, 'temporary anchor is removed')
    equal(h.fetches.length, 1, 'click does not perform asynchronous data fetching')
    equal(h.registrations[0].component({ absolutePath: undefined }), null, 'header entry hides when host path is missing')
    equal(h.registrations[1].component({ absolutePath: undefined }), null, 'empty-state entry hides when host path is missing')
  } finally { h.dispose() }
})

test('the Host capability marker confirms even a no-path 400 response', async () => {
  const h = harness()
  try {
    h.apply()
    await h.respond(400, '1')
    equal(h.timers.size, 0, 'confirmed availability leaves no timeout or retries')
    h.click(0, 'C:\\build\\安装.apk')
    h.click(1, '/tmp/a\\b.zip')
    equal(h.downloads.length, 2, 'both controls save normally')
    check(h.downloads.every(download => streamPath(download.href)), 'both controls use the confirmed streaming route')
    equal(h.downloads[0].name, '安装.apk', 'Windows basename is preserved')
    equal(h.downloads[1].name, 'a\\b.zip', 'POSIX backslash remains part of the name')
    equal(h.notifications.length, 0, 'valid downloads do not notify an error')
  } finally { h.dispose() }
})

test('only an unmarked 404 confirms fallback and online can discover a newly available route', async () => {
  const h = harness()
  try {
    h.apply()
    await h.respond(404)
    h.click()
    check(legacyPath(h.downloads.at(-1).href), 'missing route may fall back')
    equal(h.timers.size, 0, 'confirmed absence is not automatically retried')
    await h.online()
    equal(h.fetches.length, 2, 'online rechecks capability')
    h.click()
    check(streamPath(h.downloads.at(-1).href), 'a renewed pending probe prefers stream')
    await h.respond(400, '1')
    h.click(1)
    check(streamPath(h.downloads.at(-1).href), 'online recovery uses newly detected route')
  } finally { h.dispose() }
})

test('a marked 404 proves route ownership rather than absence', async () => {
  const h = harness()
  try {
    h.apply()
    await h.respond(404, '1')
    h.click()
    check(streamPath(h.downloads.at(-1).href), 'Host marker takes precedence over an owned 404')
    equal(h.timers.size, 0, 'owned response requires no retry')
  } finally { h.dispose() }
})

for (const [status, marker] of [[200, undefined], [400, undefined], [200, '2'], [401, '1'], [403, '1'], [500, '1'], [502, undefined]]) {
  test(`unconfirmed or unavailable response ${status}/${marker ?? 'unmarked'} remains unknown and retries`, async () => {
    const h = harness()
    try {
      h.apply()
      await h.respond(status, marker)
      h.click()
      check(streamPath(h.downloads.at(-1).href), 'unknown capability prefers stream')
      equal(h.timers.size, 1, 'unknown response schedules a bounded retry, not a lingering request timeout')
      await h.advance()
      equal(h.fetches.length, 2, 'retry makes another capability request')
      await h.respond(400, '1')
      equal(h.timers.size, 0, 'successful retry removes all pending timers')
      h.click(1)
      check(streamPath(h.downloads.at(-1).href), 'successful retry is used by the existing click closure')
    } finally { h.dispose() }
  })
}

test('network rejection retries only finitely, then online starts a fresh recovery budget', async () => {
  const h = harness()
  try {
    h.apply()
    await h.reject()
    check(h.timers.size > 0, 'network failure must schedule recovery')
    for (let i = 0; i < 10 && h.timers.size > 0; i += 1) {
      await h.advance()
      await h.reject()
    }
    check(h.fetches.length >= 2 && h.fetches.length <= 5, 'automatic recovery uses a small finite number of attempts')
    equal(h.timers.size, 0, 'failed retry budget is exhausted')
    h.click()
    check(streamPath(h.downloads.at(-1).href), 'exhausting retries does not degrade unknown state to legacy')
    const before = h.fetches.length
    await h.online()
    equal(h.fetches.length, before + 1, 'online can recover after retry exhaustion')
    await h.respond(400, '1')
    equal(h.timers.size, 0, 'recovery stops retrying once available')
  } finally { h.dispose() }
})

test('online replaces a pending retry and never overlaps an in-flight request', async () => {
  const h = harness()
  try {
    h.apply()
    await h.online()
    await h.online()
    equal(h.fetches.length, 1, 'online events do not duplicate an active probe')
    await h.reject()
    equal(h.timers.size, 1, 'failed probe has one retry scheduled')
    await h.online()
    equal(h.fetches.length, 2, 'online immediately replaces the delayed retry')
    await h.respond(400, '1')
    equal(h.timers.size, 0, 'replaced retry cannot fire after success')
  } finally { h.dispose() }
})

test('a stalled probe is timed out, aborted and retried without blocking saving', async () => {
  const h = harness()
  try {
    h.apply()
    check(h.timers.size > 0, 'pending probe has a finite timeout')
    await h.advance()
    check(h.fetches[0].options.signal.aborted, 'timeout aborts the pending fetch')
    equal(h.timers.size, 1, 'timeout schedules a recovery attempt')
    h.click()
    check(streamPath(h.downloads.at(-1).href), 'timed-out capability remains safe for large downloads')
    await h.advance()
    equal(h.fetches.length, 2, 'retry after timeout starts a new request')
    await h.respond(400, '1')
    equal(h.timers.size, 0, 'successful retry clears the deadline')
  } finally { h.dispose() }
})

test('unloading cancels fetch, timers and online listener, and late responses cannot mutate route', async () => {
  const h = harness({ obeyAbort: false })
  h.apply()
  const save = h.save()
  const signal = h.fetches[0].options.signal
  h.dispose()
  check(signal?.aborted, 'unload aborts an active fetch')
  equal(h.timers.size, 0, 'unload clears the request timeout')
  equal(h.listeners.get('online')?.size ?? 0, 0, 'unload removes the online listener')
  equal(h.styles.size, 0, 'unload removes its stylesheet')
  equal(h.state.locales, 0, 'unload releases locale registration')
  equal(h.registrations.length, 0, 'unload releases both slot registrations')
  await h.respond(404)
  await h.online()
  equal(h.fetches.length, 1, 'unloaded plugin cannot start probes')
  equal(h.timers.size, 0, 'late response cannot schedule a retry')
  save('/tmp/large.apk')
  check(streamPath(h.downloads.at(-1).href), 'late 404 must not mutate the disposed closure')
})

test('unloading also removes a queued retry', async () => {
  const h = harness()
  h.apply()
  await h.reject()
  equal(h.timers.size, 1, 'a recovery timer exists before unloading')
  h.dispose()
  equal(h.timers.size, 0, 'queued recovery timer is removed')
  await h.online()
  equal(h.fetches.length, 1, 'disposed event callback cannot restart recovery')
})

test('Desktop skips the whole apply without DOM, slots, effects, listeners or fetch', async () => {
  const h = harness({ desktop: true })
  h.apply()
  equal(h.state.effects, 0, 'Desktop must not create effects')
  equal(h.state.injections, 0, 'Desktop must not request services')
  equal(h.state.created, 0, 'Desktop must not create DOM nodes')
  equal(h.registrations.length, 0, 'Desktop must not install controls')
  equal(h.state.locales, 0, 'Desktop must not install locale')
  equal(h.fetches.length, 0, 'Desktop must not probe routes')
  equal(h.timers.size, 0, 'Desktop must not schedule timers')
  equal(h.listeners.size, 0, 'Desktop must not install listeners')
  h.dispose()
})

test('an unaddressable application base produces synchronous feedback and no download', async () => {
  const h = harness({ baseURI: 'file:///tmp/preview/' })
  try {
    h.apply()
    const result = h.click()
    equal(result, undefined, 'failure feedback stays synchronous')
    equal(h.downloads.length, 0, 'unsupported base does not create a download')
    equal(h.notifications.length, 1, 'unsupported base reports a useful error')
    equal(h.notifications[0].success, false, 'feedback is an error')
  } finally { h.dispose() }
})

let failed = 0
for (const entry of cases) {
  try { await entry.run(); console.log(`ok   ${entry.name}`) }
  catch (error) { failed += 1; console.error(`FAIL ${entry.name}\n${error.stack}`) }
}
console.log(`\nclient checks: ${cases.length - failed}/${cases.length} cases passed; ${assertions} assertions evaluated; ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
