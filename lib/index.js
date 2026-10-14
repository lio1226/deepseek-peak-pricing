/**
 * Host half of the DeepSeek peak/off-peak pricing plugin.
 *
 * Responsibilities, in order of importance:
 *
 * 1. Keep one local snapshot of the official price table: fetch the page, parse
 *    it with {@link parsePricingPage}, and persist the result under this DSH
 *    home's `storages/` directory so a restart does not depend on the network.
 * 2. Sync on a timer — once at startup when the cached snapshot has aged out, and
 *    then every `refreshIntervalHours` (6 by default). A failed sync never costs
 *    the user their last good snapshot: the error is recorded and served.
 * 3. Answer the client half over one read-only JSON route:
 *    `GET /deepseek-pricing/api/state` (snapshot + holiday index + the price band
 *    computed for the moment of the request) and `POST
 *    /deepseek-pricing/api/refresh` for the panel's manual refresh button.
 *
 * The client never touches the network or the clock rule itself; it renders the
 * payload and counts down to `band.phaseEndsAt`, then asks again. That keeps one
 * implementation of the rule (this half) instead of two that can drift.
 *
 * Deliberately dependency-free: only Node built-ins, `ctx.webServer` for the
 * route, and optional `ctx.web` for the fetch, so the package works when it is
 * linked into a profile from a source directory with no `node_modules` of its own.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_SNAPSHOT } from './fallback.js'
import {
  BUILTIN_HOLIDAYS,
  BUILTIN_YEARS,
  buildHolidayIndex,
  holidayYearSource,
  makeUpWorkdays,
  parseHolidayApi,
} from './holidays.js'
import { PRICING_URL_EN, PRICING_URL_ZH, PricingParseError, parsePricingPage } from './parse.js'
import { describeBand, formatDuration } from './schedule.js'

/** Plugin identity, matching the loader row in `cordis.patch.yml`. */
export const name = 'dsh-deepseek-peak-pricing'

/** `webServer` owns the HTTP carrier the client half reads; nothing else is mandatory. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/deepseek-pricing'

/** Package id used by the client bundle's module table. */
export const CLIENT_ID = 'dsh-deepseek-peak-pricing'

/** Snapshot schema version persisted to disk. */
const SNAPSHOT_VERSION = 1

/** Default refresh cadence: six hours, matching the official page's churn. */
const DEFAULT_REFRESH_HOURS = 6

/** A cached snapshot older than this is re-fetched at startup. */
const STARTUP_MAX_AGE_MS = 6 * 3600 * 1000

/** A snapshot older than this is reported as stale to the panel. */
const STALE_AFTER_MS = 24 * 3600 * 1000

/** One page fetch may not hang longer than this. */
const DEFAULT_FETCH_TIMEOUT_MS = 20_000

/** Identifies the plugin to the pricing page. */
const USER_AGENT = `${CLIENT_ID} (+https://github.com/deepseek-ai/deepseek-harness)`

/** Panel copy language when `config.json` does not say otherwise. */
const DEFAULT_LOCALE = 'zh'

/** Show a countdown on the badge once the band switches within this many minutes. */
const DEFAULT_COUNTDOWN_MINUTES = 60

/** Emphasise the badge — pulse plus second precision — within this many minutes. */
const DEFAULT_URGENT_MINUTES = 10

/**
 * Clamp a user-supplied number into an inclusive range.
 * @param {unknown} value - the raw value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - used when the value is not a finite number.
 * @returns {number} the clamped value.
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * The resolved configuration used before `config.json` is read; also the source
 * of every default.
 * @returns {object} the default configuration.
 */
function defaultConfig() {
  return {
    refreshIntervalMs: DEFAULT_REFRESH_HOURS * 3600 * 1000,
    fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    pricingUrls: [PRICING_URL_ZH, PRICING_URL_EN],
    holidayApiUrl: null,
    locale: DEFAULT_LOCALE,
    badgeCountdownMs: DEFAULT_COUNTDOWN_MINUTES * 60_000,
    badgeUrgentMs: DEFAULT_URGENT_MINUTES * 60_000,
  }
}

