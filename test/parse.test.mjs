/**
 * Parser tests, driven by a saved copy of the real official page
 * (`test/fixtures/pricing.zh.html`) so a shape change upstream fails here first.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FALLBACK_SNAPSHOT } from '../lib/fallback.js'
import { PricingParseError, footnotesOf, parsePricingPage, textOf } from '../lib/parse.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(here, 'fixtures/pricing.zh.html'), 'utf8')

test('flattens markup to visible text', () => {
  assert.equal(textOf('<td>百万tokens输入<br>（缓存命中）</td>'), '百万tokens输入 （缓存命中）')
  assert.equal(textOf('<a href="#">Json&nbsp;Output</a>'), 'Json Output')
  assert.equal(textOf('<sup>(1)</sup>'), '(1)')
})

test('parses every model and price bucket out of the official page', () => {
  const snapshot = parsePricingPage(fixture, { url: 'https://example.test/zh', fetchedAt: 1234 })
  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.sourceUrl, 'https://example.test/zh')
  assert.equal(snapshot.fetchedAt, 1234)
  assert.equal(snapshot.currency, 'CNY')
  assert.equal(snapshot.unit, 'per_million_tokens')
  assert.deepEqual(snapshot.warnings, [])

  const names = snapshot.models.map(model => model.name)
  assert.deepEqual(names, ['deepseek-flash', 'deepseek-v4-pro'])

  const flash = snapshot.models[0]
  assert.deepEqual(flash.offPeak, { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 })
  assert.deepEqual(flash.peak, { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 })

  const pro = snapshot.models[1]
  assert.deepEqual(pro.offPeak, { inputCacheHit: 0.15, inputCacheMiss: 4.5, output: 13.5 })
  assert.deepEqual(pro.peak, { inputCacheHit: 0.3, inputCacheMiss: 9, output: 27 })
})

test('reads the peak windows and time zone out of the official footnote', () => {
  const snapshot = parsePricingPage(fixture)
  assert.deepEqual(snapshot.rules.windows, [[540, 720], [840, 1080]])
  assert.deepEqual(snapshot.rules.weekdays, [1, 2, 3, 4, 5])
  assert.equal(snapshot.rules.timeZone, 'Asia/Shanghai')
  assert.equal(snapshot.rules.source, 'parsed')
  assert.equal(snapshot.rules.offPeakIsHalfOfPeak, true)
})

test('keeps the numbered footnotes for display', () => {
  const notes = footnotesOf(fixture)
  assert.equal(notes.length, 3)
  assert.match(notes[1], /空闲时段价格为高峰时段价格的一半/)
  assert.match(notes[1], /9:00 - 12:00/)
})

test('falls back to the official default windows when the footnote disappears', () => {
  const stripped = fixture.replace(/北京时间[^<]*/g, '计费规则见官网')
  const snapshot = parsePricingPage(stripped)
  assert.equal(snapshot.rules.source, 'default')
  assert.deepEqual(snapshot.rules.windows, [[540, 720], [840, 1080]])
})

test('rejects a page with no price table and an empty page', () => {
  assert.throws(() => parsePricingPage('<html><body><p>nothing here</p></body></html>'), PricingParseError)
  assert.throws(() => parsePricingPage(''), PricingParseError)
})

test('rejects a price table whose model is missing a bucket', () => {
  const broken = fixture.replace('<td>0.02元</td>', '<td>—</td>')
  assert.throws(() => parsePricingPage(broken), PricingParseError)
})

test('warns instead of failing when the off-peak ratio changes', () => {
  const changed = fixture.replace('<td>0.04元</td>', '<td>0.05元</td>')
  const snapshot = parsePricingPage(changed)
  assert.equal(snapshot.models[0].peak.inputCacheHit, 0.05)
  assert.equal(snapshot.rules.offPeakIsHalfOfPeak, false)
  assert.equal(snapshot.warnings.length, 1)
  assert.match(snapshot.warnings[0], /not half of peak/)
})

test('bundled fallback matches what the parser reads from the same page', () => {
  const snapshot = parsePricingPage(fixture)
  assert.deepEqual(FALLBACK_SNAPSHOT.models, snapshot.models)
  assert.deepEqual(FALLBACK_SNAPSHOT.rules, snapshot.rules)
  assert.equal(FALLBACK_SNAPSHOT.fetchedAt, 0)
})
