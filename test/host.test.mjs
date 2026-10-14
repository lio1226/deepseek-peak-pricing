/**
 * Host-half tests: the route fence, the JSON payload, and one end-to-end refresh
 * that must turn the bundled fallback into an "official" snapshot on disk.
 *
 * `DSH_HOME` is redirected to a temporary directory so the tests never touch the
 * developer's real `~/.dsh/storages`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, buildPayload, dataDirOf } from '../lib/index.js'
import { buildHolidayIndex } from '../lib/holidays.js'
import { bj } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(here, 'fixtures/pricing.zh.html'), 'utf8')

/**
 * Build a fake Cordis context that records the route and the effect disposers.
 * @param {{fetchImpl?: Function}} [options] - optional `globalThis.fetch` replacement.
 * @returns {Promise<{ctx: object, route: object, dispose: () => void, logs: string[], restore: () => void}>} the harness.
 */
async function harness(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peak-pricing-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const originalFetch = globalThis.fetch
  if (options.fetchImpl !== undefined) globalThis.fetch = options.fetchImpl

  const logs = []
  let route = null
  const disposers = []
  const logger = {
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
    error: (message) => logs.push(`error:${message}`),
  }
  const ctx = {
    logger,
    get: () => undefined,
    on: () => () => {},
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register: (registered) => {
        route = registered
        return () => {
          route = null
        }
      },
    },
  }
  return {
    ctx,
    logs,
    get route() {
      return route
    },
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
    restore: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      globalThis.fetch = originalFetch
    },
    home,
  }
}

/**
 * Call one route with fake Node request/response objects.
 * @param {object} route - the registered route.
 * @param {{method?: string, url?: string, host?: string, secFetchSite?: string, origin?: string}} request - request facts.
 * @returns {Promise<{status: number, body: object}>} the response.
 */
async function callRoute(route, request = {}) {
  const headers = { host: request.host ?? '127.0.0.1:19387' }
  if (request.secFetchSite !== undefined) headers['sec-fetch-site'] = request.secFetchSite
  if (request.origin !== undefined) headers.origin = request.origin
  const result = { status: 0, body: null }
  const response = {
    writeHead: (status) => {
      result.status = status
    },
    end: (payload) => {
      result.body = JSON.parse(payload)
    },
  }
  await route.handler({ method: request.method ?? 'GET', url: request.url ?? '/deepseek-pricing/api/state', headers }, response)
  return result
}

test('resolves the data directory under the active DSH home', () => {
  assert.equal(dataDirOf({ DSH_HOME: '/tmp/example-home' }), '/tmp/example-home/storages/dsh-deepseek-peak-pricing')
})

test('buildPayload describes the current band and the built-in holiday table', () => {
  const payload = buildPayload({
    config: { refreshIntervalMs: 6 * 3600 * 1000 },
    snapshot: { models: [{ name: 'deepseek-flash', peak: {}, offPeak: {} }], rules: { windows: [[540, 720]], weekdays: [1] }, notes: [], warnings: [], sourceUrl: 'x', fetchedAt: 0, currency: 'CNY', unit: 'per_token' },
    holidays: buildHolidayIndex(),
    holidayState: { remoteYears: [], remoteError: null },
    source: 'bundled',
    fetchedAt: 0,
    lastAttemptAt: 0,
    lastError: null,
  })
  assert.equal(payload.clientId, 'dsh-deepseek-peak-pricing')
  assert.equal(payload.provenance.source, 'bundled')
  assert.equal(payload.provenance.stale, true)
  assert.equal(payload.holidays.days['2026-10-05'], '国庆节')
  assert.equal(payload.holidays.source, 'builtin')
  assert.ok(Object.keys(payload.snapshot.models).length > 0 || Array.isArray(payload.snapshot.models))
  assert.ok(['peak', 'offPeak'].includes(payload.band.phase))
  assert.equal(typeof payload.band.phaseEndsAt, 'number')
  assert.match(payload.band.beijingTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.deepEqual(payload.display, { locale: 'zh', countdownBelowMs: 3600000, urgentBelowMs: 600000 })
})

test('defaults the display block to Chinese copy with 60/10 minute thresholds', async () => {
  const h = await harness()
  try {
    apply(h.ctx)
    const response = await callRoute(h.route)
    assert.deepEqual(response.body.value.display, { locale: 'zh', countdownBelowMs: 3600000, urgentBelowMs: 600000 })
  } finally {
    h.dispose()
    h.restore()
  }
})

test('honours the user config for language and countdown thresholds', async () => {
  const h = await harness()
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(h.home, 'storages', 'dsh-deepseek-peak-pricing')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ locale: 'en', badgeCountdownMinutes: 30, badgeUrgentMinutes: 45 }),
      'utf8',
    )
    apply(h.ctx)
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
    const response = await callRoute(h.route)
    assert.equal(response.body.value.display.locale, 'en')
    // The urgent window is clamped to stay no wider than the countdown window.
    assert.equal(response.body.value.display.countdownBelowMs, 45 * 60_000)
    assert.equal(response.body.value.display.urgentBelowMs, 30 * 60_000)
  } finally {
    h.dispose()
    h.restore()
  }
})

