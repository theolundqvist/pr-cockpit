import * as chrono from "chrono-node"
import cityTimezones from "city-timezones"
import * as ct from "countries-and-timezones"
import { differenceInDays, format } from "date-fns"
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz"

type DateMatch = {
  label: string
  value: string
  date: Date
  timezone: string | null
}

/**
 * constants
 */
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]

const MONTH_ABBREVS: Record<string, string> = {
  jan: "january",
  feb: "february",
  mar: "march",
  apr: "april",
  jun: "june",
  jul: "july",
  aug: "august",
  sep: "september",
  oct: "october",
  nov: "november",
  dec: "december",
}

const RELATIVE_DAYS = ["today", "tomorrow"]
const MODIFIERS = ["next", "this", "on"]
const RELATIVE_PERIODS = ["week", "month", "year", "weekend"]
type DurationUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year" | "business_day"

const DURATION_UNIT_ALIASES: Record<string, DurationUnit> = {
  secs: "second",
  mins: "minute",
  hr: "hour",
  hrs: "hour",
  d: "day",
  w: "week",
  y: "year",
  yr: "year",
  yrs: "year",
}

const DURATION_UNIT_CANONICAL: DurationUnit[] = ["second", "minute", "hour", "day", "week", "month", "year"]

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
}

function matchDurationUnit(input: string): DurationUnit | undefined {
  const lower = input.toLowerCase()

  // Check explicit aliases first (irregular abbreviations like "hrs", "d", "w")
  if (lower in DURATION_UNIT_ALIASES) return DURATION_UNIT_ALIASES[lower]

  // Check if input is a prefix of any canonical form (singular or plural)
  for (const unit of DURATION_UNIT_CANONICAL) {
    if (unit.startsWith(lower) || `${unit}s`.startsWith(lower)) {
      return unit
    }
  }

  return undefined
}

function matchQualifiedDurationUnit({
  qualifier,
  unitToken,
}: {
  qualifier: string | null
  unitToken: string
}): DurationUnit | undefined {
  const unit = matchDurationUnit(unitToken)
  if (qualifier === null) return unit
  return unit === "day" ? "business_day" : undefined
}

const FRIDAY = 5
const WORKWEEK_DAYS = 5
const WEEKEND_DAYS = 2
const WEEK_DAYS = WORKWEEK_DAYS + WEEKEND_DAYS

// Weekend starts are treated as Friday so business days count from the next Monday.
function businessDayOffset({ weekday, count }: { weekday: number; count: number }): number {
  const daysPastFriday = weekday === 0 ? WEEKEND_DAYS : Math.max(weekday - FRIDAY, 0)
  const startWeekday = daysPastFriday > 0 ? FRIDAY : weekday
  const remainder = count % WORKWEEK_DAYS
  const crossesWeekend = startWeekday + remainder > FRIDAY
  return (
    Math.floor(count / WORKWEEK_DAYS) * WEEK_DAYS +
    remainder +
    (crossesWeekend ? WEEKEND_DAYS : 0) -
    daysPastFriday
  )
}

function parseDurationCount(input: string): number | undefined {
  const lower = input.toLowerCase()
  if (/^\d+$/.test(lower)) return parseInt(lower, 10)
  return NUMBER_WORDS[lower]
}

// Unambiguous timezone abbreviations (skipping CST, IST, BST which have multiple meanings)
const TIMEZONE_ABBREVIATIONS: Record<string, { name: string; timezone: string }> = {
  // European
  cet: { name: "CET", timezone: "Europe/Paris" },
  cest: { name: "CEST", timezone: "Europe/Paris" },
  wet: { name: "WET", timezone: "Europe/Lisbon" },
  eet: { name: "EET", timezone: "Europe/Helsinki" },
  eest: { name: "EEST", timezone: "Europe/Helsinki" },
  gmt: { name: "GMT", timezone: "Europe/London" },
  // US
  est: { name: "EST", timezone: "America/New_York" },
  edt: { name: "EDT", timezone: "America/New_York" },
  pst: { name: "PST", timezone: "America/Los_Angeles" },
  pdt: { name: "PDT", timezone: "America/Los_Angeles" },
  mst: { name: "MST", timezone: "America/Denver" },
  mdt: { name: "MDT", timezone: "America/Denver" },
  // Asia/Pacific
  jst: { name: "JST", timezone: "Asia/Tokyo" },
  kst: { name: "KST", timezone: "Asia/Seoul" },
  hkt: { name: "HKT", timezone: "Asia/Hong_Kong" },
  sgt: { name: "SGT", timezone: "Asia/Singapore" },
  aest: { name: "AEST", timezone: "Australia/Sydney" },
  aedt: { name: "AEDT", timezone: "Australia/Sydney" },
  awst: { name: "AWST", timezone: "Australia/Perth" },
  nzst: { name: "NZST", timezone: "Pacific/Auckland" },
  nzdt: { name: "NZDT", timezone: "Pacific/Auckland" },
  // UTC
  utc: { name: "UTC", timezone: "UTC" },
}

