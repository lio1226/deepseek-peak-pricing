/**
 * Peak/off-peak rule tests. Every instant is written as a Beijing wall clock so
 * the assertions read like the official rule sentence.
 *
 * Reference dates (2026):
 * - 10-02 (Fri) … 10-07 (Wed): National Day holiday, off-peak all day.
 * - 10-05 is a Monday inside that holiday — the case a naive weekday rule gets wrong.
 * - 10-10 (Sat) is a 调休 make-up workday — still off-peak, since weekends are.
 * - 10-12 is the first ordinary Monday after the holiday.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUILTIN_HOLIDAYS, buildHolidayIndex, parseHolidayApi, shiftDay } from '../lib/holidays.js'
import { beijingParts, classifyDay, describeBand, formatDuration } from '../lib/schedule.js'
import { bj, bjLabel } from './helpers.mjs'

const holidays = buildHolidayIndex()
const snapshot = {
  rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai' },
}

test('breaks an instant into Beijing wall-clock parts', () => {
  const parts = beijingParts(bj(2026, 10, 12, 9, 30))
  assert.equal(parts.dateKey, '2026-10-12')
  assert.equal(parts.weekday, 1)
  assert.equal(parts.hour, 9)
  assert.equal(parts.minute, 30)
  assert.equal(parts.minutesOfDay, 570)
})

test('classifies ordinary weekdays, weekends and holidays', () => {
  const monday = beijingParts(bj(2026, 10, 12, 9, 30))
  assert.deepEqual(classifyDay(monday, [1, 2, 3, 4, 5], holidays), { peakDay: true, holidayName: undefined, weekend: false })

  const saturday = beijingParts(bj(2026, 10, 10, 9, 30))
  assert.deepEqual(classifyDay(saturday, [1, 2, 3, 4, 5], holidays), { peakDay: false, holidayName: undefined, weekend: true })

  const holidayMonday = beijingParts(bj(2026, 10, 5, 9, 30))
  assert.equal(classifyDay(holidayMonday, [1, 2, 3, 4, 5], holidays).peakDay, false)
  assert.equal(classifyDay(holidayMonday, [1, 2, 3, 4, 5], holidays).holidayName, '国庆节')
})

test('an ordinary Monday inside the first window is peak', () => {
  const band = describeBand(bj(2026, 10, 12, 9, 30), snapshot, holidays)
  assert.equal(band.phase, 'peak')
  assert.equal(bjLabel(band.phaseEndsAt), '2026-10-12 12:00')
  assert.equal(bjLabel(band.startsAt), '2026-10-12 09:00')
  assert.equal(bjLabel(band.nextPeakStartsAt), '2026-10-12 14:00')
})

test('the gap between the two windows is off-peak and points at 14:00', () => {
  const band = describeBand(bj(2026, 10, 12, 12, 30), snapshot, holidays)
  assert.equal(band.phase, 'offPeak')
  assert.equal(bjLabel(band.phaseEndsAt), '2026-10-12 14:00')
  assert.equal(bjLabel(band.startsAt), '2026-10-12 12:00')
})

test('the second window ends at 18:00 and rolls to the next morning', () => {
  const inside = describeBand(bj(2026, 10, 12, 14, 0), snapshot, holidays)
  assert.equal(inside.phase, 'peak')
  assert.equal(bjLabel(inside.phaseEndsAt), '2026-10-12 18:00')

  const evening = describeBand(bj(2026, 10, 12, 18, 30), snapshot, holidays)
  assert.equal(evening.phase, 'offPeak')
  assert.equal(bjLabel(evening.phaseEndsAt), '2026-10-13 09:00')
})

test('a Friday evening rolls across the weekend to Monday 09:00', () => {
  const band = describeBand(bj(2026, 10, 16, 20, 0), snapshot, holidays)
  assert.equal(band.phase, 'offPeak')
  assert.equal(bjLabel(band.phaseEndsAt), '2026-10-19 09:00')
})

test('weekends never produce peak hours, not even the make-up workday', () => {
  for (const [day, hour] of [[10, 9], [10, 15], [11, 10]]) {
    const band = describeBand(bj(2026, 10, day, hour, 0), snapshot, holidays)
    assert.equal(band.phase, 'offPeak', `2026-10-${day} ${hour}:00 should be off-peak`)
    assert.equal(band.peakDay, false)
  }
})

test('statutory holidays suppress peak even on a Monday', () => {
  const band = describeBand(bj(2026, 10, 5, 10, 0), snapshot, holidays)
  assert.equal(band.phase, 'offPeak')
  assert.equal(band.holidayName, '国庆节')
  // The holiday runs to 10-07; 10-08 is the next Thursday and the next peak day.
  assert.equal(bjLabel(band.phaseEndsAt), '2026-10-08 09:00')
})

test('the boundary instants themselves belong to the next phase', () => {
  assert.equal(describeBand(bj(2026, 10, 12, 9, 0), snapshot, holidays).phase, 'peak')
  assert.equal(describeBand(bj(2026, 10, 12, 12, 0), snapshot, holidays).phase, 'offPeak')
  assert.equal(describeBand(bj(2026, 10, 12, 14, 0), snapshot, holidays).phase, 'peak')
  assert.equal(describeBand(bj(2026, 10, 12, 18, 0), snapshot, holidays).phase, 'offPeak')
})

test('falls back to the official default windows for a snapshot without rules', () => {
  const band = describeBand(bj(2026, 10, 12, 9, 30), { rules: {} }, holidays)
  assert.equal(band.phase, 'peak')
  assert.equal(bjLabel(band.phaseEndsAt), '2026-10-12 12:00')
})

test('activity from any day in a holiday week stays off-peak', () => {
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    const band = describeBand(bj(2026, 10, day, 10, 0), snapshot, holidays)
    assert.equal(band.phase, 'offPeak', `2026-10-${day} should be off-peak`)
    assert.equal(band.holidayName, '国庆节')
  }
})

test('formats durations in Chinese units', () => {
  assert.equal(formatDuration(45 * 1000), '45 秒')
  assert.equal(formatDuration(3 * 60 * 1000 + 5 * 1000), '3 分 5 秒')
  assert.equal(formatDuration(2 * 3600 * 1000 + 7 * 60 * 1000), '2 小时 7 分')
  assert.equal(formatDuration(-100), '0 秒')
})

test('expands holiday periods into a date index', () => {
  assert.equal(holidays.get('2026-10-01'), '国庆节')
  assert.equal(holidays.get('2026-10-07'), '国庆节')
  assert.equal(holidays.get('2026-10-08'), undefined)
  assert.equal(holidays.get('2026-02-15'), '春节')
  assert.equal(holidays.get('2026-02-23'), '春节')
  assert.equal(holidays.get('2026-02-24'), undefined)
  assert.equal(holidays.get('2026-06-19'), '端午节')
  assert.equal(holidays.get('2025-10-08'), '国庆节·中秋节')
})

test('shifts date keys across month and year boundaries', () => {
  assert.equal(shiftDay('2026-01-31', 1), '2026-02-01')
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
})

test('adapts a remote holiday API response and merges it over the built-ins', () => {
  const payload = {
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },
      '01-02': { holiday: true, name: '元旦', date: '2027-01-02' },
      '01-04': { holiday: false, name: '调休', date: '2027-01-04' },
    },
  }
  const adapted = parseHolidayApi(payload, 2027)
  assert.deepEqual(adapted.periods, [{ name: '元旦', start: '2027-01-01', end: '2027-01-02' }])
  assert.deepEqual(adapted.workdays, ['2027-01-04'])

  const merged = buildHolidayIndex({ 2027: adapted })
  assert.equal(merged.get('2027-01-02'), '元旦')
  assert.equal(merged.get('2026-10-01'), '国庆节')
})

test('ignores an unknown holiday API shape instead of throwing', () => {
  assert.deepEqual(parseHolidayApi(null, 2027), { periods: [], workdays: [] })
  assert.deepEqual(parseHolidayApi({ holiday: 'nope' }, 2027), { periods: [], workdays: [] })
})

test('every built-in period is well formed and anchored to a real holiday', () => {
  for (const [year, entry] of Object.entries(BUILTIN_HOLIDAYS)) {
    assert.match(String(year), /^\d{4}$/)
    assert.ok(entry.periods.length >= 6, `${year} should list every statutory holiday`)
    for (const period of entry.periods) {
      assert.match(period.start, /^\d{4}-\d{2}-\d{2}$/)
      assert.match(period.end, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(period.start <= period.end, `${year} ${period.name} start must not follow its end`)
      assert.equal(period.start.slice(0, 4), String(year))
    }
  }
})
