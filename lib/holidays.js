/**
 * Chinese statutory holiday calendar, used to decide whether a Monday-to-Friday
 * day still counts as peak.
 *
 * The official rule (footnote 2 of the pricing page) is: peak = Beijing time
 * Monday–Friday, 09:00–12:00 and 14:00–18:00, EXCLUDING Chinese statutory
 * holidays; every other moment — weekends, statutory holidays, and the hours
 * outside those windows — is off-peak. A weekend that is a 调休 make-up workday
 * is therefore still off-peak, which is why the table below only has to be
 * accurate for weekdays.
 *
 * `workdays` is kept for display only (so the panel can explain the make-up
 * workday rule); it never changes the price band.
 */

/**
 * Built-in holiday periods, per year: `{ name, start, end }` with inclusive
 * `YYYY-MM-DD` Beijing dates, plus the official make-up workdays.
 *
 * Sources:
 * - 2025: 国务院办公厅关于2025年部分节假日安排的通知
 * - 2026: 国务院办公厅关于2026年部分节假日安排的通知 (2025-11-04)
 *
 * A year missing from this table simply means "no holiday suppression known";
 * the host half can be pointed at a holiday API (see `parseHolidayApi`) to fill
 * the gap without a new plugin release.
 */
export const BUILTIN_HOLIDAYS = {
  2025: {
    source: '国务院办公厅关于2025年部分节假日安排的通知',
    periods: [
      { name: '元旦', start: '2025-01-01', end: '2025-01-01' },
      { name: '春节', start: '2025-01-28', end: '2025-02-04' },
      { name: '清明节', start: '2025-04-04', end: '2025-04-06' },
      { name: '劳动节', start: '2025-05-01', end: '2025-05-05' },
      { name: '端午节', start: '2025-05-31', end: '2025-06-02' },
      { name: '国庆节·中秋节', start: '2025-10-01', end: '2025-10-08' },
    ],
    workdays: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
  },
  2026: {
    source: '国务院办公厅关于2026年部分节假日安排的通知（2025-11-04）',
    periods: [
      { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
      { name: '春节', start: '2026-02-15', end: '2026-02-23' },
      { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
      { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
      { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
      { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
      { name: '国庆节', start: '2026-10-01', end: '2026-10-07' },
    ],
    workdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
}

/** Years covered by the built-in table, ascending. */
export const BUILTIN_YEARS = Object.keys(BUILTIN_HOLIDAYS).map(Number).sort((left, right) => left - right)

const DAY_MS = 24 * 3600 * 1000

/**
 * Add whole days to a `YYYY-MM-DD` key.
 * @param {string} key - the date key.
 * @param {number} days - day offset.
 * @returns {string} the shifted date key.
 */
export function shiftDay(key, days) {
  const [year, month, day] = key.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return shifted.toISOString().slice(0, 10)
}

/**
 * Expand one year's periods into a `dateKey → name` index.
 * @param {{periods?: {name: string, start: string, end: string}[]}} year - one year's entry.
 * @param {Map<string, string>} [into] - index to fill.
 * @returns {Map<string, string>} the index.
 */
function expandYear(year, into = new Map()) {
  for (const period of year?.periods ?? []) {
    let cursor = period.start
    for (let guard = 0; guard < 400; guard += 1) {
      into.set(cursor, period.name)
      if (cursor >= period.end) break
      cursor = shiftDay(cursor, 1)
    }
  }
  return into
}

/**
 * Build the holiday lookup from the built-in table, optionally merged with
 * periods fetched from a remote holiday API.
 * @param {Record<string, {periods?: {name: string, start: string, end: string}[]}>|Array<{name: string, start: string, end: string}>} [extra] - extra periods, keyed by year or flat.
 * @returns {Map<string, string>} `YYYY-MM-DD` → holiday name.
 */
export function buildHolidayIndex(extra) {
  const index = new Map()
  for (const year of Object.values(BUILTIN_HOLIDAYS)) expandYear(year, index)
  if (Array.isArray(extra)) {
    expandYear({ periods: extra }, index)
  } else if (extra !== undefined && extra !== null) {
    for (const year of Object.values(extra)) expandYear(year, index)
  }
  return index
}

/**
 * Whether a `YYYY-MM-DD` key is a statutory holiday, and which one.
 * @param {Map<string, string>} index - the holiday index.
 * @param {string} dateKey - the Beijing date key.
 * @returns {string|undefined} the holiday name when the day is a holiday.
 */
export function holidayNameOf(index, dateKey) {
  return index instanceof Map ? index.get(dateKey) : undefined
}

/**
 * Make-up workdays (`调休上班`) recorded for one year — display only.
 * @param {number} year - the calendar year.
 * @returns {readonly string[]} date keys, possibly empty.
 */
export function makeUpWorkdays(year) {
  return BUILTIN_HOLIDAYS[year]?.workdays ?? []
}

/**
 * Adapt a third-party holiday API response into holiday periods.
 *
 * Supports the widely used `timor.tech/api/holiday/year/<year>` shape:
 * `{ holiday: { "01-01": { holiday: true, name: "元旦", date: "2026-01-01" }, … } }`
 * where `holiday: false` marks a make-up workday. Unknown shapes yield `[]`
 * instead of throwing, so a changed API can never break the price band.
 * @param {unknown} payload - the parsed JSON body.
 * @param {number} year - the requested year, used when entries omit a date.
 * @returns {{periods: {name: string, start: string, end: string}[], workdays: string[]}} the adaptation.
 */
export function parseHolidayApi(payload, year) {
  const table = payload?.holiday
  const periods = []
  const workdays = []
  if (table === null || typeof table !== 'object') return { periods, workdays }
  /** @type {Map<string, string>} */
  const restDays = new Map()
  for (const entry of Object.values(table)) {
    const date = typeof entry?.date === 'string' ? entry.date.slice(0, 10) : undefined
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (entry.holiday === true) restDays.set(date, typeof entry.name === 'string' && entry.name !== '' ? entry.name : '法定节假日')
    else if (entry.holiday === false) workdays.push(date)
  }
  const sorted = [...restDays.keys()].sort()
  for (const date of sorted) {
    const name = restDays.get(date) ?? '法定节假日'
    const previous = periods[periods.length - 1]
    if (previous !== undefined && shiftDay(previous.end, 1) === date && previous.name === name) previous.end = date
    else periods.push({ name, start: date, end: date })
  }
  return { periods, workdays }
}

/** Human label of one holiday year's provenance. */
export function holidayYearSource(year) {
  return BUILTIN_HOLIDAYS[year]?.source ?? '（内置表未收录该年）'
}