// Popular cities with their expected timezones for better ranking
const POPULAR_CITIES: Record<string, string> = {
  "new york": "America/New_York",
  london: "Europe/London",
  tokyo: "Asia/Tokyo",
  paris: "Europe/Paris",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  singapore: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  sydney: "Australia/Sydney",
  berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  stockholm: "Europe/Stockholm",
  dubai: "Asia/Dubai",
  toronto: "America/Toronto",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  boston: "America/New_York",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai",
}

/**
 * utility functions
 */
function findPrefixMatches(prefix: string, options: string[]): string[] {
  if (!prefix) return []
  const lower = prefix.toLowerCase()
  return options.filter((opt) => opt.toLowerCase().startsWith(lower))
}

function expandMonth(partial: string): string[] {
  const lower = partial.toLowerCase()
  if (MONTH_ABBREVS[lower]) {
    return [MONTH_ABBREVS[lower]]
  }
  return findPrefixMatches(partial, MONTH_NAMES)
}

function expandDayName(partial: string): string[] {
  return findPrefixMatches(partial, DAY_NAMES)
}

function expandRelativeDay(partial: string): string[] {
  return findPrefixMatches(partial, RELATIVE_DAYS)
}

function expandModifier(partial: string): string[] {
  return findPrefixMatches(partial, MODIFIERS)
}

function expandPeriod(partial: string): string[] {
  const lower = partial.toLowerCase()
  // Return exact match only if it exists to avoid "week" matching "weekend"
  if (RELATIVE_PERIODS.includes(lower)) {
    return [lower]
  }
  return findPrefixMatches(partial, RELATIVE_PERIODS)
}

const DAYPART_TIMES: Record<string, string> = {
  morning: "9am",
  afternoon: "2pm",
  evening: "6pm",
  night: "8pm",
}

function matchDaypartTime(token: string): string | null {
  if (token.length < 3) return null
  const names = Object.keys(DAYPART_TIMES).filter((name) => name.startsWith(token))
  return names.length === 1 ? (DAYPART_TIMES[names[0] ?? ""] ?? null) : null
}

function uniqueWeekday(token: string): string | null {
  const matches = expandDayName(token)
  return matches.length === 1 ? (matches[0] ?? null) : null
}

