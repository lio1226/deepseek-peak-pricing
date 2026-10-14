/**
 * The peak/off-peak rule, evaluated in Beijing wall-clock time.
 *
 * Official wording (footnote 2 of the pricing page): peak is Beijing time
 * Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese statutory
 * holidays; everything else — weekends, statutory holidays, and the hours
 * outside those windows — is off-peak, at half the peak price.
 *
 * Pure and dependency-free, so the host half, the client panel and the unit
 * tests all read the same rule from the same code. Everything works on epoch
 * milliseconds; Beijing has had no daylight saving since 1991, so a fixed +08:00
 * offset is exact rather than an approximation.
 */
import { holidayNameOf } from './holidays.js'

/** Fixed Beijing offset from UTC, in milliseconds. */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000

const DAY_MS = 24 * 3600 * 1000

/** Phase keys. */
export const PEAK = 'peak'
export const OFF_PEAK = 'offPeak'

/**
 * Break one instant into Beijing wall-clock parts.
 * @param {number} atMs - epoch milliseconds.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number, dateKey: string, minutesOfDay: number}} the parts (`weekday` is ISO: 1=Monday … 7=Sunday).
 */
export function beijingParts(atMs) {
  const local = new Date(atMs + BEIJING_OFFSET_MS)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth() + 1
  const day = local.getUTCDate()
  const hour = local.getUTCHours()
  const minute = local.getUTCMinutes()
  const second = local.getUTCSeconds()
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay()
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    minutesOfDay: hour * 60 + minute,
  }
}

/**
 * Zero-pad one date component.
 * @param {number} value - the component.
 * @returns {string} two digits.
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Epoch milliseconds of a Beijing wall-clock time on the same day as `baseMs`.
 * @param {number} baseMs - any instant on that Beijing day.
 * @param {number} minutesOfDay - minutes since Beijing midnight.
 * @returns {number} epoch milliseconds.
 */
export function beijingTimeOn(baseMs, minutesOfDay) {
  const parts = beijingParts(baseMs)
  return Date.UTC(parts.year, parts.month - 1, parts.day) - BEIJING_OFFSET_MS + minutesOfDay * 60_000
}

/**
 * Epoch milliseconds of Beijing midnight `days` days after the day of `baseMs`.
 * @param {number} baseMs - any instant.
 * @param {number} days - whole-day offset.
 * @returns {number} epoch milliseconds.
 */
function beijingMidnight(baseMs, days) {
  return Date.UTC(...utcDateParts(beijingParts(baseMs))) - BEIJING_OFFSET_MS + days * DAY_MS
}

/**
 * Spread a Beijing date into `Date.UTC` arguments.
 * @param {{year: number, month: number, day: number}} parts - the date parts.
 * @returns {[number, number, number]} year, zero-based month, day.
 */
function utcDateParts(parts) {
  return [parts.year, parts.month - 1, parts.day]
}

/**
 * Read the peak windows off a snapshot, falling back to the official default.
 * @param {object} snapshot - a parsed snapshot.
 * @returns {number[][]} `[startMinutes, endMinutes]` pairs, ascending.
 */
export function windowsOf(snapshot) {
  const windows = snapshot?.rules?.windows
  if (!Array.isArray(windows) || windows.length === 0) return [[540, 720], [840, 1080]]
  return windows
    .filter(window => Array.isArray(window) && window.length === 2 && Number.isFinite(window[0]) && Number.isFinite(window[1]) && window[1] > window[0])
    .map(window => [window[0], window[1]])
    .sort((left, right) => left[0] - right[0])
}

/**
 * Read the peak weekdays off a snapshot (ISO numbers).
 * @param {object} snapshot - a parsed snapshot.
 * @returns {number[]} weekday numbers.
 */
export function weekdaysOf(snapshot) {
  const weekdays = snapshot?.rules?.weekdays
  if (!Array.isArray(weekdays) || weekdays.length === 0) return [1, 2, 3, 4, 5]
  return weekdays.filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
}

