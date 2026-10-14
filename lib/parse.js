/**
 * Parse the official DeepSeek "模型 & 价格" page into one normalized pricing
 * snapshot.
 *
 * Pure by design: no DOM, no network, no filesystem, no dependencies. The host
 * half reads the page (through `ctx.web.fetch` or global `fetch`) and hands the
 * HTML to {@link parsePricingPage}; the tests hand it a saved fixture. Keeping
 * the parser pure is what makes the offline fallback and the unit tests cheap.
 *
 * The official page publishes no JSON API — the prices live in one HTML table
 * with `rowspan`/`colspan` cells — so the parser rebuilds the logical grid
 * (carrying spanning cells forward) before reading it. Validation is strict
 * about SHAPE (every model must carry every price bucket) and lenient about
 * POLICY (a changed off-peak ratio is reported as a warning, not a failure),
 * because a policy change must not cost the user their last good snapshot.
 */

/** Official Chinese pricing page (the one this plugin tracks). */
export const PRICING_URL_ZH = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** Official English pricing page, used as a fallback source. */
export const PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing/'

/** Time zone the official peak/off-peak rule is written in. */
export const RULE_TIME_ZONE = 'Asia/Shanghai'

/** Peak windows as Beijing wall-clock minutes since midnight: 9:00-12:00, 14:00-18:00. */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([Object.freeze([540, 720]), Object.freeze([840, 1080])])

/** Peak weekdays, ISO numbered: Monday through Friday. */
export const DEFAULT_PEAK_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5])

/** Thrown when the page cannot be understood well enough to publish a snapshot. */
export class PricingParseError extends Error {
  /** @param {string} message - why the page was rejected. */
  constructor(message) {
    super(message)
    this.name = 'PricingParseError'
  }
}

/** Price bucket keys, in display order. */
export const PRICE_KEYS = Object.freeze(['inputCacheHit', 'inputCacheMiss', 'output'])

/** Human labels of the price buckets (Chinese, matching the official table). */
export const PRICE_LABELS = Object.freeze({
  inputCacheHit: '输入（缓存命中）',
  inputCacheMiss: '输入（缓存未命中）',
  output: '输出',
})

/** Phase keys of the peak/off-peak rule. */
export const PHASES = Object.freeze({ peak: 'peak', offPeak: 'offPeak' })

/**
 * Decode the small set of HTML entities the page actually uses.
 * @param {string} text - raw text possibly containing entities.
 * @returns {string} decoded text.
 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/**
 * Render one code point, tolerating a malformed entity.
 * @param {number} code - the code point.
 * @returns {string} the character, or an empty string when out of range.
 */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Flatten one HTML fragment to visible text: `<br>` becomes a space, every tag
 * is dropped, entities are decoded, and runs of whitespace collapse.
 * @param {string} html - the fragment.
 * @returns {string} flattened text.
 */
export function textOf(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr|td|th)>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read one row's cells with their span attributes.
 * @param {string} rowHtml - the `<tr>` inner HTML.
 * @returns {{text: string, colspan: number, rowspan: number}[]} the cells.
 */
function parseCells(rowHtml) {
  const cells = []
  const pattern = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi
  let match
  while ((match = pattern.exec(rowHtml)) !== null) {
    const attributes = match[1] ?? ''
    const span = (name) => {
      const found = new RegExp(`${name}\\s*=\\s*"?\\s*(\\d+)`, 'i').exec(attributes)
      const value = found === null ? 1 : Number.parseInt(found[1], 10)
      return Number.isFinite(value) && value > 0 ? value : 1
    }
    cells.push({ text: textOf(match[2] ?? ''), colspan: span('colspan'), rowspan: span('rowspan') })
  }
  return cells
}

/**
 * Rebuild a logical grid from rows: spanning cells are copied forward and
 * sideways so that `grid[row][column]` always names the cell VISIBLE at that
 * position, exactly as a browser would lay the table out.
 * @param {{text: string, colspan: number, rowspan: number}[][]} rows - parsed rows.
 * @returns {{text: string, colspan: number, rowspan: number}[][]} the logical grid.
 */
function buildGrid(rows) {
  const grid = []
  /** @type {Map<number, {cell: object, left: number}>} */
  const pending = new Map()
  for (const cells of rows) {
    /** @type {object[]} */
    const row = []
    for (const [column, span] of [...pending]) {
      row[column] = span.cell
      span.left -= 1
      if (span.left <= 0) pending.delete(column)
    }
    let column = 0
    for (const cell of cells) {
      while (row[column] !== undefined) column += 1
      for (let offset = 0; offset < cell.colspan; offset += 1) row[column + offset] = cell
      if (cell.rowspan > 1) {
        for (let offset = 0; offset < cell.colspan; offset += 1) {
          pending.set(column + offset, { cell, left: cell.rowspan - 1 })
        }
      }
      column += cell.colspan
    }
    grid.push(row)
  }
  return grid
}