// Prefix-aware rewrite of phrasings the component parser can't represent into ones it can:
// "next week friday" → "next friday"; day-parts ("friday aftern" → "friday at 2pm") only in a day context.
function normalizeRelativePhrases(query: string): string {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const isWeekPrefix = (token: string): boolean => "week".startsWith(token.replace(/'s$/, ""))

  const hasExplicitTime = tokens.some((token) => isExplicitTime(token))

  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ""
    const next = tokens[i + 1]
    const after = tokens[i + 2]
    const prev = out[out.length - 1]

    if (tok.length >= 3 && "tonight".startsWith(tok)) {
      out.push("today")
      if (!hasExplicitTime) out.push("at", "8pm")
      continue
    }

    const daypartTime = matchDaypartTime(tok)
    const inDayContext = isDaypartContext(prev, tokens.length)
    if (daypartTime && inDayContext && hasDaypartAnchor(prev, tok)) {
      if (prev === "this") out[out.length - 1] = "today"
      if (!hasExplicitTime) out.push("at", daypartTime)
      continue
    }

    const weekday = uniqueWeekday(tok)
    if (weekday && isWeekModifier(next) && after !== undefined && isWeekPrefix(after)) {
      out.push(next, weekday)
      i += 2
      continue
    }
    if (isWeekModifier(tok) && next !== undefined && isWeekPrefix(next) && after) {
      const trailingWeekday = uniqueWeekday(after)
      if (trailingWeekday) {
        out.push(tok, trailingWeekday)
        i += 2
        continue
      }
    }

    out.push(tok)
  }

  return out.join(" ")
}

/**
 * Check if a string is explicitly a time (has am/pm or colon with valid time range)
 */
function isExplicitTime(str: string): boolean {
  const lower = str.toLowerCase()
  if (lower === "noon" || lower === "midnight") return true
  // Has am/pm marker
  if (/(?:^|\D)\d+\s*[ap]m?$/i.test(lower)) return true
  // Has colon/dot separator with hour in 24h range
  if (/^\d{1,2}[:.]\d{0,2}$/.test(lower)) {
    const hour = parseInt(lower.split(/[:.]/, 1)[0] ?? "", 10)
    return hour <= 23
  }
  return false
}

const CLOCK_NUMBER_FOLLOWERS = ["at", "on", "in", "of", "o'clock", "oclock"]

function canFollowClockNumber(token: string): boolean {
  return (
    CLOCK_NUMBER_FOLLOWERS.includes(token) ||
    /^[ap]\.?(?:m\.?)?$/.test(token) ||
    isExplicitTime(token) ||
    matchDaypartTime(token) !== null ||
    expandModifier(token).length > 0 ||
    expandRelativeDay(token).length > 0 ||
    expandDayName(token).length > 0 ||
    expandMonth(token).length > 0
  )
}

function hasNumberBeforeNonTimeWord(tokens: string[]): boolean {
  return tokens.some((token, index) => {
    const next = tokens[index + 1]
    return /^\d+$/.test(token) && next !== undefined && /^[a-z]/.test(next) && !canFollowClockNumber(next)
  })
}

/**
 * Check if input uses 24-hour format
 */
function is24HourFormat(str: string): boolean {
  const lower = str.toLowerCase()
  if (/[ap]m?$/i.test(lower)) return false
  const match = lower.match(/^(\d{1,2})/)
  if (!match) return false
  const hour = parseInt(match[1] ?? "", 10)
  return hour > 12 || hour === 0
}

/**
 * Expand a time string to possible times
 */
function expandTime(partial: string): string[] {
  const results: string[] = []
  const lower = partial.toLowerCase().trim()

  if (lower === "noon") return ["12:00"]
  if (lower === "midnight") return ["00:00"]

  const match = lower.match(/^(\d{1,2})([:.])?((\d{0,2}))?(\s*[ap]m?)?$/i)
  if (!match) return []

  const hourStr = match[1] ?? ""
  const separator = match[2]
  const minuteStr = match[4] || ""
  const meridiem = (match[5] || "").trim().toLowerCase()

  const hour = parseInt(hourStr, 10)
  if (hour > 23) return []

  const use24Hour = is24HourFormat(partial)

  let meridiems: string[] = []
  if (meridiem) {
    if (meridiem.startsWith("a")) {
      meridiems = ["am"]
    } else if (meridiem.startsWith("p")) {
      meridiems = ["pm"]
    }
  } else if (use24Hour) {
    meridiems = [""]
  } else {
    meridiems = ["am", "pm"]
  }

  let minutes: string[] = []
  if (separator && minuteStr.length === 2) {
    const min = parseInt(minuteStr, 10)
    if (min <= 59) {
      minutes = [minuteStr.padStart(2, "0")]
    }
  } else if (separator && minuteStr.length === 1) {
    if (minuteStr === "0") {
      minutes = ["00"]
    } else if (minuteStr === "3") {
      minutes = ["30"]
    } else {
      minutes = [`${minuteStr}0`]
    }
  } else if (separator) {
    minutes = ["00", "30"]
  } else {
    minutes = ["00"]
  }

  for (const min of minutes) {
    for (const mer of meridiems) {
      if (use24Hour && !mer) {
        const h = hour.toString().padStart(2, "0")
        results.push(`${h}:${min}`)
      } else if (mer) {
        let h = hour
        if (h === 0) h = 12
        if (h > 12) h = h - 12
        results.push(`${h}:${min}${mer}`)
      }
    }
  }

  return results
}

/**
 * Expand day number with continuations
 */
function expandDayNumber(partial: string): string[] {
  const num = parseInt(partial, 10)
  if (isNaN(num) || num < 1 || num > 31) return []

  const results: string[] = []
  if (num >= 1 && num <= 31) {
    results.push(partial)
  }

  if (partial.length === 1) {
    for (let i = 0; i <= 9; i++) {
      const twoDigit = parseInt(partial + i, 10)
      if (twoDigit >= 10 && twoDigit <= 31) {
        results.push(twoDigit.toString())
      }
    }
  }

  return results
}

/**
 * Fuzzy match cities
 */
function matchCities(partial: string): Array<{ city: string; timezone: string }> {
  if (!partial || partial.length < 2) return []

  const lower = partial.toLowerCase()

  // If input exactly matches a popular city, return only that city
  const expectedTimezone = POPULAR_CITIES[lower]
  if (expectedTimezone) {
    const capitalizedCity = lower
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
    return [{ city: capitalizedCity, timezone: expectedTimezone }]
  }

  const results: Array<{ city: string; timezone: string; score: number }> = []
  const seen = new Set<string>()

  const cityResults = cityTimezones.findFromCityStateProvince(partial)

  for (const city of cityResults) {
    const cityLower = city.city.toLowerCase()

    let score = 0

    // Highest priority: exact match on full city name
    if (cityLower === lower) {
      score += 300
    }
    // High priority: city name starts with full input (e.g., "san francisco" matches "San Francisco de...")
    else if (cityLower.startsWith(lower)) {
      score += 150
    }
    // Medium priority: input starts with city name (partial typing)
    else if (lower.startsWith(cityLower)) {
      score += 100
    }
    // Lower priority: partial word match
    else if (cityLower.includes(lower)) {
      score += 50
    }

    // Popularity bonus - only if city name AND timezone match a well-known city
    const expectedTimezone = POPULAR_CITIES[cityLower]
    if (expectedTimezone && city.timezone === expectedTimezone) {
      score += 200
    }

    // Slight penalty for longer city names (prefer simpler names)
    score -= city.city.length * 0.5

    // Deduplicate by city name - keep only the highest scoring entry
    if (seen.has(cityLower)) {
      const existingIdx = results.findIndex((r) => r.city.toLowerCase() === cityLower)
      const existing = results[existingIdx]
      if (existing && score > existing.score) {
        results[existingIdx] = { city: city.city, timezone: city.timezone, score }
      }
      continue
    }
    seen.add(cityLower)

    results.push({ city: city.city, timezone: city.timezone, score })
  }

  const allTimezones = ct.getAllTimezones()
  for (const tzName of Object.keys(allTimezones)) {
    const cityPart = tzName.split("/").pop()?.replace(/_/g, " ").toLowerCase()
    if (cityPart && cityPart.startsWith(lower)) {
      const key = `${cityPart}-${tzName}`
      if (!seen.has(key)) {
        seen.add(key)
        results.push({
          city: cityPart.charAt(0).toUpperCase() + cityPart.slice(1),
          timezone: tzName,
          score: 40,
        })
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ city, timezone }) => ({ city, timezone }))
}

/**
 * Match timezone abbreviations (e.g., CET, PST, EST)
 */
function matchTimezoneAbbreviation(partial: string): Array<{ city: string; timezone: string }> {
  if (!partial || partial.length < 2) return []
  const lower = partial.toLowerCase()
  const results: Array<{ city: string; timezone: string }> = []

  for (const [abbrev, { name, timezone }] of Object.entries(TIMEZONE_ABBREVIATIONS)) {
    if (abbrev.startsWith(lower)) {
      results.push({ city: name, timezone })
    }
  }

  return results.slice(0, 5)
}

interface ParsedComponents {
  modifier: string | null
  dateType: "day_name" | "relative" | "period" | "month_day" | "in_duration" | null
  dayName: string[] | null
  relativePeriod: string[] | null
  month: string[] | null
  dayNumber: string[] | null
  time: string[] | null
  city: Array<{ city: string; timezone: string }> | null
  hasExplicitTime: boolean
  inDuration: Array<{ count: number; unit: DurationUnit }> | null
}

/**
 * Smart context-aware query parser
 */
function parseQuery(query: string): ParsedComponents {
  const result: ParsedComponents = {
    modifier: null,
    dateType: null,
    dayName: null,
    relativePeriod: null,
    month: null,
    dayNumber: null,
    time: null,
    city: null,
    hasExplicitTime: false,
    inDuration: null,
  }

  let remaining = normalizeRelativePhrases(query).trim()

  // Check for "[in] X [business|working] day(s)/week(s)/month(s)/year(s)" pattern - "in" is optional, partial units supported
  const inDurationMatch = remaining.match(
    /^(?:in\s+)?(?:(\d+)\s*|([a-z]+)\s+(?:of\s+)?)(?:(business|working)\s+)?([a-z]\w*)$/i
  )
  if (inDurationMatch) {
    const unit = matchQualifiedDurationUnit({
      qualifier: inDurationMatch[3] ?? null,
      unitToken: inDurationMatch[4] ?? "",
    })
    const count = parseDurationCount(inDurationMatch[1] ?? inDurationMatch[2] ?? "")
    if (unit && count !== undefined) {
      result.inDuration = [{ count, unit }]
      result.dateType = "in_duration"
      return result
    }
  }

  // Check for "in X" without unit - suggest all duration options
  const inNumberOnlyMatch = remaining.match(/^in\s+(\d+)$/i)
  if (inNumberOnlyMatch) {
    const count = parseInt(inNumberOnlyMatch[1] ?? "", 10)
    result.inDuration = [
      { count, unit: "day" },
      { count, unit: "week" },
      { count, unit: "month" },
    ]
    result.dateType = "in_duration"
    return result
  }

  // 1. Check for timezone abbreviation or multi-word city at the end (greedy)
  const words = remaining.split(/\s+/)
  for (let cityWordCount = Math.min(3, words.length); cityWordCount >= 1; cityWordCount--) {
    const potentialCity = words
      .slice(-cityWordCount)
      .join(" ")
      .replace(/^in\s+/i, "")
    // Don't treat known patterns as cities/timezones
    if (
      /^(?:at|in)$/i.test(potentialCity) ||
      /^[ap]m?$/i.test(potentialCity) ||
      expandModifier(potentialCity).length > 0 ||
      expandDayName(potentialCity).length > 0 ||
      expandRelativeDay(potentialCity).length > 0 ||
      expandMonth(potentialCity).length > 0 ||
      expandPeriod(potentialCity).length > 0 ||
      isExplicitTime(potentialCity) ||
      /^\d{1,2}$/.test(potentialCity)
    ) {
      continue
    }

    // Check timezone abbreviations first (shorter, more specific)
    const tzMatches = matchTimezoneAbbreviation(potentialCity)
    if (tzMatches.length > 0) {
      result.city = tzMatches
      remaining = words.slice(0, -cityWordCount).join(" ")
      break
    }

    // Fall back to city matching
    const cityMatches = matchCities(potentialCity)
    if (cityMatches.length > 0) {
      result.city = cityMatches
      remaining = words.slice(0, -cityWordCount).join(" ")
      break
    }
  }

  // Re-split after removing city
  const tokens = remaining.split(/\s+/).filter(Boolean)
  if (hasNumberBeforeNonTimeWord(tokens)) return { ...result, city: null }

  // 2. Extract modifier (next, this, on)
  const firstTokenForModifier = tokens[0]
  if (firstTokenForModifier !== undefined) {
    const modMatches = expandModifier(firstTokenForModifier)
    if (isUnambiguousModifier(modMatches, firstTokenForModifier)) {
      result.modifier = modMatches[0] ?? null
      tokens.shift()
    }
  }

  // 3. Look for explicit time (has am/pm or colon), including "10 pm" split across tokens.
  const spacedMeridiemTimeIdx = tokens.findIndex(
    (t, i) =>
      i < tokens.length - 1 && /^\d{1,2}(?:[:.]\d{0,2})?$/.test(t) && /^[ap]m?$/i.test(tokens[i + 1] ?? "")
  )
  if (spacedMeridiemTimeIdx !== -1) {
    result.time = expandTime(
      `${tokens[spacedMeridiemTimeIdx] ?? ""}${tokens[spacedMeridiemTimeIdx + 1] ?? ""}`
    )
    result.hasExplicitTime = true
    tokens.splice(spacedMeridiemTimeIdx, 2)
  } else {
    const timeIdx = tokens.findIndex((t) => isExplicitTime(t))
    if (timeIdx !== -1) {
      result.time = expandTime(tokens[timeIdx] ?? "")
      result.hasExplicitTime = true
      tokens.splice(timeIdx, 1)
    }
  }

  const firstTokenForLateModifier = tokens[0]
  if (!result.modifier && firstTokenForLateModifier !== undefined) {
    const modMatches = expandModifier(firstTokenForLateModifier)
    if (isUnambiguousModifier(modMatches, firstTokenForLateModifier)) {
      result.modifier = modMatches[0] ?? null
      tokens.shift()
    }
  }

  // 3.5. If we have a modifier like "next", prioritize day names over months for ambiguous inputs
  // e.g., "next f" should be "next friday" not "next february"
  const firstTokenForDayOrPeriod = tokens[0]
  if (result.modifier && firstTokenForDayOrPeriod !== undefined) {
    const dayMatches = expandDayName(firstTokenForDayOrPeriod)
    const periodMatches = expandPeriod(firstTokenForDayOrPeriod)

    // If it matches a day name or period, prioritize those over month
    if (dayMatches.length > 0) {
      result.dayName = dayMatches
      result.dateType = "day_name"
      tokens.shift()
    } else if (periodMatches.length > 0) {
      result.relativePeriod = periodMatches
      result.dateType = "period"
      tokens.shift()
    }
  }

  // 4. Look for month
  let monthIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    const monthMatches = expandMonth(token)
    if (monthMatches.length > 0 && !/^\d+$/.test(token)) {
      result.month = monthMatches
      monthIdx = i
      break
    }
  }
  if (monthIdx !== -1) {
    tokens.splice(monthIdx, 1)
  }

  // 5. Look for relative days (today, tomorrow)
  const relIdx = tokens.findIndex((t) => expandRelativeDay(t).length > 0)
  if (relIdx !== -1) {
    result.dayName = expandRelativeDay(tokens[relIdx] ?? "")
    result.dateType = "relative"
    tokens.splice(relIdx, 1)
  }

  // 6. Look for day names (friday, monday)
  if (!result.dateType) {
    const dayIdx = tokens.findIndex((t) => expandDayName(t).length > 0)
    if (dayIdx !== -1) {
      result.dayName = expandDayName(tokens[dayIdx] ?? "")
      result.dateType = "day_name"
      tokens.splice(dayIdx, 1)
    }
  }

  // 7. Look for periods (week, month) - typically with modifier
  if (!result.dateType && result.modifier) {
    const periodIdx = tokens.findIndex((t) => expandPeriod(t).length > 0)
    if (periodIdx !== -1) {
      result.relativePeriod = expandPeriod(tokens[periodIdx] ?? "")
      result.dateType = "period"
      tokens.splice(periodIdx, 1)
    }
  }

  // 8. Handle remaining numbers - context matters
  const numberTokens = tokens.flatMap((t) => {
    if (/^\d{1,2}$/.test(t)) return [t]
    const ordinalMatch = t.match(/^(\d{1,2})(?:st|nd|rd|th)$/)
    return ordinalMatch ? [ordinalMatch[1] ?? ""] : []
  })

  if (result.month && numberTokens.length > 0) {
    // If we have a month, numbers are day numbers
    result.dayNumber = []
    for (const num of numberTokens) {
      result.dayNumber.push(...expandDayNumber(num))
    }
    result.dateType = "month_day"
  } else if (!result.hasExplicitTime && numberTokens[0] !== undefined) {
    // No explicit time and we have numbers
    const firstNum = numberTokens[0]
    const num = parseInt(firstNum, 10)

    if (result.dayName || result.modifier || result.dateType) {
      // We have date context, this is likely a time
      result.time = expandTime(firstNum)
    } else if (num >= 1 && num <= 12) {
      // Ambiguous - suggest as time
      result.time = expandTime(firstNum)
    } else if (num >= 13 && num <= 23) {
      // Likely 24-hour time
      result.time = expandTime(firstNum)
    }
  }

  return result
}

