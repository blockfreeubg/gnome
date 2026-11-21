//! Date parsing for feed timestamps, without a date-time dependency. All results are Unix epoch milliseconds (UTC).
//!
//! Supported: RFC 2822 / RFC 1123 (`Wed, 12 Nov 2025 12:34:52 GMT`, numeric offsets, missing weekday or seconds)
//! and ISO 8601 (`2026-10-28`, `2026-10-28T12:00:00Z`, `+02:00` offsets, fractional seconds). Years outside
//! 1990..=2100 are rejected as implausible for this catalog.

/// Milliseconds per day.
pub const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `(year, month, day)` for a day number since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC calendar year of a timestamp.
pub fn year_of(ms: i64) -> i64 {
    civil_from_days(ms.div_euclid(DAY_MS)).0
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

fn to_ms(y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32, offset_min: i64) -> Option<i64> {
    if !(1990..=2100).contains(&y) || !(1..=12).contains(&mo) || d == 0 || d > days_in_month(y, mo) {
        return None;
    }
    if h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s.min(59));
    Some((secs - offset_min * 60) * 1000)
}

fn month_from_name(s: &str) -> Option<u32> {
    const NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let lower = s.get(..3)?.to_ascii_lowercase();
    NAMES.iter().position(|n| *n == lower).map(|i| i as u32 + 1)
}

fn parse_hms(s: &str) -> Option<(u32, u32, u32)> {
    let mut it = s.split(':');
    let h = it.next()?.parse().ok()?;
    let m = it.next()?.parse().ok()?;
    let sec = match it.next() {
        Some(x) => x.split('.').next()?.parse().ok()?,
        None => 0,
    };
    if it.next().is_some() {
        return None;
    }
    Some((h, m, sec))
}

/// Parse an RFC 2822 / RFC 1123 date-time.
pub fn parse_rfc2822(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = match s.split_once(',') {
        Some((_weekday, rest)) => rest.trim(),
        None => s,
    };
    let mut parts = s.split_whitespace();
    let day: u32 = parts.next()?.parse().ok()?;
    let month = month_from_name(parts.next()?)?;
    let year: i64 = {
        let y = parts.next()?;
        let v: i64 = y.parse().ok()?;
        if y.len() == 2 { if v < 50 { 2000 + v } else { 1900 + v } } else { v }
    };
    let (h, mi, sec) = parse_hms(parts.next()?)?;
    let offset = match parts.next() {
        None => 0,
        Some(z) => zone_offset_minutes(z)?,
    };
    to_ms(year, month, day, h, mi, sec, offset)
}

fn zone_offset_minutes(z: &str) -> Option<i64> {
    let upper = z.to_ascii_uppercase();
    Some(match upper.as_str() {
        "GMT" | "UT" | "UTC" | "Z" => 0,
        "EST" => -5 * 60,
        "EDT" => -4 * 60,
        "CST" => -6 * 60,
        "CDT" => -5 * 60,
        "MST" => -7 * 60,
        "MDT" => -6 * 60,
        "PST" => -8 * 60,
        "PDT" => -7 * 60,
        _ => {
            let (sign, digits) = match upper.as_bytes().first()? {
                b'+' => (1, &upper[1..]),
                b'-' => (-1, &upper[1..]),
                _ => return None,
            };
            let digits = digits.replace(':', "");
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let hh: i64 = digits[..2].parse().ok()?;
            let mm: i64 = digits[2..].parse().ok()?;
            if hh > 14 || mm > 59 {
                return None;
            }
            sign * (hh * 60 + mm)
        }
    })
}

/// Parse an ISO 8601 date (`YYYY-MM-DD`, midnight UTC) or date-time.
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = match s.find(['T', 't', ' ']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mut dp = date.split('-');
    let y: i64 = dp.next().filter(|p| p.len() == 4)?.parse().ok()?;
    let mo: u32 = dp.next().filter(|p| p.len() == 2)?.parse().ok()?;
    let d: u32 = dp.next().filter(|p| p.len() == 2)?.parse().ok()?;
    if dp.next().is_some() {
        return None;
    }
    let Some(time) = time else {
        return to_ms(y, mo, d, 0, 0, 0, 0);
    };
    let (clock, offset) = if let Some(c) = time.strip_suffix(['Z', 'z']) {
        (c, 0)
    } else if let Some(i) = time.rfind(['+', '-']) {
        (&time[..i], zone_offset_minutes(&time[i..])?)
    } else {
        (time, 0)
    };
    let (h, mi, sec) = parse_hms(clock)?;
    to_ms(y, mo, d, h, mi, sec, offset)
}

/// Parse either format (RFC 2822 first, as used by RSS and the GamePix feed).
pub fn parse_any(s: &str) -> Option<i64> {
    parse_rfc2822(s).or_else(|| parse_iso8601(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc2822_variants() {
        // 2025-11-12T12:34:52Z
        assert_eq!(parse_rfc2822("Wed, 12 Nov 2025 12:34:52 GMT"), Some(1_762_950_892_000));
        assert_eq!(parse_rfc2822("12 Nov 2025 12:34:52 +0000"), Some(1_762_950_892_000));
        assert_eq!(parse_rfc2822("Wed, 12 Nov 2025 13:34:52 +0100"), Some(1_762_950_892_000));
        assert_eq!(parse_rfc2822("Wed, 12 Nov 2025 07:34:52 EST"), Some(1_762_950_892_000));
        assert_eq!(parse_rfc2822("Wed, 12 Nov 2025 12:34 GMT"), Some(1_762_950_840_000));
        assert_eq!(parse_rfc2822("Sat, 29 Feb 2025 00:00:00 GMT"), None);
        assert_eq!(parse_rfc2822("Thu, 01 Jan 1970 00:00:00 GMT"), None, "implausible year");
        assert_eq!(parse_rfc2822("not a date"), None);
        assert_eq!(parse_rfc2822("Wed, 12 Foo 2025 12:34:52 GMT"), None);
    }

    #[test]
    fn iso8601_variants() {
        assert_eq!(parse_iso8601("2026-10-28"), Some(days_from_civil(2026, 10, 28) * DAY_MS));
        assert_eq!(parse_iso8601("2025-11-12T12:34:52Z"), Some(1_762_950_892_000));
        assert_eq!(parse_iso8601("2025-11-12T14:34:52.123+02:00"), Some(1_762_950_892_000));
        assert_eq!(parse_iso8601("2025-13-01"), None);
        assert_eq!(parse_iso8601("2025-1-01"), None);
    }

    #[test]
    fn civil_round_trip() {
        for days in [-1, 0, 1, 365, 10_957, 20_000, 30_000, 47_482] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(year_of(1_762_950_892_000), 2025);
    }
}
