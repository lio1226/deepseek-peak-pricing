/**
 * Client half of the DeepSeek peak/off-peak pricing plugin.
 *
 * This file IS the built browser bundle: DSH serves each plugin's `./client`
 * export straight to the page, so it is authored in the module-loader factory
 * format (`window.__ModuleLoader__.load({ id, factory })`) rather than as an ES
 * module. The only external it resolves is `react`, which the shell seeds in its
 * baseline module table — no build step, no third-party UI dependency, and the
 * panel styles itself from DSH's `--dsw-alias-*` theme tokens.
 *
 * It contributes one thing to the composer's bottom-left tool row
 * (`conversation.input.left`): a live badge showing whether the current moment
 * bills at the peak or the off-peak rate. Clicking the badge pulls up a panel
 * with the full price table, the current band, and a countdown to the switch.
 *
 * All pricing facts come from the host half over `/deepseek-pricing/api/state`;
 * this half only counts down to `band.phaseEndsAt` and asks again when it passes,
 * so the peak/off-peak rule exists in exactly one place (the host) instead of two
 * that can drift apart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-peak-pricing',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Routes owned by the host half. */
    const API_STATE = '/deepseek-pricing/api/state'
    const API_REFRESH = '/deepseek-pricing/api/refresh'

    /** Injected stylesheet element id, so re-activation cannot double-inject. */
    const STYLE_ID = 'dsh-deepseek-peak-pricing-style'

    /** Beijing offset, used only to render the wall clock (the rule lives on the host). */
    const BEIJING_OFFSET_MS = 8 * 3600 * 1000

    /** Bilingual copy. */
    const DICT = {
      zh: {
        title: '峰谷价格',
        badgePeak: '高峰',
        badgeOff: '谷时',
        bandPeak: '高峰时段',
        bandOff: '空闲时段',
        currentPrefix: '当前计费：',
        switchIn: '距切换',
        beijing: '北京时间',
        local: '本地',
        weekday: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
        holidaySuffix: '（法定节假日，全天谷时）',
        weekendSuffix: '（周末，全天谷时）',
        peakDaySuffix: '（工作日）',
        windowHeader: '项目',
        offHeader: '谷时（空闲）',
        peakHeader: '高峰',
        metricInputCacheHit: '输入 · 缓存命中',
        metricInputCacheMiss: '输入 · 缓存未命中',
        metricOutput: '输出',
        unitNote: '单位：元 / 百万 tokens；谷时价为高峰价的一半。',
        ruleNote: '高峰时段：北京时间周一至周五 09:00–12:00、14:00–18:00（不含中国法定节假日）；其余时段，含周末与法定节假日全天，均为空闲时段。调休上班的周末同样按空闲时段计费。',
        sourceOfficial: '官方页面',
        sourceBundled: '内置兜底数据',
        updatedAt: '更新于',
        never: '尚未成功同步',
        stale: '数据已过期',
        refresh: '立即刷新',
        refreshing: '刷新中…',
        close: '关闭',
        loadFailed: '读取失败',
        syncFailed: '同步失败',
        warnings: '解析告警',
        holidaySource: '节假日表',
        reminderPeak: '即将进入高峰',
        reminderOff: '即将进入空闲',
        upcoming: '即将切换',
        arrow: '→',
        resize: '拖动右下角可调整大小，双击标题栏可放大 / 还原',
        maximize: '放大',
        restore: '还原',
        minutes: '分',
        seconds: '秒',
        hours: '小时',
      },
      en: {
        title: 'Peak / off-peak price',
        badgePeak: 'Peak',
        badgeOff: 'Off-peak',
        bandPeak: 'Peak hours',
        bandOff: 'Off-peak hours',
        currentPrefix: 'Billing now: ',
        switchIn: 'Switches in',
        beijing: 'Beijing',
        local: 'Local',
        weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        holidaySuffix: ' (statutory holiday — off-peak all day)',
        weekendSuffix: ' (weekend — off-peak all day)',
        peakDaySuffix: ' (working day)',
        windowHeader: 'Item',
        offHeader: 'Off-peak',
        peakHeader: 'Peak',
        metricInputCacheHit: 'Input · cache hit',
        metricInputCacheMiss: 'Input · cache miss',
        metricOutput: 'Output',
        unitNote: 'CNY per million tokens; the off-peak price is half the peak price.',
        ruleNote: 'Peak: Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays. Everything else — weekends and holidays included — is off-peak. A make-up workday that falls on a weekend stays off-peak.',
        sourceOfficial: 'official page',
        sourceBundled: 'bundled fallback',
        updatedAt: 'updated',
        never: 'never synced',
        stale: 'stale data',
        refresh: 'Refresh now',
        refreshing: 'Refreshing…',
        close: 'Close',
        loadFailed: 'Could not load',
        syncFailed: 'Sync failed',
        warnings: 'parser warnings',
        holidaySource: 'Holiday table',
        reminderPeak: 'peak starts soon',
        reminderOff: 'off-peak starts soon',
        upcoming: 'switching soon',
        arrow: '→',
        resize: 'Drag the bottom-right corner to resize; double-click the title bar to expand',
        maximize: 'Expand',
        restore: 'Restore',
        minutes: 'm',
        seconds: 's',
        hours: 'h',
      },
    }

    /** Stylesheet, built from DSH theme tokens so the panel follows light/dark. */
    const CSS = `
.dpp-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:1;cursor:pointer;
  font-family:inherit;white-space:nowrap;transition:background .12s ease,color .12s ease}
.dpp-badge:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f5)}
.dpp-badge[data-phase="peak"]{color:var(--dsw-alias-state-warn-primary,#b26a00);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 45%,transparent)}
.dpp-badge[data-phase="offPeak"]{color:var(--dsw-alias-state-success-primary,#1a7f37);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 45%,transparent)}
.dpp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.dpp-badge[data-urgent="true"] .dpp-dot{animation:dpp-pulse 1.4s ease-in-out infinite}
@keyframes dpp-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.dpp-count{opacity:.75;font-variant-numeric:tabular-nums}
.dpp-pop{position:fixed;z-index:2147483000;width:352px;max-width:calc(100vw - 24px);max-height:min(70vh,560px);
  overflow:auto;padding:12px 12px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);
  box-shadow:0 10px 32px rgba(0,0,0,.16);font-size:12px;line-height:1.5;
  font-family:inherit;text-align:left}
.dpp-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dpp-title{font-weight:600;font-size:13px;flex:1 1 auto}
.dpp-pill{padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}
.dpp-pill[data-phase="peak"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#b26a00)}
.dpp-pill[data-phase="offPeak"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 16%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dpp-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px}
.dpp-close:hover{background:var(--dsw-alias-bg-layer-2,#f0f0f0)}
.dpp-band{padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);margin-bottom:10px}
.dpp-band-main{font-size:12px}
.dpp-band-main b{font-weight:600}
.dpp-band-sub{color:var(--dsw-alias-label-secondary,#777);font-size:11px;margin-top:2px;font-variant-numeric:tabular-nums}
.dpp-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dpp-table th,.dpp-table td{padding:3px 6px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}
.dpp-table th:first-child,.dpp-table td:first-child{text-align:left;color:var(--dsw-alias-label-secondary,#777)}
.dpp-table th{font-weight:500;color:var(--dsw-alias-label-secondary,#777);font-size:11px}
.dpp-table tr[data-model="true"] td{font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);border-bottom:0;padding-top:8px}
.dpp-table td[data-active="true"],.dpp-table th[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 9%,transparent)}
.dpp-note{color:var(--dsw-alias-label-secondary,#777);font-size:11px;margin:8px 0 0}
.dpp-warn{color:var(--dsw-alias-state-warn-primary,#b26a00)}
.dpp-err{color:var(--dsw-alias-state-error-primary,#d33)}
.dpp-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#eee)}
.dpp-prov{flex:1 1 auto;color:var(--dsw-alias-label-secondary,#777);font-size:11px}
.dpp-btn{border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit}
.dpp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f5f5f5)}
.dpp-btn:disabled{opacity:.55;cursor:default}
.dpp-loading{color:var(--dsw-alias-label-secondary,#777);padding:6px 0}
.dpp-pop[data-maximized="true"]{box-shadow:0 16px 48px rgba(0,0,0,.22)}
.dpp-pop[data-resized="true"]{max-height:none}
.dpp-head{cursor:default}
.dpp-max{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;
  font-size:13px;line-height:1;padding:2px 5px;border-radius:6px}
.dpp-max:hover{background:var(--dsw-alias-bg-layer-2,#f0f0f0)}
.dpp-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;opacity:.45;
  background:linear-gradient(135deg,transparent 0 44%,currentColor 44% 52%,transparent 52% 64%,currentColor 64% 72%,transparent 72%)}
.dpp-resize:hover{opacity:.9}
.dpp-next{font-weight:600;opacity:1}
.dpp-badge[data-urgent="true"]{background:color-mix(in srgb,currentColor 12%,transparent)}
`

    /** Shared client store: one fetch, many readers (badge and panel). */
    let store = { status: 'idle', data: null, error: null, busy: false }
    const listeners = new Set()

    /** Replace the store and notify every reader. */
    function setStore(patch) {
      store = Object.assign({}, store, patch)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-deepseek-peak-pricing] listener failed', error)
        }
      }
    }

    /** Subscribe to store changes (the `useSyncExternalStore` contract). */
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** Read the current store (stable identity between updates). */
    function getStore() {
      return store
    }

    /** Read the hint the badge uses to avoid a re-render per second. */
    function useStore() {
      return React.useSyncExternalStore(subscribe, getStore, getStore)
    }

    /**
     * Read the host payload, sharing one request between concurrent callers.
     * @param {{refresh?: boolean}} [options] - `refresh` asks the host to re-sync first.
     * @returns {Promise<void>} resolution after the store settles.
     */
    let inFlight = null

    async function load(options) {
      if (inFlight !== null) return inFlight
      const refresh = options !== undefined && options.refresh === true
      inFlight = (async () => {
        setStore({ busy: true, error: null, status: store.data === null ? 'loading' : store.status })
        try {
          const response = await fetch(refresh ? API_REFRESH : API_STATE, {
            method: refresh ? 'POST' : 'GET',
            headers: { accept: 'application/json' },
          })
          const body = await response.json().catch(() => null)
          if (body === null || body.ok !== true) {
            throw new Error(body !== null && body.error !== undefined ? body.error.message : `HTTP ${response.status}`)
          }
          setStore({ status: 'ready', data: body.value, error: null, busy: false })
        } catch (error) {
          setStore({
            status: store.data === null ? 'error' : store.status,
            error: error instanceof Error ? error.message : String(error),
            busy: false,
          })
        }
      })().finally(() => {
        inFlight = null
      })
      return inFlight
    }

    /**
     * Tick a component's clock while it is mounted.
     * @param {number} intervalMs - tick period.
     * @returns {number} the current epoch milliseconds.
     */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }

    /** Render one instant as a Beijing wall clock `YYYY-MM-DD HH:MM:SS`. */
    function beijingClock(atMs) {
      const shifted = new Date(atMs + BEIJING_OFFSET_MS)
      const pad = (value) => String(value).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
        + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    }

    /**
     * Render a countdown in the active language's unit style.
     * @param {number} ms - remaining milliseconds.
     * @param {object} t - the dictionary.
     * @returns {string} the label.
     */
    function formatRemaining(ms, t) {
      const total = Math.max(0, Math.round(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours}${t.hours} ${minutes}${t.minutes}`
      if (minutes > 0) return `${minutes}${t.minutes} ${seconds}${t.seconds}`
      return `${seconds}${t.seconds}`
    }

    /** Compact countdown for the badge (`12分` / `12m`). */
    function formatShort(ms, t) {
      const total = Math.max(0, Math.round(ms / 1000))
      if (total >= 3600) return `${Math.floor(total / 3600)}${t.hours}`
      if (total >= 60) return `${Math.floor(total / 60)}${t.minutes}`
      return `${total}${t.seconds}`
    }

    /** Precise `m:ss` countdown, used once the switch is imminent. */
    function formatClock(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const pad = (value) => String(value).padStart(2, '0')
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours}:${pad(minutes)}`
      return `${minutes}:${pad(seconds)}`
    }

    /**
     * Resolve the panel's language.
     *
     * Chinese is the default: `config.json` decides, and only `locale: 'auto'`
     * defers to the DSH locale (then the browser). An Electron renderer started
     * with `--lang=en-US` would otherwise flip the panel to English even when the
     * user reads Chinese, which is exactly what the default avoids.
     * @param {object|undefined} display - the host payload's `display` block.
     * @param {object} ctx - the client Cordis context, for the `auto` path.
     * @returns {'zh'|'en'} the language id.
     */
    function resolveLang(display, ctx) {
      const preference = display !== undefined && display !== null ? display.locale : undefined
      if (preference === 'en') return 'en'
      if (preference === 'zh') return 'zh'
      if (preference === 'auto') return detectLang(ctx)
      return 'zh'
    }

    /** Storage key remembering the panel's dragged size. */
    const PANEL_SIZE_KEY = 'dsh-deepseek-peak-pricing:panel-size'

    /**
     * Clamp a number into an inclusive range.
     * @param {number} value - the value.
     * @param {number} min - lower bound.
     * @param {number} max - upper bound.
     * @returns {number} the clamped value.
     */
    function clampValue(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * Read the remembered panel geometry. Storage may be unavailable (private
     * mode, or a changed origin after an app restart on another port).
     * @returns {{width: number|null, height: number|null, maximized: boolean}} the geometry.
     */
    function readPanelSize() {
      try {
        const raw = window.localStorage.getItem(PANEL_SIZE_KEY)
        if (raw === null) return { width: null, height: null, maximized: false }
        const parsed = JSON.parse(raw)
        return {
          width: Number.isFinite(parsed?.width) ? parsed.width : null,
          height: Number.isFinite(parsed?.height) ? parsed.height : null,
          maximized: parsed?.maximized === true,
        }
      } catch {
        return { width: null, height: null, maximized: false }
      }
    }

    /**
     * Remember the panel geometry (best effort).
     * @param {{width: number|null, height: number|null, maximized: boolean}} size - the geometry.
     * @returns {void}
     */
    function writePanelSize(size) {
      try {
        window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(size))
      } catch {
        /* not remembering the size is an acceptable outcome */
      }
    }

    /** Render one price number without trailing noise. */
    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return String(Math.round(value * 10000) / 10000)
    }

    /** Render one timestamp as a local short date-time. */
    function stamp(atMs) {
      if (typeof atMs !== 'number' || atMs <= 0) return null
      try {
        return new Date(atMs).toLocaleString()
      } catch {
        return null
      }
    }

    /** The price buckets in display order, paired with their dictionary keys. */
    const METRICS = [
      ['inputCacheHit', 'metricInputCacheHit'],
      ['inputCacheMiss', 'metricInputCacheMiss'],
      ['output', 'metricOutput'],
    ]

    /**
     * One badge + its pull-up panel.
     * @param {{ctx: object}} props - the client Cordis context (locale fallback).
     * @returns {object} the React element.
     */
    function PeakPricingBadge(props) {
      const ctx = props.ctx
      const state = useStore()
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [size, setSize] = React.useState(() => readPanelSize())
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        void load({})
      }, [])

      const data = state.data
      const band = data !== null && data !== undefined ? data.band ?? null : null
      const display = data !== null && data !== undefined && data.display !== undefined ? data.display : {}
      const t = DICT[resolveLang(display, ctx)]
      const countdownBelowMs = Number.isFinite(display.countdownBelowMs) ? display.countdownBelowMs : 3600 * 1000
      const urgentBelowMs = Number.isFinite(display.urgentBelowMs) ? display.urgentBelowMs : 10 * 60 * 1000

      // Read the raw clock once per render purely to choose the tick rate: one
      // second while the panel is open or the switch is already inside the
      // countdown window, a coarse tick otherwise.
      const rough = band !== null ? band.phaseEndsAt - Date.now() : Number.POSITIVE_INFINITY
      const now = useNow(open || rough <= countdownBelowMs ? 1000 : 20000)
      const remaining = band !== null ? band.phaseEndsAt - now : 0

      // Ask the host again the moment the band is due to switch, so the badge
      // can never keep showing a band that already ended.
      const switchedFor = React.useRef(0)
      React.useEffect(() => {
        if (band === null || remaining > 0) return
        if (switchedFor.current === band.phaseEndsAt) return
        switchedFor.current = band.phaseEndsAt
        void load({})
      }, [band, remaining])

      // Re-measure the anchor while the panel is open: the composer can move
      // (window resize, sidebar toggle, transcript growth).
      React.useLayoutEffect(() => {
        if (!open) {
          setAnchor(null)
          return undefined
        }
        const measure = () => {
          const rect = buttonRef.current !== null ? buttonRef.current.getBoundingClientRect() : null
          if (rect === null) return
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      // Dismiss on Escape or on a press outside both the badge and the panel.
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      /** Merge and remember one panel-geometry change. */
      const updateSize = (patch) => {
        setSize((current) => {
          const next = Object.assign({}, current, patch)
          writePanelSize(next)
          return next
        })
      }

      /** Drag the bottom-right corner: right grows width, up grows height. */
      const onResizeStart = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const panel = panelRef.current
        if (panel === null) return
        const rect = panel.getBoundingClientRect()
        const startX = event.clientX
        const startY = event.clientY
        const onMove = (moveEvent) => {
          updateSize({
            maximized: false,
            width: clampValue(Math.round(rect.width + (moveEvent.clientX - startX)), 280, Math.max(280, window.innerWidth - 24)),
            height: clampValue(Math.round(rect.height - (moveEvent.clientY - startY)), 200, Math.max(200, window.innerHeight - 24)),
          })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const phase = band !== null ? band.phase : 'offPeak'
      const label = phase === 'peak' ? t.badgePeak : t.badgeOff
      const nextLabel = band !== null && band.nextPhase === 'peak' ? t.badgePeak : t.badgeOff
      const showCountdown = band !== null && remaining > 0 && remaining <= countdownBelowMs
      const urgent = band !== null && remaining > 0 && remaining <= urgentBelowMs
      const badgeTitle = urgent
        ? `${t.upcoming}：${nextLabel} · ${t.switchIn} ${formatRemaining(remaining, t)}`
        : t.title

      const badge = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'dpp-badge',
          'data-phase': phase,
          'data-urgent': urgent ? 'true' : 'false',
          title: badgeTitle,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: 'dpp-dot', key: 'dot' }),
        h('span', { key: 'label' }, label),
        showCountdown
          ? h(
            'span',
            { className: urgent ? 'dpp-count dpp-next' : 'dpp-count', key: 'count' },
            urgent ? `${t.arrow}${nextLabel} ${formatClock(remaining)}` : formatShort(remaining, t),
          )
          : null,
      )

      if (!open) return badge

      // Geometry: an explicit width always applies, an explicit height only once
      // the user resized or maximized (otherwise CSS keeps the natural height).
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const anchorBottom = anchor !== null ? anchor.bottom : 80
      const anchorLeft = anchor !== null ? anchor.left : 16
      const maximized = size.maximized === true
      const maxWidth = Math.max(280, viewportWidth - 24)
      const width = clampValue(maximized ? Math.min(820, viewportWidth - 24) : size.width ?? 352, 280, maxWidth)
      const height = maximized
        ? Math.max(240, viewportHeight - anchorBottom - 72)
        : Number.isFinite(size.height) ? clampValue(size.height, 200, viewportHeight - 24) : null
      const left = Math.max(8, Math.min(anchorLeft, viewportWidth - width - 8))
      const bottom = Math.max(8, Math.min(anchorBottom, viewportHeight - (height ?? 320) - 8))
      const panelStyle = anchor === null
        ? { left: -9999, bottom: 0, visibility: 'hidden', width: `${width}px` }
        : Object.assign(
          { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px` },
          height === null ? {} : { height: `${height}px` },
        )

      return h(
        React.Fragment,
        null,
        badge,
        h(
          'div',
          {
            ref: panelRef,
            className: 'dpp-pop',
            style: panelStyle,
            role: 'dialog',
            'data-maximized': maximized ? 'true' : 'false',
            'data-resized': height === null ? 'false' : 'true',
            'aria-label': t.title,
          },
          renderPanel(t, state, band, now, remaining, () => setOpen(false), () => updateSize({ maximized: !maximized }), maximized),
          h('div', {
            className: 'dpp-resize',
            key: 'resize',
            title: t.resize,
            'aria-hidden': 'true',
            onPointerDown: onResizeStart,
          }),
        ),
      )
    }

    /**
     * The panel body: current band, price table, rule, provenance.
     * @param {object} t - the dictionary.
     * @param {object} state - the client store.
     * @param {object|null} band - the host-computed band.
     * @param {number} now - the ticking clock.
     * @param {number} remaining - milliseconds until the band switches.
     * @param {() => void} onClose - closes the panel.
     * @param {() => void} onToggleMaximized - expands or restores the panel.
     * @param {boolean} maximized - whether the panel is currently expanded.
     * @returns {object[]} React children.
     */
    function renderPanel(t, state, band, now, remaining, onClose, onToggleMaximized, maximized) {
      const children = []
      children.push(h(
        'div',
        { className: 'dpp-head', key: 'head', onDoubleClick: onToggleMaximized },
        h('span', { className: 'dpp-title', key: 'title' }, t.title),
        band !== null
          ? h('span', { className: 'dpp-pill', key: 'pill', 'data-phase': band.phase }, band.phase === 'peak' ? t.bandPeak : t.bandOff)
          : null,
        h('button', {
          className: 'dpp-max',
          type: 'button',
          key: 'max',
          title: maximized ? t.restore : t.maximize,
          'aria-label': maximized ? t.restore : t.maximize,
          onClick: onToggleMaximized,
        }, maximized ? '⤡' : '⤢'),
        h('button', {
          className: 'dpp-close',
          type: 'button',
          key: 'close',
          'aria-label': t.close,
          onClick: onClose,
        }, '×'),
      ))

      if (state.status === 'loading' && state.data === null) {
        children.push(h('div', { className: 'dpp-loading', key: 'loading' }, `${t.title} · …`))
        return children
      }
      if (state.data === null) {
        children.push(h('div', { className: 'dpp-loading dpp-err', key: 'failed' }, `${t.loadFailed}: ${state.error ?? ''}`))
        return children
      }

      const data = state.data
      if (band !== null) {
        const suffix = band.holidayName !== null && band.holidayName !== undefined
          ? t.holidaySuffix
          : band.weekend
            ? t.weekendSuffix
            : band.peakDay
              ? t.peakDaySuffix
              : ''
        const dayLabel = band.holidayName !== null && band.holidayName !== undefined
          ? `${t.weekday[band.weekday - 1]} · ${band.holidayName}${suffix}`
          : `${t.weekday[band.weekday - 1]}${suffix}`
        children.push(h(
          'div',
          { className: 'dpp-band', key: 'band' },
          h(
            'div',
            { className: 'dpp-band-main' },
            t.currentPrefix,
            h('b', null, band.phase === 'peak' ? t.bandPeak : t.bandOff),
            ' · ',
            `${t.switchIn} ${remaining > 0 ? formatRemaining(remaining, t) : '—'}`,
          ),
          h('div', { className: 'dpp-band-sub' }, `${dayLabel} · ${t.beijing} ${beijingClock(now)}`),
          h('div', { className: 'dpp-band-sub' }, `${t.local} ${new Date(now).toLocaleTimeString()}`),
        ))
      }

      const activeColumn = band !== null ? band.phase : 'offPeak'
      const rows = []
      rows.push(h(
        'tr',
        { key: 'header' },
        h('th', { key: 'item' }, t.windowHeader),
        h('th', { key: 'off', 'data-active': activeColumn === 'offPeak' ? 'true' : 'false' }, t.offHeader),
        h('th', { key: 'peak', 'data-active': activeColumn === 'peak' ? 'true' : 'false' }, t.peakHeader),
      ))
      for (const model of data.snapshot.models) {
        rows.push(h('tr', { key: `m:${model.name}`, 'data-model': 'true' }, h('td', { colSpan: 3 }, model.name)))
        for (const [key, labelKey] of METRICS) {
          rows.push(h(
            'tr',
            { key: `m:${model.name}:${key}` },
            h('td', null, t[labelKey]),
            h('td', { 'data-active': activeColumn === 'offPeak' ? 'true' : 'false' }, money(model.offPeak[key])),
            h('td', { 'data-active': activeColumn === 'peak' ? 'true' : 'false' }, money(model.peak[key])),
          ))
        }
      }
      children.push(h('table', { className: 'dpp-table', key: 'table' }, h('tbody', null, rows)))
      children.push(h('p', { className: 'dpp-note', key: 'unit' }, t.unitNote))
      children.push(h('p', { className: 'dpp-note', key: 'rule' }, t.ruleNote))

      const provenance = data.provenance
      const updatedAt = stamp(provenance.fetchedAt)
      const sourceLabel = provenance.source === 'official' ? t.sourceOfficial : t.sourceBundled
      const warnings = data.snapshot.warnings ?? []
      children.push(h(
        'div',
        { className: 'dpp-foot', key: 'foot' },
        h(
          'span',
          { className: 'dpp-prov' },
          `${sourceLabel} · ${updatedAt !== null ? `${t.updatedAt} ${updatedAt}` : t.never}`,
          provenance.stale ? ` · ${t.stale}` : '',
        ),
        h(
          'button',
          {
            className: 'dpp-btn',
            type: 'button',
            key: 'refresh',
            disabled: state.busy,
            onClick: () => void load({ refresh: true }),
          },
          state.busy ? t.refreshing : t.refresh,
        ),
      ))
      if (provenance.lastError !== null && provenance.lastError !== undefined) {
        children.push(h('p', { className: 'dpp-note dpp-warn', key: 'error' }, `${t.syncFailed}: ${provenance.lastError}`))
      }
      if (warnings.length > 0) {
        children.push(h('p', { className: 'dpp-note dpp-warn', key: 'warnings' }, `${t.warnings}: ${warnings.join('; ')}`))
      }
      return children
    }

    /**
     * Resolve the active UI language from the locale service, falling back to the
     * browser. Read once at activation: a language switch re-activates the page.
     * @param {object} ctx - the client Cordis context.
     * @returns {'zh'|'en'} the language id.
     */
    function detectLang(ctx) {
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale !== undefined && locale !== null) {
          const snapshot = typeof locale.getSnapshot === 'function'
            ? locale.getSnapshot()
            : typeof locale.getLocale === 'function' ? locale.getLocale() : null
          const id = typeof snapshot === 'string'
            ? snapshot
            : snapshot !== null && snapshot !== undefined ? snapshot.id ?? snapshot.locale ?? snapshot.active : null
          if (typeof id === 'string' && id !== '') return id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch (error) {
        console.error('[dsh-deepseek-peak-pricing] locale detection failed', error)
      }
      const navigatorLang = typeof navigator !== 'undefined'
        ? navigator.language ?? navigator.userLanguage ?? 'zh'
        : 'zh'
      return String(navigatorLang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    /** Services that must exist before this half activates. */
    const inject = ['slots']

    /**
     * Client plugin body: inject the stylesheet and register the composer badge.
     * @param {object} ctx - the client Cordis context.
     * @returns {void}
     */
    function apply(ctx) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined

      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        style.remove()
      }, 'dsh-deepseek-peak-pricing: styles')

      if (slots === undefined || slots === null) {
        console.error('[dsh-deepseek-peak-pricing] slots service is unavailable; the badge is not registered')
        return
      }
      ctx.effect(() => slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'dsh-deepseek-peak-pricing',
        order: 20,
        registrant: 'dsh-deepseek-peak-pricing',
      }, () => h(PeakPricingBadge, { ctx }))), 'dsh-deepseek-peak-pricing: composer badge')

      void load({})
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