// ============================================================================
// CANDIDATE GENERATION
// ============================================================================

interface Candidate {
  chronoInput: string
  displayLabel: string
  value: string
  timezone: string | null
  specificity: number
  directDate?: Date // Pre-calculated date for duration patterns (avoids chrono DST issues)
}

function capitalizeWords(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatTimeDisplay(time: string): string {
  return time.replace(/([ap]m)/i, (m) => ` ${m.toUpperCase()}`)
}

function addOrdinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0] || "th")
}

function generateCandidates(parsed: ParsedComponents, now: Date): Candidate[] {
  const candidates: Candidate[] = []

  const modifiers = parsed.modifier ? [parsed.modifier] : [null]
  const dayNames = parsed.dayName || [null]
  const periods = parsed.relativePeriod || [null]
  const months = parsed.month || [null]
  const dayNumbers = parsed.dayNumber || [null]
  const times = parsed.time || [null]
  const cities = parsed.city || [null]
  const inDurations = parsed.inDuration || [null]

  // Generate based on components
  const dateParts = modifiers.flatMap((modifier) =>
    dayNames.flatMap((dayName) =>
      periods.flatMap((period) =>
        months.flatMap((month) => dayNumbers.map((dayNum) => ({ modifier, dayName, period, month, dayNum })))
      )
    )
  )
  const timeParts = times.flatMap((time) =>
    cities.flatMap((cityData) => inDurations.map((inDuration) => ({ time, cityData, inDuration })))
  )
  for (const { modifier, dayName, period, month, dayNum } of dateParts) {
    for (const { time, cityData, inDuration } of timeParts) {
      const candidateNow = cityData ? toZonedTime(now, cityData.timezone) : now
      const candidate = buildCandidate(
        modifier,
        dayName,
        period,
        month,
        dayNum,
        time,
        cityData,
        inDuration,
        candidateNow
      )
      if (candidate) {
        candidates.push(candidate)
      }
    }
  }

  // Special case: time only → add today/tomorrow
  if (parsed.time && !parsed.dayName && !parsed.month && !parsed.modifier && !parsed.relativePeriod) {
    for (const time of parsed.time) {
      for (const cityData of cities) {
        const cityLabel = cityData ? ` in ${cityData.city}` : ""
        const tz = cityData?.timezone || null

        candidates.push({
          chronoInput: `today at ${time}`,
          displayLabel: `Today at ${formatTimeDisplay(time)}${cityLabel}`,
          value: `today at ${formatTimeDisplay(time).toLowerCase()}${cityLabel}`,
          timezone: tz,
          specificity: 5,
        })
        candidates.push({
          chronoInput: `tomorrow at ${time}`,
          displayLabel: `Tomorrow at ${formatTimeDisplay(time)}${cityLabel}`,
          value: `tomorrow at ${formatTimeDisplay(time).toLowerCase()}${cityLabel}`,
          timezone: tz,
          specificity: 4,
        })
      }
    }
  }

  return candidates
}