/**
 * Resolve this DSH home's plugin data directory.
 * @param {NodeJS.ProcessEnv} env - the process environment.
 * @returns {string} the directory holding `snapshot.json` and optional `config.json`.
 */
export function dataDirOf(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', CLIENT_ID)
}

/**
 * Read `config.json` when the user wrote one.
 * @param {string} dir - the plugin data directory.
 * @returns {Promise<object>} the user configuration (empty when absent or malformed).
 */
async function readUserConfig(dir) {
  try {
    const raw = await readFile(join(dir, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Coerce the user configuration into the resolved shape.
 * @param {object} raw - the user configuration.
 * @returns {object} the resolved configuration.
 */
function resolveConfig(raw) {
  const hours = Number(raw.refreshIntervalHours)
  const timeout = Number(raw.fetchTimeoutMs)
  const urls = Array.isArray(raw.pricingUrls) ? raw.pricingUrls.filter(url => typeof url === 'string' && url !== '') : []
  // `auto` follows the DSH locale; anything else falls back to Chinese copy.
  const locale = raw.locale === 'en' || raw.locale === 'auto' || raw.locale === 'zh' ? raw.locale : DEFAULT_LOCALE
  const countdown = clampNumber(raw.badgeCountdownMinutes, 1, 240, DEFAULT_COUNTDOWN_MINUTES)
  const urgent = clampNumber(raw.badgeUrgentMinutes, 1, 240, DEFAULT_URGENT_MINUTES)
  return {
    refreshIntervalMs: (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REFRESH_HOURS) * 3600 * 1000,
    fetchTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_FETCH_TIMEOUT_MS,
    pricingUrls: urls.length > 0 ? urls : [PRICING_URL_ZH, PRICING_URL_EN],
    holidayApiUrl: typeof raw.holidayApiUrl === 'string' && raw.holidayApiUrl !== '' ? raw.holidayApiUrl : null,
    locale,
    badgeCountdownMs: Math.max(countdown, urgent) * 60_000,
    badgeUrgentMs: Math.min(countdown, urgent) * 60_000,
  }
}

/**
 * Write a file through a sibling temporary path so a crash cannot truncate it.
 * @param {string} path - the destination.
 * @param {string} content - the payload.
 * @returns {Promise<void>} resolution after the rename.
 */
async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Whether a persisted snapshot carries a usable price table. The stored schema
 * version is checked separately by the caller, so this only judges the shape.
 * @param {unknown} snapshot - the parsed snapshot.
 * @returns {boolean} true when it carries at least one complete model.
 */
function isUsableSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return false
  if (!Array.isArray(snapshot.models) || snapshot.models.length === 0) return false
  return snapshot.models.every(model =>
    model !== null && typeof model === 'object'
    && model.peak !== null && typeof model.peak === 'object'
    && model.offPeak !== null && typeof model.offPeak === 'object')
}

/**
 * Fetch one URL as text, preferring the DSH web service and falling back to the
 * runtime's own `fetch` when no web provider is configured.
 * @param {object} ctx - the Cordis context.
 * @param {string} url - the page to read.
 * @param {number} timeoutMs - per-attempt timeout.
 * @returns {Promise<string>} the response body.
 */
async function fetchText(ctx, url, timeoutMs) {
  const failures = []
  const web = ctx.get('web')
  if (web !== undefined && typeof web.fetch === 'function') {
    try {
      const result = await web.fetch({ url }, AbortSignal.timeout(timeoutMs))
      const status = Number(result?.statusCode)
      if (Number.isFinite(status) && (status < 200 || status >= 300)) throw new Error(`HTTP ${status}`)
      const content = result?.body?.content
      if (typeof content === 'string' && content.trim() !== '') return content
      throw new Error('empty body')
    } catch (error) {
      failures.push(`web: ${messageOf(error)}`)
    }
  }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.trim() === '') throw new Error('empty body')
    return text
  } catch (error) {
    failures.push(`fetch: ${messageOf(error)}`)
  }
  throw new Error(failures.join(' | '))
}

/**
 * Render an unknown thrown value as a short message.
 * @param {unknown} error - the thrown value.
 * @returns {string} the message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Log through the Cordis logger when the context carries one.
 * @param {object} ctx - the Cordis context.
 * @param {'info'|'warn'|'error'} level - the level.
 * @param {string} message - the message.
 * @returns {void}
 */
function log(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') {
      logger[level](`[${CLIENT_ID}] ${message}`)
      return
    }
    console[level === 'info' ? 'log' : level](`[${CLIENT_ID}] ${message}`)
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Whether one request may read this plugin's routes.
 *
 * Same defence as the `/api` gateway and the reference sidebar plugin: the Host
 * header must be a loopback authority (or a configured trusted one) and a
 * browser must not mark the request cross-site. It protects against DNS
 * rebinding and cross-site reads, not against a local attacker.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string[]} trustedHosts - extra authorities this deployment serves.
 * @returns {boolean} true when the request is trusted.
 */