test('rejects an unknown locale value and clamps out-of-range minutes', async () => {
  const h = await harness()
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(h.home, 'storages', 'dsh-deepseek-peak-pricing')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ locale: 'klingon', badgeCountdownMinutes: 9999, badgeUrgentMinutes: -5 }),
      'utf8',
    )
    apply(h.ctx)
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
    const response = await callRoute(h.route)
    assert.equal(response.body.value.display.locale, 'zh')
    assert.equal(response.body.value.display.countdownBelowMs, 240 * 60_000)
    assert.equal(response.body.value.display.urgentBelowMs, 60_000)
  } finally {
    h.dispose()
    h.restore()
  }
})

test('serves the state route from the bundled fallback before any fetch', async () => {
  const h = await harness()
  try {
    apply(h.ctx)
    assert.equal(h.route.path, '/deepseek-pricing')
    const response = await callRoute(h.route)
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.value.provenance.source, 'bundled')
    assert.deepEqual(response.body.value.snapshot.models.map(model => model.name), ['deepseek-flash', 'deepseek-v4-pro'])
    assert.equal(response.body.value.snapshot.models[0].offPeak.output, 4)
  } finally {
    h.dispose()
    h.restore()
  }
})

test('refuses cross-site, untrusted-host and unknown requests', async () => {
  const h = await harness()
  try {
    apply(h.ctx)
    const crossSite = await callRoute(h.route, { secFetchSite: 'cross-site' })
    assert.equal(crossSite.status, 403)
    const foreign = await callRoute(h.route, { host: 'evil.example.com' })
    assert.equal(foreign.status, 403)
    const foreignOrigin = await callRoute(h.route, { origin: 'http://evil.example.com' })
    assert.equal(foreignOrigin.status, 403)
    const loopbackOrigin = await callRoute(h.route, { origin: 'http://127.0.0.1:19387' })
    assert.equal(loopbackOrigin.status, 200)
    const missing = await callRoute(h.route, { url: '/deepseek-pricing/api/nope' })
    assert.equal(missing.status, 404)
    const wrongMethod = await callRoute(h.route, { method: 'DELETE' })
    assert.equal(wrongMethod.status, 404)
  } finally {
    h.dispose()
    h.restore()
  }
})

test('a manual refresh parses the official page and persists the snapshot', async () => {
  let calls = 0
  const h = await harness({
    fetchImpl: async (url) => {
      calls += 1
      assert.match(String(url), /api-docs\.deepseek\.com/)
      return {
        ok: true,
        status: 200,
        text: async () => fixture,
      }
    },
  })
  try {
    apply(h.ctx)
    const response = await callRoute(h.route, { method: 'POST', url: '/deepseek-pricing/api/refresh' })
    assert.equal(response.status, 200)
    const value = response.body.value
    assert.equal(value.provenance.source, 'official')
    assert.equal(value.provenance.lastError, null)
    assert.ok(value.provenance.fetchedAt > 0)
    assert.equal(value.snapshot.models[0].peak.output, 8)
    assert.ok(calls >= 1)

    const persisted = JSON.parse(await readFile(join(h.home, 'storages', 'dsh-deepseek-peak-pricing', 'snapshot.json'), 'utf8'))
    assert.equal(persisted.snapshot.models[0].peak.output, 8)
    assert.equal(persisted.source, 'official')
  } finally {
    h.dispose()
    h.restore()
  }
})