function buildCandidate(
  modifier: string | null,
  dayName: string | null,
  period: string | null,
  month: string | null,
  dayNum: string | null,
  time: string | null,
  cityData: { city: string; timezone: string } | null,
  inDuration: { count: number; unit: DurationUnit } | null = null,
  now: Date = new Date()
): Candidate | null {
  const chronoParts: string[] = []
  const displayParts: string[] = []
  const valueParts: string[] = []
  let specificity = 0

  // Handle "in X minutes/days/weeks/months/years"
  let directDate: Date | undefined
  if (inDuration) {
    const { count, unit } = inDuration
    const unitName = unit === "business_day" ? "business day" : unit
    const unitText = `${unitName}${count === 1 ? "" : "s"}`
    chronoParts.push(`in ${count} ${unitName}s`)
    displayParts.push(`In ${count} ${capitalizeWords(unitText)}`)
    valueParts.push(`in ${count} ${unitText}`)
    specificity += 4

    // Calculate date directly to avoid chrono DST issues
    directDate = new Date(now)
    switch (unit) {
      case "second":
        directDate.setSeconds(directDate.getSeconds() + count)
        break
      case "minute":
        directDate.setMinutes(directDate.getMinutes() + count)
        // For minutes, keep current time + offset (don't reset to 8am)
        break
      case "hour":
        directDate.setHours(directDate.getHours() + count)
        // For hours, keep current time + offset (don't reset to 8am)
        break
      case "day":
        directDate.setDate(directDate.getDate() + count)
        directDate.setHours(8, 0, 0, 0)
        break
      case "business_day":
        directDate.setDate(directDate.getDate() + businessDayOffset({ weekday: directDate.getDay(), count }))
        directDate.setHours(8, 0, 0, 0)
        break
      case "week":
        directDate.setDate(directDate.getDate() + count * 7)
        directDate.setHours(8, 0, 0, 0)
        break
      case "month":
        directDate.setMonth(directDate.getMonth() + count)
        directDate.setHours(8, 0, 0, 0)
        break
      case "year":
        directDate.setFullYear(directDate.getFullYear() + count)
        directDate.setHours(8, 0, 0, 0)
        break
    }
  }
  // Handle period (next week, next month, this weekend)
  else if (period) {
    if (period === "week") {
      chronoParts.push("next monday")
      displayParts.push(modifier ? capitalizeWords(`${modifier} Week`) : "Next Week")
      valueParts.push(modifier ? `${modifier} week` : "next week")
    } else if (period === "month") {
      // Calculate actual first day of next month for chrono
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const monthName = MONTH_NAMES[nextMonth.getMonth()]
      chronoParts.push(`${monthName} 1`)
      displayParts.push(modifier ? capitalizeWords(`${modifier} Month`) : "Next Month")
      valueParts.push(modifier ? `${modifier} month` : "next month")
    } else if (period === "year") {
      const nextYear = now.getFullYear() + 1
      chronoParts.push(`january 1 ${nextYear}`)
      displayParts.push(modifier ? capitalizeWords(`${modifier} Year`) : "Next Year")
      valueParts.push(modifier ? `${modifier} year` : "next year")
    } else if (period === "weekend") {
      // "this weekend" or just "weekend" resolves to Saturday
      chronoParts.push("saturday")
      displayParts.push(modifier ? capitalizeWords(`${modifier} Weekend`) : "This Weekend")
      valueParts.push(modifier ? `${modifier} weekend` : "this weekend")
    }
    specificity += 3
  }
  // Handle day name with modifier
  else if (dayName && modifier) {
    chronoParts.push(`${modifier} ${dayName}`)
    displayParts.push(capitalizeWords(`${modifier} ${dayName}`))
    valueParts.push(`${modifier} ${dayName}`)
    specificity += 3
  }
  // Handle day name alone
  else if (dayName) {
    chronoParts.push(dayName)
    displayParts.push(capitalizeWords(dayName))
    valueParts.push(dayName)
    specificity += 2
  }
  // Handle month + day
  else if (month && dayNum) {
    chronoParts.push(`${month} ${dayNum}`)
    displayParts.push(`${capitalizeWords(month)} ${addOrdinal(parseInt(dayNum, 10))}`)
    valueParts.push(`${month} ${dayNum}`)
    specificity += 4
  }
  // Handle month alone
  else if (month) {
    chronoParts.push(`${month} 1`)
    displayParts.push(`${capitalizeWords(month)} 1st`)
    valueParts.push(`${month} 1`)
    specificity += 2
  }

  // Add time - default to 8am if no time specified
  if (time) {
    if (chronoParts.length > 0) {
      chronoParts.push(`at ${time}`)
      displayParts.push(`at ${formatTimeDisplay(time)}`)
      valueParts.push(`at ${formatTimeDisplay(time).toLowerCase()}`)
    } else {
      // Time only handled in special case
      return null
    }
    specificity += 2
  } else if (chronoParts.length > 0) {
    // Default to 8am when no time specified
    chronoParts.push("at 8:00am")
    specificity += 1
  }

  // Add city
  if (cityData) {
    displayParts.push(`in ${cityData.city}`)
    valueParts.push(`in ${cityData.city}`)
    specificity += 1
  }

  if (chronoParts.length === 0) {
    return null
  }

  return {
    chronoInput: chronoParts.join(" "),
    displayLabel: displayParts.join(" "),
    value: valueParts.join(" "),
    timezone: cityData?.timezone || null,
    specificity,
    directDate,
  }
}