/**
 * Whether one Beijing day can contain peak hours at all.
 * @param {{weekday: number, dateKey: string}} parts - Beijing parts.
 * @param {number[]} weekdays - peak weekdays.
 * @param {Map<string, string>} holidays - holiday index.
 * @returns {{peakDay: boolean, holidayName: string|undefined, weekend: boolean}} the day's classification.
 */
export function classifyDay(parts, weekdays, holidays) {
  const holidayName = holidayNameOf(holidays, parts.dateKey)
  const weekend = parts.weekday >= 6
  const peakDay = !weekend && holidayName === undefined && weekdays.includes(parts.weekday)
  return { peakDay, holidayName, weekend }
}

/**
 * Describe the price band at one instant.
 * @param {number} atMs - epoch milliseconds to evaluate.
 * @param {object} snapshot - a parsed snapshot (its `rules` supply windows/weekdays).
 * @param {Map<string, string>} holidays - holiday index.
 * @returns {object} the band description the client renders and counts down from.
 */
export function describeBand(atMs, snapshot, holidays) {
  const weekdays = weekdaysOf(snapshot)
  const windows = windowsOf(snapshot)
  const parts = beijingParts(atMs)
  const day = classifyDay(parts, weekdays, holidays)
  const today = beijingMidnight(atMs, 0)

  /** The peak window containing `atMs`, when there is one. */
  let current = null
  if (day.peakDay) {
    for (const [start, end] of windows) {
      const startMs = today + start * 60_000
      const endMs = today + end * 60_000
      if (atMs >= startMs && atMs < endMs) {
        current = { startMs, endMs }
        break
      }
    }
  }

  if (current !== null) {
    const nextStart = nextPeakStart(atMs, windows, weekdays, holidays)
    return {
      phase: PEAK,
      phaseEndsAt: current.endMs,
      startsAt: current.startMs,
      nextPhase: OFF_PEAK,
      nextPeakStartsAt: nextStart,
      ...day,
      parts,
    }
  }

  const startMs = nextPeakStart(atMs, windows, weekdays, holidays)
  return {
    phase: OFF_PEAK,
    phaseEndsAt: startMs,
    startsAt: previousPeakEnd(atMs, windows, weekdays, holidays),
    nextPhase: PEAK,
    nextPeakStartsAt: startMs,
    ...day,
    parts,
  }
}

/**
 * Epoch milliseconds of the first peak window start strictly after `atMs`,
 * scanning up to 30 days ahead.
 * @param {number} atMs - the instant.
 * @param {number[][]} windows - peak windows in minutes.
 * @param {number[]} weekdays - peak weekdays.
 * @param {Map<string, string>} holidays - holiday index.
 * @returns {number} epoch milliseconds.
 */
function nextPeakStart(atMs, windows, weekdays, holidays) {
  for (let offset = 0; offset <= 30; offset += 1) {
    const midnight = beijingMidnight(atMs, offset)
    const parts = beijingParts(midnight)
    const day = classifyDay(parts, weekdays, holidays)
    if (!day.peakDay) continue
    for (const [start] of windows) {
      const startMs = midnight + start * 60_000
      if (startMs > atMs) return startMs
    }
  }
  return atMs + DAY_MS
}

/**
 * Epoch milliseconds of the most recent peak window end at or before `atMs`.
 * @param {number} atMs - the instant.
 * @param {number[][]} windows - peak windows in minutes.
 * @param {number[]} weekdays - peak weekdays.
 * @param {Map<string, string>} holidays - holiday index.
 * @returns {number} epoch milliseconds.
 */
function previousPeakEnd(atMs, windows, weekdays, holidays) {
  for (let offset = 0; offset >= -30; offset -= 1) {
    const midnight = beijingMidnight(atMs, offset)
    const parts = beijingParts(midnight)
    const day = classifyDay(parts, weekdays, holidays)
    if (!day.peakDay) continue
    for (let index = windows.length - 1; index >= 0; index -= 1) {
      const endMs = midnight + windows[index][1] * 60_000
      if (endMs <= atMs) return endMs
    }
  }
  return atMs - DAY_MS
}

/**
 * Format a duration as `H小时M分` / `M分S秒` / `S秒`, in Chinese units.
 * Shared with the client panel through the payload's preformatted fields.
 * @param {number} ms - the duration.
 * @returns {string} the label.
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}
