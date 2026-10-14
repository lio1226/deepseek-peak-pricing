/**
 * Client-bundle smoke test.
 *
 * `lib/client.js` is the artifact DSH serves to the browser, so it cannot be
 * imported as a module: it announces itself to `window.__ModuleLoader__` and
 * resolves `react` from the shell's frozen module table. This test plays that
 * table with a minimal fake `react`, then drives the plugin through activation
 * and one render of both the badge and the open panel — enough to catch a
 * syntax error, a stray `require`, a wrong slot name, or a crash in the render
 * path without needing a browser or a real React.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '..', 'lib', 'client.js'), 'utf8')

/** The one payload the fake host serves. */
const PAYLOAD = {
  clientId: 'dsh-deepseek-peak-pricing',
  serverNow: 1790000000000,
  snapshot: {
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    fetchedAt: 1789999000000,
    currency: 'CNY',
    unit: 'per_million_tokens',
    models: [
      { name: 'deepseek-flash', key: 'deepseek-flash', peak: { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 }, offPeak: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 } },
      { name: 'deepseek-v4-pro', key: 'deepseek-v4-pro', peak: { inputCacheHit: 0.3, inputCacheMiss: 9, output: 27 }, offPeak: { inputCacheHit: 0.15, inputCacheMiss: 4.5, output: 13.5 } },
    ],
    rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai', source: 'parsed' },
    notes: ['(2) 空闲时段价格为高峰时段价格的一半'],
    warnings: [],
  },
  provenance: { source: 'official', fetchedAt: 1789999000000, lastAttemptAt: 1789999000000, lastError: null, stale: false, refreshIntervalMs: 21600000 },
  holidays: { source: 'builtin', builtinYears: [2025, 2026], remoteYears: [], remoteError: null, workdays: [], days: { '2026-10-05': '国庆节' } },
  display: { locale: 'zh', countdownBelowMs: 3600000, urgentBelowMs: 600000 },
  band: {
    phase: 'peak',
    phaseEndsAt: 1790003600000,
    startsAt: 1790001600000,
    nextPhase: 'offPeak',
    nextPeakStartsAt: 1790010000000,
    peakDay: true,
    weekend: false,
    holidayName: null,
    dateKey: '2026-10-12',
    weekday: 1,
    beijingTime: '2026-10-12 11:30:00',
    remainingLabel: '30 分 0 秒',
  },
}

/**
 * Deep-clone the fixture payload with overrides merged into `band` / `display`.
 * @param {{band?: object, display?: object}} [overrides] - the fields to override.
 * @returns {object} the payload.
 */
function payloadWith(overrides = {}) {
  const copy = JSON.parse(JSON.stringify(PAYLOAD))
  if (overrides.band !== undefined) copy.band = Object.assign({}, copy.band, overrides.band)
  if (overrides.display !== undefined) copy.display = Object.assign({}, copy.display, overrides.display)
  return copy
}

/**
 * Build a fake React that can render one pass of the plugin's components.
 * @param {{open: boolean}} options - which branch to render.
 * @returns {object} the fake module.
 */