type NlQueryToDateSuggestionsOptions = {
  returnDefaultsOnEmpty?: boolean
  now?: Date
}

/**
 * Provides fuzzy date suggestions based on user input.
 * Parses partial date/time expressions and returns future date options,
 * including support for timezones/cities when specified.
 * Suggestions are enriched with labels and handle incomplete or ambiguous queries.
 */
export function nlQueryToDateSuggestions(
  query: string,
  options?: NlQueryToDateSuggestionsOptions
): DateMatch[] {
  const { returnDefaultsOnEmpty = true } = options ?? {}
  const now = options?.now ?? new Date()

  if (!query || !query.trim()) {
    if (returnDefaultsOnEmpty) {
      return [
        {
          label: "Tomorrow",
          value: "tomorrow",
          date: chrono.parseDate("tomorrow at 8:00am", now, { forwardDate: true })!,
          timezone: null,
        },
        {
          label: "In 3 Days",
          value: "in 3 days",
          date: chrono.parseDate("in 3 days at 8:00am", now, { forwardDate: true })!,
          timezone: null,
        },
        {
          label: "Next Week",
          value: "next week",
          date: chrono.parseDate("next monday at 8:00am", now, { forwardDate: true })!,
          timezone: null,
        },
        {
          label: "In 2 Weeks",
          value: "in 2 weeks",
          date: chrono.parseDate("in 2 weeks at 8:00am", now, { forwardDate: true })!,
          timezone: null,
        },
        {
          label: "Next Month",
          value: "next month",
          date: new Date(now.getFullYear(), now.getMonth() + 1, 1, 8, 0, 0, 0),
          timezone: null,
        },
      ]
    }
    return []
  }

  const parsed = parseQuery(query)
  const candidates = generateCandidates(parsed, now)

  const results: Array<DateMatch & { specificity: number }> = []

  for (const candidate of candidates) {
    try {
      // Use pre-calculated date for duration patterns, otherwise parse with chrono
      let finalDate: Date | null = candidate.directDate ?? null
      if (!finalDate) {
        const parseOptions: Parameters<typeof chrono.parseDate>[2] = {
          forwardDate: true,
        }
        if (candidate.timezone) {
          const zonedResult = chrono.parseDate(
            candidate.chronoInput,
            toZonedTime(now, candidate.timezone),
            parseOptions
          )
          finalDate = zonedResult ? fromZonedTime(zonedResult, candidate.timezone) : null
        } else {
          finalDate = chrono.parseDate(candidate.chronoInput, now, parseOptions)
        }
      }

      if (finalDate && finalDate > now) {
        const existingIndex = results.findIndex(
          (r) => Math.abs(r.date.getTime() - finalDate.getTime()) < 60000 && r.timezone === candidate.timezone
        )

        const existing = results[existingIndex]
        if (!existing) {
          results.push({
            label: candidate.displayLabel,
            value: candidate.value,
            date: finalDate,
            timezone: candidate.timezone,
            specificity: candidate.specificity,
          })
        } else if (candidate.specificity > existing.specificity) {
          results[existingIndex] = {
            label: candidate.displayLabel,
            value: candidate.value,
            date: finalDate,
            timezone: candidate.timezone,
            specificity: candidate.specificity,
          }
        }
      }
    } catch {
      continue
    }
  }

  // Sort by specificity (desc) then by date (asc)
  results.sort((a, b) => {
    if (b.specificity !== a.specificity) {
      return b.specificity - a.specificity
    }
    return a.date.getTime() - b.date.getTime()
  })

  return results.slice(0, 5).map(({ label, value, date, timezone }) => ({
    label,
    value,
    date,
    timezone,
  }))
}