/**
 * Split the page into tables and rebuild each one's logical grid.
 * @param {string} html - the fetched page.
 * @returns {{rows: object[][], text: string}[]} one entry per table.
 */
function tablesOf(html) {
  const tables = []
  const pattern = /<table\b[\s\S]*?<\/table>/gi
  let match
  while ((match = pattern.exec(html)) !== null) {
    const rows = []
    const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi
    let rowMatch
    while ((rowMatch = rowPattern.exec(match[0])) !== null) rows.push(parseCells(rowMatch[0]))
    if (rows.length === 0) continue
    tables.push({ rows: buildGrid(rows), text: textOf(match[0]), html: match[0] })
  }
  return tables
}

/**
 * Map one metric cell's text onto a price bucket key.
 * @param {string} text - the metric cell text.
 * @returns {'inputCacheHit'|'inputCacheMiss'|'output'|undefined} the bucket key.
 */
function bucketOf(text) {
  if (/缓存命中/.test(text)) return 'inputCacheHit'
  if (/缓存未命中/.test(text)) return 'inputCacheMiss'
  if (/输出/.test(text)) return 'output'
  if (/cache\s*hit/i.test(text)) return 'inputCacheHit'
  if (/cache\s*miss/i.test(text)) return 'inputCacheMiss'
  if (/output/i.test(text)) return 'output'
  return undefined
}

/**
 * Parse one price cell such as `0.02元` / `$0.028` into a number.
 * @param {string} text - the cell text.
 * @returns {number|undefined} the parsed amount, or undefined when absent.
 */
function amountOf(text) {
  const match = /-?\d+(?:\.\d+)?/.exec(text)
  if (match === null) return undefined
  const value = Number.parseFloat(match[0])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Map one `时段` cell onto a phase key.
 * @param {string} text - the cell text.
 * @returns {'peak'|'offPeak'|undefined} the phase.
 */
function phaseOf(text) {
  if (/^空闲时段|^空闲|off-?peak/i.test(text)) return PHASES.offPeak
  if (/^高峰时段|^高峰|peak/i.test(text)) return PHASES.peak
  return undefined
}

/**
 * Read the peak windows and weekdays out of the official footnote when the page
 * still states them in the known shape, so a rule change is picked up too.
 * @param {string} text - the table's flattened text plus the following footnotes.
 * @returns {{windows: number[][], weekdays: number[], timeZone: string, source: string}} the rule.
 */
export function parseRules(text) {
  const windows = []
  const pattern = /(\d{1,2}):(\d{2})\s*(?:-|–|—|~|～|至|to)\s*(\d{1,2}):(\d{2})/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    const start = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10)
    const end = Number.parseInt(match[3], 10) * 60 + Number.parseInt(match[4], 10)
    if (start >= 0 && end > start && end <= 24 * 60) windows.push([start, end])
  }
  windows.sort((left, right) => left[0] - right[0])
  const source = windows.length === 0 ? 'default' : 'parsed'
  const resolved = source === 'default' ? DEFAULT_PEAK_WINDOWS.map(window => [...window]) : windows
  return { windows: resolved, weekdays: [...DEFAULT_PEAK_WEEKDAYS], timeZone: RULE_TIME_ZONE, source }
}

/**
 * Turn the official pricing page into a normalized snapshot.
 * @param {string} html - the fetched page.
 * @param {{url?: string, fetchedAt?: number}} [meta] - provenance recorded on the snapshot.
 * @returns {object} the snapshot consumed by the host half and the client panel.
 * @throws {PricingParseError} when the page yields no complete price table.
 */