function fakeReact(options) {
  let stateCall = 0
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: () => options.store,
    useState: (initial) => {
      stateCall += 1
      // 1: panel `open`; 2: panel `anchor`; 3+: the clock.
      if (stateCall === 1) return [options.open, () => {}]
      if (stateCall === 2) return [null, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/**
 * Load the bundle in a VM and activate it against a recording fake context.
 * @param {{store?: object, open?: boolean, locale?: string}} [options] - harness options.
 * @returns {Promise<{exports: object, registrations: object[], slotsInjected: string[], fetches: object[], element: object}>} the result.
 */
async function activate(options = {}) {
  const store = options.store ?? { status: 'idle', data: null, error: null, busy: false }
  const react = fakeReact({ store, open: options.open === true })
  const registrations = []
  const slotsInjected = []
  const fetches = []
  let bundle = null

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (record) => {
          bundle = record
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1440,
      innerHeight: 900,
    },
    document: {
      createElement: () => ({ id: '', textContent: '', remove: () => {} }),
      head: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: { language: options.locale ?? 'zh-CN' },
    fetch: async (url, init) => {
      fetches.push({ url, init })
      return { status: 200, ok: true, json: async () => ({ ok: true, value: PAYLOAD }) }
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Error,
  }
  runInNewContext(source, sandbox)
  assert.ok(bundle !== null, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(bundle.id, 'dsh-deepseek-peak-pricing')

  const exports = bundle.factory((id) => {
    assert.equal(id, 'react', `the bundle may only require react, but asked for ${id}`)
    return react
  })
  assert.equal(typeof exports.apply, 'function')
  // Spread into a host-realm array: the bundle's own arrays live in the VM realm.
  assert.deepEqual([...exports.inject], ['slots'])

  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (slot, callback) => {
            slotsInjected.push(slot)
            callback()
            return () => {}
          },
          register: (registration, component) => {
            registrations.push({ registration, component })
            return () => {}
          },
        }
      }
      if (name === 'locale') return options.localeService
      return undefined
    },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  exports.apply(ctx)
  await new Promise(resolveTick => setTimeout(resolveTick, 0))

  const element = registrations.length > 0 ? registrations[0].component({}) : null
  return { exports, registrations, slotsInjected, fetches, element }
}

/**
 * Collect every rendered host node in a fake element tree, invoking function
 * components the way React would (the bundle registers a component, not a tree).
 * @param {unknown} node - the tree root.
 * @param {object[]} [into] - collector.
 * @returns {object[]} the host nodes.
 */
function flatten(node, into = []) {
  if (node === null || node === undefined) return into
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, into)
    return into
  }
  if (typeof node !== 'object') return into
  if (typeof node.type === 'function') return flatten(node.type(node.props ?? {}), into)
  into.push(node)
  for (const child of node.children ?? []) flatten(child, into)
  return into
}

test('announces itself under the package id and exports apply/inject', async () => {
  const result = await activate()
  assert.deepEqual(result.slotsInjected, ['conversation.input.left'])
  assert.equal(result.registrations.length, 1)
  assert.equal(result.registrations[0].registration.name, 'conversation.input.left')
  assert.equal(result.registrations[0].registration.id, 'dsh-deepseek-peak-pricing')
})

test('reads the host payload on activation', async () => {
  const result = await activate()
  assert.equal(result.fetches.length, 1)
  assert.equal(result.fetches[0].url, '/deepseek-pricing/api/state')
  assert.equal(result.fetches[0].init.method, 'GET')
})

test('renders the closed badge as a button with a phase marker', async () => {
  const closed = await activate({ store: { status: 'ready', data: PAYLOAD, error: null, busy: false }, open: false })
  const nodes = flatten(closed.element)
  const button = nodes.find(node => node.type === 'button')
  assert.ok(button !== undefined, 'the badge is a button')
  assert.equal(button.props.className, 'dpp-badge')
  assert.equal(button.props['data-phase'], 'peak')
  assert.equal(button.props['aria-expanded'], 'false')
  assert.equal(nodes.some(node => node.type === 'table'), false, 'the table is not rendered while closed')
})

test('renders the open panel with every model, both price columns and the rule', async () => {
  const open = await activate({ store: { status: 'ready', data: PAYLOAD, error: null, busy: false }, open: true })
  const nodes = flatten(open.element)
  const panel = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-pop')
  assert.ok(panel !== undefined, 'the panel renders when open')
  assert.equal(panel.props.role, 'dialog')

  const table = nodes.find(node => node.type === 'table')
  assert.ok(table !== undefined, 'the panel renders the price table')

  const text = JSON.stringify(table)
  assert.match(text, /deepseek-flash/)
  assert.match(text, /deepseek-v4-pro/)
  assert.match(text, /输入 · 缓存命中/)
  assert.match(text, /输出/)
  // Both bands are shown, with the active one flagged for highlighting.
  assert.match(text, /"data-active":"true"/)
  const tableNodes = flatten(table)
  const highlighted = tableNodes.filter(node => node.type === 'td' && node.props['data-active'] === 'true')
  assert.ok(highlighted.length >= 3, 'each metric highlights the active band cell')

  const rules = nodes.filter(node => node.props !== undefined && typeof node.props.className === 'string' && node.props.className.includes('dpp-note'))
  assert.ok(rules.some(node => String(node.children[0]).includes('高峰时段')), 'the rule sentence is rendered')
  assert.ok(rules.some(node => String(node.children[0]).includes('元 / 百万 tokens')), 'the unit note is rendered')
})

test('defaults to Chinese even when the browser is English', async () => {
  const result = await activate({
    store: { status: 'ready', data: PAYLOAD, error: null, busy: false },
    open: false,
    locale: 'en-US',
  })
  const button = flatten(result.element).find(node => node.type === 'button')
  assert.equal(button.children[1].children[0], '高峰')
})