/**
 * Detects if the user's system prefers 24-hour clock format
 */
function getUserPrefers24HourClock(): boolean {
  const testDate = new Date(2023, 0, 1, 13, 0, 0)
  const timeString = testDate.toLocaleTimeString(navigator.language, {
    hour: "numeric",
  })
  return !timeString.includes("PM") && !timeString.includes("AM")
}

/**
 * Formats a reminder date/time in a smart, user-friendly way:
 * - Within 6 days: "Wed, 8:00 AM"
 * - Beyond 6 days: "Thu, Dec 18, 8:00 AM"
 * - Different year: "Thu, Dec 18, 2025, 8:00 AM"
 * - Non-local timezone: adds "(CET)" suffix
 */
export function formatReminderDate(date: Date, timezone: string | null): string {
  const timeFormat = getUserPrefers24HourClock() ? "HH:mm" : "h:mm a"

  const now = new Date()
  const displayDate = timezone ? toZonedTime(date, timezone) : date
  const displayNow = timezone ? toZonedTime(now, timezone) : now
  const daysOut = differenceInDays(displayDate, displayNow)
  const sameYear = displayDate.getFullYear() === displayNow.getFullYear()

  let dateFormat: string
  if (daysOut <= 6) {
    // Near: "Wed, 8:00 AM"
    dateFormat = `EEE, ${timeFormat}`
  } else if (sameYear) {
    // Far but same year: "Thu, Dec 18, 8:00 AM"
    dateFormat = `EEE, MMM d, ${timeFormat}`
  } else {
    // Different year: "Thu, Dec 18, 2025, 8:00 AM"
    dateFormat = `EEE, MMM d, yyyy, ${timeFormat}`
  }

  let result = timezone ? formatInTimeZone(date, timezone, dateFormat) : format(date, dateFormat)

  // Only show timezone if explicitly set and different from user's local
  if (timezone) {
    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const isLocalTime =
      formatInTimeZone(date, timezone, "xxx") === formatInTimeZone(date, localTimezone, "xxx")
    // Get abbreviation for the specified timezone
    const tzAbbr = new Intl.DateTimeFormat(navigator.language, {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value

    if (tzAbbr && !isLocalTime) {
      result += ` (${tzAbbr})`
    }
  }

  return result
}

export type { DateMatch }

function isDaypartContext(prev: string | undefined, tokenCount: number) {
  return prev === "this" || (prev !== undefined && isDayAnchor(prev)) || tokenCount === 1
}

function hasDaypartAnchor(prev: string | undefined, tok: string) {
  return prev !== undefined || DAYPART_TIMES[tok] !== undefined
}

function isWeekModifier(token: string | undefined) {
  return token === "this" || token === "next"
}

function isUnambiguousModifier(matches: readonly string[], token: string) {
  return matches.length === 1 || (token.length >= 3 && matches.includes(token))
}

function isDayAnchor(token: string): boolean {
  return token === "today" || token === "tomorrow" || uniqueWeekday(token) !== null
}
