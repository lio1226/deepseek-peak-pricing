#!/usr/bin/env node
/**
 * Regenerate `lib/fallback.js` from a saved copy of the official pricing page.
 *
 * The plugin must still answer "which price band am I in" on a machine that has
 * never reached the network — the fallback snapshot is what it serves then. This
 * script derives that snapshot from the very fixture the parser tests use, so the
 * baked numbers can never drift from the parser's reading of the page.
 *
 * Usage:
 *   node scripts/build-fallback.mjs [page.html] [--write]
 *
 * Without `--write` it prints the parsed snapshot as JSON (a dry run).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePricingPage, PRICING_URL_ZH } from '../lib/parse.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
const write = args.includes('--write')
const source = resolve(root, args.find(arg => !arg.startsWith('--')) ?? 'test/fixtures/pricing.zh.html')

const html = readFileSync(source, 'utf8')
const snapshot = parsePricingPage(html, { url: PRICING_URL_ZH, fetchedAt: 0 })

const banner = `/**
 * Bundled offline fallback snapshot — GENERATED, do not edit by hand.
 *
 * Regenerate with:
 *   node scripts/build-fallback.mjs test/fixtures/pricing.zh.html --write
 *
 * Source page: ${PRICING_URL_ZH}
 * \`fetchedAt: 0\` is deliberate: it marks the snapshot as "never fetched from the
 * network", so the host half still tries to refresh on first run.
 */

/** Offline fallback used until the first successful official fetch. */
export const FALLBACK_SNAPSHOT = `

const body = `${JSON.stringify(snapshot, null, 2)}\n`

if (write) {
  writeFileSync(resolve(root, 'lib/fallback.js'), `${banner}${body}`, 'utf8')
  console.log(`✓ wrote lib/fallback.js from ${source}`)
  console.log(`  models: ${snapshot.models.map(model => model.name).join(', ')}`)
  console.log(`  rules:  ${JSON.stringify(snapshot.rules)}`)
  if (snapshot.warnings.length > 0) console.log(`  warnings: ${snapshot.warnings.join('; ')}`)
} else {
  console.log(JSON.stringify(snapshot, null, 2))
}