test('locale: en renders the English copy', async () => {
  const result = await activate({
    store: { status: 'ready', data: payloadWith({ display: { locale: 'en' } }), error: null, busy: false },
    open: false,
    locale: 'zh-CN',
  })
  const button = flatten(result.element).find(node => node.type === 'button')
  assert.equal(button.children[1].children[0], 'Peak')
})

test('locale: auto follows the DSH locale service, then the browser', async () => {
  const viaService = await activate({
    store: { status: 'ready', data: payloadWith({ display: { locale: 'auto' } }), error: null, busy: false },
    open: false,
    locale: 'zh-CN',
    localeService: { getSnapshot: () => ({ id: 'en-US' }) },
  })
  const serviceButton = flatten(viaService.element).find(node => node.type === 'button')
  assert.equal(serviceButton.children[1].children[0], 'Peak')

  const viaBrowser = await activate({
    store: { status: 'ready', data: payloadWith({ display: { locale: 'auto' } }), error: null, busy: false },
    open: false,
    locale: 'zh-CN',
    localeService: { getSnapshot: () => 'zh-CN' },
  })
  const browserButton = flatten(viaBrowser.element).find(node => node.type === 'button')
  assert.equal(browserButton.children[1].children[0], '高峰')
})

test('badge countdown appears only inside the configured window', async () => {
  const far = await activate({
    store: { status: 'ready', data: payloadWith({ band: { phaseEndsAt: Date.now() + 3 * 3600 * 1000 } }), error: null, busy: false },
    open: false,
  })
  const farButton = flatten(far.element).find(node => node.type === 'button')
  assert.equal(farButton.children[2], null, 'no countdown three hours out')
  assert.equal(farButton.props['data-urgent'], 'false')

  const soon = await activate({
    store: { status: 'ready', data: payloadWith({ band: { phaseEndsAt: Date.now() + 30 * 60 * 1000 } }), error: null, busy: false },
    open: false,
  })
  const soonButton = flatten(soon.element).find(node => node.type === 'button')
  assert.equal(soonButton.children[2].props.className, 'dpp-count')
  assert.equal(soonButton.children[2].children[0], '30分')
  assert.equal(soonButton.props['data-urgent'], 'false')
})

test('an imminent switch turns the badge into a labelled countdown', async () => {
  const imminent = await activate({
    store: {
      status: 'ready',
      data: payloadWith({ band: { phase: 'offPeak', nextPhase: 'peak', phaseEndsAt: Date.now() + 5 * 60 * 1000 } }),
      error: null,
      busy: false,
    },
    open: false,
    locale: 'en-US',
  })
  const button = flatten(imminent.element).find(node => node.type === 'button')
  assert.equal(button.children[1].children[0], '谷时')
  assert.equal(button.children[2].props.className, 'dpp-count dpp-next')
  assert.match(button.children[2].children[0], /^→高峰 [45]:\d\d$/)
  assert.equal(button.props['data-urgent'], 'true')
  assert.match(button.props.title, /即将切换/)
  assert.match(button.props.title, /高峰/)
})

test('the panel exposes a resize handle and a maximize control', async () => {
  const open = await activate({ store: { status: 'ready', data: PAYLOAD, error: null, busy: false }, open: true })
  const nodes = flatten(open.element)
  const panel = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-pop')
  assert.equal(typeof panel.props.style.width, 'string')
  assert.equal(panel.props['data-maximized'], 'false')

  const handle = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-resize')
  assert.ok(handle !== undefined, 'the resize handle renders')
  assert.equal(typeof handle.props.onPointerDown, 'function')

  const maximize = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-max')
  assert.ok(maximize !== undefined, 'the maximize button renders')
  assert.equal(typeof maximize.props.onClick, 'function')

  const head = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-head')
  assert.equal(typeof head.props.onDoubleClick, 'function', 'double-clicking the title bar toggles the size')
})

test('reports a load failure instead of rendering an empty panel', async () => {
  const failed = await activate({ store: { status: 'error', data: null, error: 'HTTP 500', busy: false }, open: true })
  const nodes = flatten(failed.element)
  const panel = nodes.find(node => node.props !== undefined && node.props.className === 'dpp-pop')
  const text = JSON.stringify(panel)
  assert.match(text, /读取失败|Could not load/)
})