test('a failing fetch keeps serving the last good snapshot and records the error', async () => {
  const h = await harness({
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  try {
    apply(h.ctx)
    const response = await callRoute(h.route, { method: 'POST', url: '/deepseek-pricing/api/refresh' })
    assert.equal(response.status, 200)
    const value = response.body.value
    assert.equal(value.provenance.source, 'bundled')
    assert.match(value.provenance.lastError, /network down/)
    assert.equal(value.snapshot.models.length, 2)
    assert.ok(h.logs.some(line => line.startsWith('warn:') && line.includes('network down')))
  } finally {
    h.dispose()
    h.restore()
  }
})

test('restores a persisted snapshot instead of refetching one that is fresh', async () => {
  const h = await harness({
    fetchImpl: async () => {
      throw new Error('should not be called for a fresh cache')
    },
  })
  try {
    // Seed a fresh cache, then let the plugin start against it.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(h.home, 'storages', 'dsh-deepseek-peak-pricing')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schemaVersion: 1,
      snapshot: {
        models: [{ name: 'cached-model', peak: { output: 2 }, offPeak: { output: 1 } }],
        rules: { windows: [[540, 720]], weekdays: [1] },
        notes: [],
        warnings: [],
        sourceUrl: 'cached',
        fetchedAt: Date.now(),
        currency: 'CNY',
        unit: 'per_million_tokens',
      },
      source: 'official',
      fetchedAt: Date.now(),
      lastAttemptAt: Date.now(),
      lastError: null,
    }), 'utf8')

    apply(h.ctx)
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
    const response = await callRoute(h.route)
    assert.equal(response.body.value.provenance.source, 'official')
    assert.deepEqual(response.body.value.snapshot.models.map(model => model.name), ['cached-model'])
  } finally {
    h.dispose()
    h.restore()
  }
})

test('reports a holiday Monday as off-peak with the holiday named', () => {
  const payload = buildPayload({
    config: { refreshIntervalMs: 1000 },
    snapshot: { models: [], rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5] }, notes: [], warnings: [], sourceUrl: 'x', currency: 'CNY', unit: 'per_token', fetchedAt: 0 },
    holidays: buildHolidayIndex(),
    holidayState: { remoteYears: [], remoteError: null },
    source: 'official',
    fetchedAt: 0,
    lastAttemptAt: 0,
    lastError: null,
  }, bj(2026, 10, 5, 10, 0))
  assert.equal(payload.band.phase, 'offPeak')
  assert.equal(payload.band.holidayName, '国庆节')
  assert.equal(payload.band.peakDay, false)
  assert.equal(payload.band.weekday, 1)
  assert.equal(payload.band.beijingTime, '2026-10-05 10:00:00')
  assert.equal(payload.band.remainingLabel, '71 小时 0 分')
  assert.equal(payload.provenance.stale, true)
})

test('reports a plain weekday morning as peak with a countdown to noon', () => {
  const payload = buildPayload({
    config: { refreshIntervalMs: 1000 },
    snapshot: { models: [], rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5] }, notes: [], warnings: [], sourceUrl: 'x', currency: 'CNY', unit: 'per_token', fetchedAt: 0 },
    holidays: buildHolidayIndex(),
    holidayState: { remoteYears: [], remoteError: null },
    source: 'official',
    fetchedAt: bj(2026, 10, 12, 11, 30),
    lastAttemptAt: bj(2026, 10, 12, 11, 30),
    lastError: null,
  }, bj(2026, 10, 12, 11, 30))
  assert.equal(payload.band.phase, 'peak')
  assert.equal(payload.band.remainingLabel, '30 分 0 秒')
  assert.equal(payload.band.nextPhase, 'offPeak')
  assert.equal(payload.band.peakDay, true)
  assert.equal(payload.provenance.stale, false)
})