export function parsePricingPage(html, meta = {}) {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new PricingParseError('empty page')
  }
  const tables = tablesOf(html)
  const priceTables = tables.filter(table => /空闲时段|off-?peak/i.test(table.text) && /高峰时段|peak/i.test(table.text))
  if (priceTables.length === 0) {
    throw new PricingParseError('no table carrying 空闲时段/高峰时段 rows')
  }
  const warnings = []
  let parsed
  for (const table of priceTables) {
    try {
      parsed = readPriceTable(table)
      break
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (parsed === undefined) {
    throw new PricingParseError(`price table unreadable: ${warnings.join('; ') || 'unknown shape'}`)
  }
  const models = parsed
  for (const model of models) {
    for (const key of PRICE_KEYS) {
      const peak = model.peak[key]
      const offPeak = model.offPeak[key]
      if (peak === undefined || offPeak === undefined) continue
      if (peak > 0 && Math.abs(offPeak * 2 - peak) > Math.max(1e-6, peak * 1e-6)) {
        warnings.push(`${model.name}: ${key} off-peak ${offPeak} is not half of peak ${peak}`)
      }
    }
  }
  const notes = footnotesOf(html)
  const rules = parseRules(`${priceTables.map(table => table.text).join(' ')} ${notes.join(' ')}`)
  return {
    schemaVersion: 1,
    sourceUrl: meta.url ?? PRICING_URL_ZH,
    fetchedAt: meta.fetchedAt ?? Date.now(),
    currency: 'CNY',
    unit: 'per_million_tokens',
    models,
    rules: {
      ...rules,
      peakPhase: PHASES.peak,
      offPeakPhase: PHASES.offPeak,
      offPeakIsHalfOfPeak: warnings.every(warning => !warning.includes('is not half of peak')),
    },
    notes,
    warnings,
  }
}

/**
 * Read one already-rebuilt price table.
 * @param {{rows: object[][], text: string}} table - the logical grid.
 * @returns {{models: object[], notes: string[]}} models in column order.
 * @throws {PricingParseError} when the model header or the price block is missing.
 */
function readPriceTable(table) {
  const grid = table.rows
  let headerIndex = -1
  let headerRow = []
  for (let index = 0; index < grid.length; index += 1) {
    if (grid[index].some(cell => cell !== undefined && /^模型$/.test(cell.text))) {
      headerIndex = index
      headerRow = grid[index]
      break
    }
  }
  if (headerIndex < 0) throw new PricingParseError('no 模型 header row')
  let labelEnd = -1
  for (let column = 0; column < headerRow.length; column += 1) {
    if (headerRow[column] !== undefined && /^模型$/.test(headerRow[column].text)) labelEnd = column
  }
  const modelColumns = []
  for (let column = labelEnd + 1; column < headerRow.length; column += 1) {
    const text = headerRow[column]?.text ?? ''
    if (text !== '') modelColumns.push(column)
  }
  if (modelColumns.length === 0) throw new PricingParseError('no model columns in the 模型 header row')
  const models = modelColumns.map((column) => {
    const raw = headerRow[column].text.replace(/\s*\(\d+\)\s*$/, '').trim()
    return { name: raw, key: raw, peak: {}, offPeak: {} }
  })

  let priceRows = 0
  for (const row of grid) {
    let phaseColumn = -1
    let phase
    for (let column = 0; column < row.length; column += 1) {
      const text = row[column]?.text ?? ''
      const found = phaseOf(text)
      if (found !== undefined) {
        phaseColumn = column
        phase = found
        break
      }
    }
    if (phase === undefined) continue
    let bucket
    for (let column = phaseColumn - 1; column >= 0; column -= 1) {
      const found = bucketOf(row[column]?.text ?? '')
      if (found !== undefined) {
        bucket = found
        break
      }
    }
    if (bucket === undefined) continue
    priceRows += 1
    modelColumns.forEach((column, index) => {
      const amount = amountOf(row[column]?.text ?? '')
      if (amount !== undefined) models[index][phase][bucket] = amount
    })
  }
  if (priceRows === 0) throw new PricingParseError('no 空闲时段/高峰时段 price rows')
  const incomplete = models.filter(model =>
    PRICE_KEYS.some(key => typeof model.peak[key] !== 'number' || typeof model.offPeak[key] !== 'number'))
  if (incomplete.length > 0) {
    throw new PricingParseError(`incomplete price buckets for: ${incomplete.map(model => model.name).join(', ')}`)
  }
  return models
}

/**
 * Read the numbered footnotes that follow the price table (`(1) …`, `(2) …`).
 * The peak-window sentence lives in footnote (2), which is outside the table.
 * @param {string} html - the fetched page.
 * @returns {string[]} one entry per footnote, in page order.
 */
export function footnotesOf(html) {
  const notes = []
  const pattern = /<p>\s*\((\d+)\)([\s\S]*?)<\/p>/gi
  let match
  while ((match = pattern.exec(html)) !== null) notes.push(`(${match[1]}) ${textOf(match[2])}`)
  return notes
}
