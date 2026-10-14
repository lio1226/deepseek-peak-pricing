#!/usr/bin/env node
/**
 * End-to-end smoke test for the host half — no DSH restart, no browser.
 *
 * It mounts the plugin on a throwaway `node:http` server standing in for
 * `ctx.webServer`, then talks to the real route with real requests:
 *
 *   1. `GET /deepseek-pricing/api/state`  — must answer from the bundled fallback
 *      (or a previously cached snapshot) before any network access.
 *   2. `POST /deepseek-pricing/api/refresh` — must reach the official page over
 *      the network, parse it and report `provenance.source === 'official'`.
 *   3. a cross-site request must be refused with 403.
 *
 * Note: this runs against the REAL DSH home, so a successful refresh warms the
 * cache the desktop app will pick up on its next start. Point `DSH_HOME` at a
 * scratch directory to keep it isolated.
 *
 * Usage:
 *   node scripts/smoke-host.mjs            # full run, including the network sync
 *   node scripts/smoke-host.mjs --offline  # skip step 2 (no network access)
 */
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

const offline = process.argv.includes('--offline')
const disposers = []
/** @type {{kind: string, path: string, handler: Function}[]} */
const routes = []

const logger = {
  info: (message) => console.log(`  · ${message}`),
  warn: (message) => console.log(`  ! ${message}`),
  error: (message) => console.log(`  ✗ ${message}`),
}

const ctx = {
  logger,
  get: () => undefined,
  on: () => () => {},
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
  const route = routes.find(candidate =>
    candidate.kind === 'exact' ? candidate.path === pathname : pathname.startsWith(candidate.path))
  if (route === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"ok":false}')
    return
  }
  Promise.resolve(route.handler(request, response)).catch((error) => {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { message: String(error) } }))
  })
})

/** Wait for the server to accept connections. */
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

let failed = false
/**
 * Assert one condition and report it.
 * @param {boolean} condition - the condition.
 * @param {string} label - what was checked.
 * @param {unknown} [detail] - extra context on failure.
 */
function check(condition, label, detail) {
  if (condition) {
    console.log(`✓ ${label}`)
    return
  }
  failed = true
  console.log(`✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

try {
  console.log(`\n▸ smoke-testing the host half on ${origin} (DSH_HOME=${process.env.DSH_HOME ?? 'default'})\n`)
  apply(ctx)
  check(routes.length === 1, 'registered exactly one route prefix', routes.map(route => route.path))
  check(routes[0]?.path === '/deepseek-pricing', 'route path is /deepseek-pricing', routes[0]?.path)

  const state = await fetch(`${origin}/deepseek-pricing/api/state`).then(response => response.json())
  check(state.ok === true, 'GET /api/state answers ok', state)
  const value = state.value ?? {}
  check(Array.isArray(value.snapshot?.models) && value.snapshot.models.length > 0, 'payload carries a price table', value.snapshot?.models?.length)
  check(typeof value.band?.phase === 'string', 'payload carries the current band', value.band?.phase)
  check(typeof value.band?.beijingTime === 'string', 'payload carries Beijing wall-clock time', value.band?.beijingTime)
  check(value.holidays?.days?.['2026-10-05'] === '国庆节', 'built-in holiday table is served', value.holidays?.days?.['2026-10-05'])
  console.log(`    band       : ${value.band?.phase} (${value.band?.nextPhase} in ${value.band?.remainingLabel})`)
  console.log(`    beijing    : ${value.band?.beijingTime} ${value.band?.holidayName ?? ''}`)
  console.log(`    source     : ${value.provenance?.source} · fetchedAt=${value.provenance?.fetchedAt}`)
  console.log(`    models     : ${value.snapshot?.models?.map(model => model.name).join(', ')}`)

  const forbidden = await fetch(`${origin}/deepseek-pricing/api/state`, { headers: { 'sec-fetch-site': 'cross-site' } })
  check(forbidden.status === 403, 'cross-site request is refused with 403', forbidden.status)

  if (offline) {
    console.log('\n▸ --offline: skipping the network sync\n')
  } else {
    const refreshed = await fetch(`${origin}/deepseek-pricing/api/refresh`, { method: 'POST' }).then(response => response.json())
    const refreshedValue = refreshed.value ?? {}
    check(refreshed.ok === true, 'POST /api/refresh answers ok', refreshed)
    check(refreshedValue.provenance?.source === 'official', 'refresh reaches and parses the official page', refreshedValue.provenance)
    check(refreshedValue.provenance?.lastError === null, 'refresh records no error', refreshedValue.provenance?.lastError)
    check(refreshedValue.snapshot?.rules?.source === 'parsed', 'peak windows were parsed from the official footnote', refreshedValue.snapshot?.rules)
    console.log(`    band       : ${refreshedValue.band?.phase} (${refreshedValue.band?.nextPhase} in ${refreshedValue.band?.remainingLabel})`)
    console.log(`    models     : ${refreshedValue.snapshot?.models?.map(model => `${model.name} ${model.offPeak.output}/${model.peak.output}`).join(' · ')}`)
    if ((refreshedValue.snapshot?.warnings ?? []).length > 0) {
      console.log(`    warnings   : ${refreshedValue.snapshot.warnings.join('; ')}`)
    }
  }
} catch (error) {
  failed = true
  console.log(`✗ smoke run threw: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      /* best effort */
    }
  }
  await new Promise((resolve) => server.close(resolve))
}

console.log(failed ? '\n✗ host smoke test FAILED\n' : '\n✓ host smoke test passed\n')
process.exit(failed ? 1 : 0)
