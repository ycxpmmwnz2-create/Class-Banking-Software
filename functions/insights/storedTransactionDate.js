const LEGACY_US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/
const PARTS_FORMATTERS = new Map()

/**
 * Normalize only the two date shapes Morgan Bank has actually persisted:
 * canonical ISO instants and the legacy en-US browser wall-clock format.
 * Unknown parseable strings stay rejected so the evidence boundary remains
 * deterministic and fail-closed.
 */
export function normalizeStoredTransactionDate(value, { timeZone = 'UTC' } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 40) return null

  const parsedCanonical = new Date(value)
  if (Number.isFinite(parsedCanonical.getTime()) && parsedCanonical.toISOString() === value) {
    return value
  }

  const match = LEGACY_US_DATE_PATTERN.exec(value)
  if (!match) return null
  const [, monthText, dayText, yearText, hourText, minuteText, secondText, meridiem] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour12 = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    year < 1000 || year > 9999 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour12 < 1 || hour12 > 12 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    return null
  }
  const hour = (hour12 % 12) + (meridiem === 'PM' ? 12 : 0)
  const target = Object.freeze({ year, month, day, hour, minute, second })
  if (!isRealUtcDate(target)) return null
  return localWallClockToIso(target, timeZone)
}

function localWallClockToIso(target, timeZone) {
  let formatter
  try {
    formatter = partsFormatter(timeZone)
  } catch {
    return null
  }
  const targetAsUtc = partsAsUtc(target)
  let candidate = targetAsUtc
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = formattedParts(formatter, candidate)
    const difference = targetAsUtc - partsAsUtc(observed)
    candidate += difference
    if (difference === 0) break
  }

  const matches = []
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 15) {
    const possible = candidate + offsetMinutes * 60_000
    if (sameParts(formattedParts(formatter, possible), target)) matches.push(possible)
  }
  if (!matches.length) return null
  return new Date(Math.min(...matches)).toISOString()
}

function partsFormatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 80) {
    throw new TypeError('timeZone is invalid.')
  }
  if (!PARTS_FORMATTERS.has(timeZone)) {
    PARTS_FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }))
  }
  return PARTS_FORMATTERS.get(timeZone)
}

function formattedParts(formatter, milliseconds) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(milliseconds))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]))
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function partsAsUtc(value) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
}

function sameParts(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second
}

function isRealUtcDate(value) {
  const date = new Date(partsAsUtc(value))
  return date.getUTCFullYear() === value.year && date.getUTCMonth() === value.month - 1 &&
    date.getUTCDate() === value.day && date.getUTCHours() === value.hour &&
    date.getUTCMinutes() === value.minute && date.getUTCSeconds() === value.second
}