function isTrustedRequest(request, trustedHosts) {
  const headers = request.headers ?? {}
  const host = typeof headers.host === 'string' ? headers.host : undefined
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const loopback = hostUrl.hostname === 'localhost'
    || hostUrl.hostname === '[::1]'
    || hostUrl.hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostUrl.hostname)
  const trusted = Array.isArray(trustedHosts) && trustedHosts.some((entry) => {
    try {
      const trustedUrl = new URL(`http://${entry}`)
      return trustedUrl.hostname === hostUrl.hostname
    } catch {
      return false
    }
  })
  if (!loopback && !trusted) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string') {
    try {
      const originHost = new URL(origin).hostname
      if (originHost !== hostUrl.hostname) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Serialize the holiday index plus its provenance for the client panel.
 * @param {Map<string, string>} index - the holiday index.
 * @param {object} extra - remote holiday provenance.
 * @returns {object} the wire shape.
 */
function holidayPayload(index, extra) {
  return {
    source: extra.remoteYears.length > 0 ? 'builtin+remote' : 'builtin',
    builtinYears: BUILTIN_YEARS,
    builtinSources: Object.fromEntries(BUILTIN_YEARS.map(year => [year, holidayYearSource(year)])),
    remoteYears: extra.remoteYears,
    remoteError: extra.remoteError,
    workdays: BUILTIN_YEARS.flatMap(year => makeUpWorkdays(year)).sort(),
    /** Flat `YYYY-MM-DD → name` map; the panel only needs lookups. */
    days: Object.fromEntries(index),
  }
}

/**
 * Build the JSON payload the client half renders.
 * @param {object} state - the live plugin state.
 * @param {number} [atMs] - the instant to evaluate (defaults to now; injectable for tests).
 * @returns {object} the payload.
 */
export function buildPayload(state, atMs = Date.now()) {
  const now = atMs
  const snapshot = state.snapshot
  const band = describeBand(now, snapshot, state.holidays)
  const age = state.fetchedAt === 0 ? Number.POSITIVE_INFINITY : now - state.fetchedAt
  return {
    clientId: CLIENT_ID,
    serverNow: now,
    snapshot: {
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      currency: snapshot.currency,
      unit: snapshot.unit,
      models: snapshot.models,
      rules: snapshot.rules,
      notes: snapshot.notes,
      warnings: snapshot.warnings,
    },
    provenance: {
      source: state.source,
      fetchedAt: state.fetchedAt,
      lastAttemptAt: state.lastAttemptAt,
      lastError: state.lastError,
      stale: age > STALE_AFTER_MS,
      refreshIntervalMs: state.config.refreshIntervalMs,
    },
    /** Presentation preferences the client half honours. */
    display: {
      locale: state.config.locale ?? DEFAULT_LOCALE,
      countdownBelowMs: Number.isFinite(state.config.badgeCountdownMs)
        ? state.config.badgeCountdownMs
        : DEFAULT_COUNTDOWN_MINUTES * 60_000,
      urgentBelowMs: Number.isFinite(state.config.badgeUrgentMs)
        ? state.config.badgeUrgentMs
        : DEFAULT_URGENT_MINUTES * 60_000,
    },
    holidays: holidayPayload(state.holidays, state.holidayState),
    band: {
      phase: band.phase,
      phaseEndsAt: band.phaseEndsAt,
      startsAt: band.startsAt,
      nextPhase: band.nextPhase,
      nextPeakStartsAt: band.nextPeakStartsAt,
      peakDay: band.peakDay,
      weekend: band.weekend,
      holidayName: band.holidayName ?? null,
      dateKey: band.parts.dateKey,
      weekday: band.parts.weekday,
      beijingTime: `${band.parts.dateKey} ${pad2(band.parts.hour)}:${pad2(band.parts.minute)}:${pad2(band.parts.second)}`,
      remainingLabel: formatDuration(band.phaseEndsAt - now),
    },
  }
}

/**
 * Zero-pad one clock component.
 * @param {number} value - the component.
 * @returns {string} two digits.
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Install the plugin: load the cache, sync on a timer, and serve the routes.
 * @param {object} ctx - the Cordis context.
 * @returns {void}
 */
export function apply(ctx) {
  const dir = dataDirOf()
  const state = {
    config: defaultConfig(),
    snapshot: FALLBACK_SNAPSHOT,
    holidays: buildHolidayIndex(),
    holidayState: { remoteYears: [], remoteError: null },
    source: 'bundled',
    fetchedAt: 0,
    lastAttemptAt: 0,
    lastError: null,
  }
  let disposed = false
  let timer = null
  let inFlight = null

  /** Persist the current snapshot plus provenance, best effort. */
  const persist = async () => {
    try {
      await mkdir(dir, { recursive: true })
      await writeAtomic(join(dir, 'snapshot.json'), JSON.stringify({
        schemaVersion: SNAPSHOT_VERSION,
        snapshot: state.snapshot,
        source: state.source,
        fetchedAt: state.fetchedAt,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
        remoteHolidays: state.holidayState.remoteYears,
      }, null, 2))
    } catch (error) {
      log(ctx, 'warn', `could not persist snapshot: ${messageOf(error)}`)
    }
  }

  /** Refresh the holiday table from the optional remote API. */
  const refreshHolidays = async () => {
    const template = state.config.holidayApiUrl
    if (template === null) return
    const years = [new Date().getUTCFullYear() - 1, new Date().getUTCFullYear(), new Date().getUTCFullYear() + 1]
    const fetched = []
    let failure = null
    for (const year of years) {
      const url = template.replaceAll('{year}', String(year))
      try {
        const text = await fetchText(ctx, url, state.config.fetchTimeoutMs)
        const adapted = parseHolidayApi(JSON.parse(text), year)
        if (adapted.periods.length > 0) {
          state.holidays = buildHolidayIndex({ ...BUILTIN_HOLIDAYS, [year]: adapted })
          fetched.push(year)
        }
      } catch (error) {
        failure = `${year}: ${messageOf(error)}`
      }
    }
    state.holidayState = { remoteYears: fetched, remoteError: failure }
    if (failure !== null) log(ctx, 'warn', `holiday API failed (${failure}); built-in table stays active`)
  }

  /** Fetch and parse the official page, keeping the previous snapshot on failure. */
  const refresh = async (reason) => {
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      state.lastAttemptAt = Date.now()
      /** @type {string[]} */
      const failures = []
      for (const url of state.config.pricingUrls) {
        try {
          const html = await fetchText(ctx, url, state.config.fetchTimeoutMs)
          const parsed = parsePricingPage(html, { url, fetchedAt: Date.now() })
          if (disposed) return null
          state.snapshot = parsed
          state.source = 'official'
          state.fetchedAt = parsed.fetchedAt
          state.lastError = null
          log(ctx, 'info', `pricing synced from ${url} (${parsed.models.length} models)${parsed.warnings.length > 0 ? ` — warnings: ${parsed.warnings.join('; ')}` : ''}`)
          await refreshHolidays()
          await persist()
          return parsed
        } catch (error) {
          const detail = error instanceof PricingParseError ? `parse failed: ${error.message}` : messageOf(error)
          failures.push(`${url}: ${detail}`)
        }
      }
      if (disposed) return null
      state.lastError = failures.join(' | ')
      log(ctx, 'warn', `pricing sync (${reason}) failed, serving ${state.source} snapshot: ${state.lastError}`)
      await persist()
      return null
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** Load the persisted snapshot and config, then sync when the cache has aged out. */
  const start = async () => {
    try {
      const userConfig = await readUserConfig(dir)
      if (disposed) return
      state.config = resolveConfig(userConfig)
      const raw = await readFile(join(dir, 'snapshot.json'), 'utf8')
      const cached = JSON.parse(raw)
      if (disposed) return
      if (cached?.schemaVersion === SNAPSHOT_VERSION && isUsableSnapshot(cached.snapshot)) {
        state.snapshot = cached.snapshot
        state.source = cached.source === 'official' ? 'official' : 'bundled'
        state.fetchedAt = Number(cached.fetchedAt) || 0
        state.lastAttemptAt = Number(cached.lastAttemptAt) || 0
        state.lastError = typeof cached.lastError === 'string' ? cached.lastError : null
        log(ctx, 'info', `restored cached pricing snapshot (${state.snapshot.models.length} models, source=${state.source})`)
      }
    } catch (error) {
      // A missing cache is the normal first run; anything else is worth knowing.
      if (error?.code !== 'ENOENT') log(ctx, 'warn', `could not restore the cached snapshot: ${messageOf(error)}`)
    }
    if (disposed) return
    const age = state.fetchedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - state.fetchedAt
    if (age > STARTUP_MAX_AGE_MS) void refresh('startup')
    timer = setInterval(() => { void refresh('interval') }, state.config.refreshIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** Register the JSON routes; the disposer releases them with the fiber. */
  const registerRoutes = () => {
    const trustedHosts = (() => {
      const runtime = ctx.get('webRuntime')
      const hosts = runtime?.trustedHosts
      return Array.isArray(hosts) ? hosts.filter(host => typeof host === 'string') : []
    })()
    return ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        const send = (status, body) => {
          const payload = JSON.stringify(body)
          response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
          })
          response.end(payload)
        }
        if (!isTrustedRequest(request, trustedHosts)) {
          send(403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
        const route = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
        try {
          if (route === '/api/state' && request.method === 'GET') {
            send(200, { ok: true, value: buildPayload(state) })
            return
          }
          if (route === '/api/refresh' && request.method === 'POST') {
            await refresh('manual')
            send(200, { ok: true, value: buildPayload(state) })
            return
          }
          send(404, { ok: false, error: { code: 'not-found', message: `unknown route ${request.method} ${route}` } })
        } catch (error) {
          send(500, { ok: false, error: { code: 'internal', message: messageOf(error) } })
        }
      },
    })
  }

  ctx.effect(() => {
    const offRoute = registerRoutes()
    void start()
    return () => {
      disposed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      offRoute()
    }
  }, `${CLIENT_ID}: pricing routes and sync timer`)

  log(ctx, 'info', `mounted (data dir: ${dir})`)
}
