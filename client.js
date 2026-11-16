/**
 * Web Client half: save the file a Sidebar preview is showing.
 *
 * Two seats are filled, both with the previewed file's Host `absolutePath` as
 * their owner prop:
 *
 *   - `sidebar.right.tab.document.actions` — the compact control in the
 *     preview header, present in every preview state;
 *   - `sidebar.right.tab.document.unpreviewable` — a labelled button in the
 *     empty state of a file this preview cannot render (binary containers,
 *     `not-text`, `too-large`).
 *
 * Clicking hands the file's authenticated route to the browser immediately, in
 * the click's own gesture: the download route streams the bytes and sets
 * `Content-Disposition: attachment`, so the browser's download manager owns the
 * transfer. Nothing is read into page memory, there is no size cap, and mobile
 * browsers accept the navigation because no `await` runs first.
 *
 * The streaming route belongs to this bundle's Host half. Background capability
 * probes keep unknown requests on that uncapped route; only a confirmed missing
 * route falls back to the shipped, buffered `/api/file` route and its image cap.
 * Desktop keeps its native file actions and does not apply these controls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-download',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'fileDownload'
    /** This bundle's uncapped streaming route. */
    const STREAM_ROUTE = 'api/file-download'
    /** The shipped route: one file version, buffered, capped by the Host image limit. */
    const LEGACY_ROUTE = 'api/file'

    const zh = {
      'action.download': '下载',
      'action.downloadFile': '下载文件',
      'error.download': '无法开始下载，请刷新页面后重试',
    }
    const en = {
      'action.download': 'Download',
      'action.downloadFile': 'Download file',
      'error.download': 'Could not start the download. Reload the page and retry.',
    }

    /** One stylesheet for both controls, owned by the plugin's own lifetime. */
    const css = [
      '.dshfd-tool{display:inline-flex;flex:none;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:6px;color:var(--dsw-alias-label-secondary);line-height:1;',
      'background:transparent;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer}',
      '.dshfd-tool svg{width:15px;height:15px}',
      '@media (hover:hover){.dshfd-tool:hover{color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}}',
      '.dshfd-tool:focus-visible,.dshfd-start:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);',
      'outline-offset:1px}',
      '.dshfd-start{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;margin-top:10px;',
      'color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);',
      'border:none;border-radius:var(--dsw-radius-sm);font:inherit;font-size:13px;cursor:pointer}',
      '.dshfd-start svg{width:15px;height:15px}',
      '@media (hover:hover){.dshfd-start:hover{background:var(--dsw-alias-button-primary-hover)}}',
    ].join('')

    /** Download glyph: an arrow into a tray, drawn with the current text color. */
    function Glyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        h('path', { d: 'M12 3.5V13' }),
        h('path', { d: 'M8.25 9.5 12 13.25l3.75-3.75' }),
        h('path', { d: 'M5 16.5v1.25A2.25 2.25 0 0 0 7.25 20h9.5A2.25 2.25 0 0 0 19 17.75V16.5' }),
      )
    }

    /**
     * The last path segment. A POSIX name may contain a backslash, so it only
     * counts as a separator when the path is a Windows one.
     * @param path - absolute Host path.
     * @returns the basename.
     */
    function fileNameOf(path) {
      const windows = /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
      let at = path.lastIndexOf('/')
      if (windows) at = Math.max(at, path.lastIndexOf('\\'))
      return at < 0 ? path : path.slice(at + 1)
    }

    /**
     * Address one download route for an absolute Host path.
     * @param route - route below the application base.
     * @param absolutePath - absolute Host path to save.
     * @returns the URL, or undefined when the page has no addressable base.
     */
    function routeUrl(route, absolutePath) {
      try {
        const url = new URL(`${route}?path=${encodeURIComponent(absolutePath)}`, document.baseURI)
        return ['http:', 'https:', 'dsh-app:'].includes(url.protocol) ? url.href : undefined
      } catch (_error) {
        return undefined
      }
    }

    /**
     * Hand a URL to the browser's download machinery inside the current gesture.
     * @param href - same-origin route URL.
     * @param name - file name the browser saves.
     */
    function triggerSave(href, name) {
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = name
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }

    /**
     * Build the click action both controls share.
     * @param routeOf - the route this page should use, read at click time.
     * @param notify - shared toast for the case where no URL can be built.
     * @param t - namespace-bound translate.
     * @returns a function that starts one download.
     */
    function createSave(routeOf, notify, t) {
      return (absolutePath) => {
        const url = routeUrl(routeOf(), absolutePath)
        if (url === undefined) {
          notify(t('error.download'), false)
          return
        }
        triggerSave(url, fileNameOf(absolutePath))
      }
    }

    /** Header control: icon button beside the preview's own tools. */
    function DownloadTool(props) {
      const { t, absolutePath, save } = props
      if (absolutePath === undefined) return null
      return h('button', {
        type: 'button', className: 'dshfd-tool', 'data-file-download-tool': '',
        'aria-label': t('action.download'), title: t('action.download'),
        onClick: () => { save(absolutePath) },
      }, h(Glyph))
    }

    /** Empty-state control: the labelled primary action of an unviewable file. */
    function DownloadStart(props) {
      const { t, absolutePath, save } = props
      if (absolutePath === undefined) return null
      return h('button', {
        type: 'button', className: 'dshfd-start', 'data-file-download-start': '',
        onClick: () => { save(absolutePath) },
      }, h(Glyph), h('span', null, t('action.downloadFile')))
    }

    const inject = []

    /** @param ctx - plugin-owned Client context. */
    function apply(ctx) {
      if ('dshDesktop' in window) return
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.fileDownload = ''
        style.textContent = css
        document.head.append(style)
        return () => { style.remove() }
      }, 'file-download: styles')
      ctx.inject(['slots', 'locale', 'contextMenus'], (child) => {
        child.effect(() => child.locale.register(NS, { zh, en }), 'file-download: locale')
        const t = child.locale.bind(NS)
        const notify = (text, success) => { child.contextMenus.notify(text, success) }
        // Probe outside the click so saving always preserves the user gesture.
        // An unknown route prefers streaming: a transient failure must not impose
        // the legacy image limit on a large file's first download.
        let route = STREAM_ROUTE
        child.effect(() => {
          const delays = [1000, 3000, 10000]
          let live = true
          let retries = 0
          let controller
          let retryTimer
          let timeoutTimer
          const retry = () => {
            if (!live || retries >= delays.length) return
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              void probe()
            }, delays[retries++])
          }
          async function probe() {
            if (!live || controller !== undefined) return
            const active = new AbortController()
            controller = active
            timeoutTimer = setTimeout(() => { active.abort() }, 5000)
            try {
              const response = await fetch(new URL(STREAM_ROUTE, document.baseURI), {
                method: 'HEAD', credentials: 'same-origin', signal: active.signal,
              })
              if (!live) return
              if (active.signal.aborted) {
                retry()
                return
              }
              const unavailable = response.status === 401 || response.status === 403 || response.status >= 500
              if (!unavailable && response.headers.get('X-DSH-File-Download') === '1') {
                route = STREAM_ROUTE
              } else if (response.status === 404) {
                route = LEGACY_ROUTE
              } else {
                route = STREAM_ROUTE
                retry()
              }
            } catch (_error) {
              if (!live) return
              route = STREAM_ROUTE
              retry()
            } finally {
              clearTimeout(timeoutTimer)
              timeoutTimer = undefined
              controller = undefined
            }
          }
          const online = () => {
            if (!live || controller !== undefined) return
            clearTimeout(retryTimer)
            retryTimer = undefined
            retries = 0
            route = STREAM_ROUTE
            void probe()
          }
          window.addEventListener('online', online)
          void probe()
          return () => {
            live = false
            clearTimeout(retryTimer)
            clearTimeout(timeoutTimer)
            controller?.abort()
            window.removeEventListener('online', online)
          }
        }, 'file-download: route detection')
        const save = createSave(() => route, notify, t)
        const face = () => ({ save })
        child.slots.inject('sidebar.right.tab.document.actions', () => child.slots.register({
          name: 'sidebar.right.tab.document.actions', id: 'file-download', order: 10, locale: NS, inject: face,
        }, DownloadTool))
        child.slots.inject('sidebar.right.tab.document.unpreviewable', () => child.slots.register({
          name: 'sidebar.right.tab.document.unpreviewable', id: 'file-download', order: 10, locale: NS, inject: face,
        }, DownloadStart))
      })
    }

    return { inject, apply }
  },
})
