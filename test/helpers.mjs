/**
 * Timezone helper for the tests, kept out of `lib/` on purpose: the plugin never
 * needs to build a Beijing instant, only to read one.
 */

/** Fixed Beijing offset from UTC, in milliseconds. */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/**
 * Epoch milliseconds of one Beijing wall-clock time.
 * @param {number} year - calendar year.
 * @param {number} month - 1-12.
 * @param {number} day - day of month.
 * @param {number} [hour] - hour of day.
 * @param {number} [minute] - minute of hour.
 * @returns {number} epoch milliseconds.
 */
export function bj(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, 0) - BEIJING_OFFSET_MS
}

/**
 * Render one instant as a Beijing `YYYY-MM-DD HH:MM` label, for assertion messages.
 * @param {number} atMs - epoch milliseconds.
 * @returns {string} the label.
 */
export function bjLabel(atMs) {
  const shifted = new Date(atMs + BEIJING_OFFSET_MS)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}
