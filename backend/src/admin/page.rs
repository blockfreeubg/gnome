//! Server-rendered, self-contained admin diagnostics page (no scripts; inline styles only).

use std::fmt::Write as _;

use serde_json::Value;

use crate::module::Diagnostics;
use crate::util::html_escape;

fn fmt_bytes(n: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{v:.0} {}", UNITS[unit]) } else { format!("{v:.1} {}", UNITS[unit]) }
}

fn fmt_duration(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60, secs % 60);
    if d > 0 {
        format!("{d}d {h}h {m}m")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m {s}s")
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::Null => "—".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "yes".into()
            } else {
                "no".into()
            }
        }
        other => other.to_string(),
    }
}

fn get<'a>(d: &'a Diagnostics, path: &[&str]) -> &'a Value {
    static NULL: Value = Value::Null;
    let mut cur = match d.get(path[0]) {
        Some(v) => v,
        None => return &NULL,
    };
    for key in &path[1..] {
        cur = cur.get(key).unwrap_or(&NULL);
    }
    cur
}

fn stat(out: &mut String, label: &str, value: &str) {
    let _ = write!(
        out,
        "<div class=\"stat\"><div class=\"label\">{}</div><div class=\"value\">{}</div></div>",
        html_escape(label),
        html_escape(value)
    );
}

/// Key/value table for an object (nested values shown as compact JSON).
fn object_table(out: &mut String, title: &str, v: &Value) {
    let _ = write!(out, "<section><h2>{}</h2>", html_escape(title));
    match v {
        Value::Object(map) if !map.is_empty() => {
            out.push_str("<table class=\"kv\">");
            for (k, val) in map {
                let shown = match val {
                    Value::Object(_) | Value::Array(_) => val.to_string(),
                    other => scalar(other),
                };
                let _ = write!(out, "<tr><th>{}</th><td>{}</td></tr>", html_escape(k), html_escape(&shown));
            }
            out.push_str("</table>");
        }
        Value::Array(items) if !items.is_empty() => {
            out.push_str("<table class=\"kv\">");
            for item in items {
                let _ = write!(out, "<tr><td>{}</td></tr>", html_escape(&item.to_string()));
            }
            out.push_str("</table>");
        }
        _ => out.push_str("<p class=\"muted\">Nothing to show.</p>"),
    }
    out.push_str("</section>");
}

/// `filters` rows (one per list) as a table: state, sizes, version, last/next check, errors.
fn filters_table(out: &mut String, v: &Value) {
    out.push_str("<section><h2>Filter lists</h2>");
    let Value::Array(rows) = v else {
        out.push_str("<p class=\"muted\">Nothing to show.</p></section>");
        return;
    };
    if rows.is_empty() {
        out.push_str("<p class=\"muted\">No filter lists are configured.</p></section>");
        return;
    }
    let now = crate::util::now_ms();
    let ago = |ms: Option<i64>| {
        ms.map_or("—".into(), |t| format!("{} ago", fmt_duration(((now - t).max(0) / 1000) as u64)))
    };
    let until =
        |ms: Option<i64>| ms.map_or("—".into(), |t| format!("in {}", fmt_duration(((t - now).max(0) / 1000) as u64)));
    out.push_str(
        "<div class=\"scroll\"><table class=\"jobs\"><thead><tr><th>List</th><th>Category</th><th>Stored</th>\
         <th>Size (br)</th><th>Version</th><th>Checked</th><th>Next check</th><th>Status</th></tr></thead><tbody>",
    );
    for r in rows {
        let field = |k: &str| r.get(k).unwrap_or(&Value::Null);
        let available = field("available").as_bool() == Some(true);
        let size = if available {
            format!(
                "{} ({})",
                fmt_bytes(field("size").as_f64().unwrap_or(0.0)),
                fmt_bytes(field("size_br").as_f64().unwrap_or(0.0))
            )
        } else {
            "—".into()
        };
        let failures = field("failures").as_u64().unwrap_or(0);
        let status = match field("last_error").as_str() {
            Some(e) => format!("{failures} failed: {e}"),
            None => "ok".into(),
        };
        let _ = write!(
            out,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            html_escape(&scalar(field("id"))),
            html_escape(&scalar(field("category"))),
            if available { "yes" } else { "not yet" },
            html_escape(&size),
            html_escape(&scalar(field("version"))),
            html_escape(&ago(field("fetched_at").as_i64())),
            html_escape(&until(field("next_check_at").as_i64())),
            html_escape(&status)
        );
    }
    out.push_str("</tbody></table></div></section>");
}

pub fn render(d: &Diagnostics, refresh: Option<u32>) -> String {
    let mut out = String::with_capacity(16 * 1024);
    out.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    if let Some(r) = refresh {
        let _ = write!(out, "<meta http-equiv=\"refresh\" content=\"{r}\">");
    }
    out.push_str("<title>GNOME · admin</title><style>");
    out.push_str(STYLE);
    out.push_str("</style></head><body><main>");

    let version = scalar(get(d, &["build", "version"]));
    let profile = scalar(get(d, &["build", "profile"]));
    let target = scalar(get(d, &["build", "target"]));
    let _ = write!(
        out,
        "<header><h1>GNOME <span>admin</span></h1><p class=\"muted\">gnome-server {} · {} · {}</p>\
         <nav><a href=\"/admin/diagnostics\">diagnostics.json</a><a href=\"/admin/metrics\">metrics</a>\
         <a href=\"/admin/?refresh=5\">auto-refresh</a><a href=\"/admin/\">refresh</a></nav></header>",
        html_escape(&version),
        html_escape(&profile),
        html_escape(&target)
    );

    out.push_str("<section class=\"stats\">");
    stat(&mut out, "Uptime", &fmt_duration(get(d, &["uptime_s"]).as_u64().unwrap_or(0)));
    stat(&mut out, "Memory (RSS)", &get(d, &["rss_bytes"]).as_f64().map_or("—".into(), fmt_bytes));
    stat(&mut out, "Requests", &scalar(get(d, &["http", "requests"])));
    stat(&mut out, "Rate limited", &scalar(get(d, &["http", "rate_limited"])));
    stat(&mut out, "Connections", &scalar(get(d, &["http", "connections_active"])));
    stat(&mut out, "WebSockets", &scalar(get(d, &["ws", "active"])));
    stat(&mut out, "Users", &scalar(get(d, &["db", "users"])));
    stat(&mut out, "Sessions", &scalar(get(d, &["db", "user_sessions"])));
    stat(&mut out, "Database", &get(d, &["db", "size_bytes"]).as_f64().map_or("—".into(), fmt_bytes));
    let isolated = get(d, &["proxy", "isolated"]).as_bool() == Some(true);
    stat(&mut out, "Proxy isolation", if isolated { "on" } else { "off" });
    out.push_str("</section>");
    if !isolated && let Some(why) = get(d, &["proxy", "explanation"]).as_str() {
        let _ = write!(out, "<p class=\"note\">Proxy isolation is off: {}.</p>", html_escape(why));
    }

    out.push_str("<section><h2>Background jobs</h2>");
    match get(d, &["jobs"]) {
        Value::Array(jobs) if !jobs.is_empty() => {
            out.push_str(
                "<div class=\"scroll\"><table class=\"jobs\"><thead><tr><th>Job</th><th>Every</th><th>Runs</th>\
                 <th>Failures</th><th>Last run</th><th>Status</th></tr></thead><tbody>",
            );
            for j in jobs {
                let every = j.get("every_s").and_then(Value::as_u64).map_or("—".into(), fmt_duration);
                let last =
                    j.get("last_duration_ms").and_then(Value::as_u64).map_or("—".into(), |ms| format!("{ms} ms"));
                let status = if j.get("running").and_then(Value::as_bool) == Some(true) {
                    "running".to_string()
                } else {
                    j.get("last_error").and_then(Value::as_str).map_or("ok".into(), |e| format!("error: {e}"))
                };
                let _ = write!(
                    out,
                    "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                    html_escape(&scalar(j.get("name").unwrap_or(&Value::Null))),
                    html_escape(&every),
                    html_escape(&scalar(j.get("runs").unwrap_or(&Value::Null))),
                    html_escape(&scalar(j.get("failures").unwrap_or(&Value::Null))),
                    html_escape(&last),
                    html_escape(&status)
                );
            }
            out.push_str("</tbody></table></div>");
        }
        _ => out.push_str("<p class=\"muted\">No jobs are running (jobs start with <code>serve</code>).</p>"),
    }
    out.push_str("</section>");

    object_table(&mut out, "HTTP status codes", get(d, &["http", "by_status"]));
    object_table(&mut out, "Rate limiting", get(d, &["rate_limiter"]));
    object_table(&mut out, "WebSocket gateway", get(d, &["ws"]));
    object_table(&mut out, "Upstreams", get(d, &["upstreams"]));
    object_table(&mut out, "Game catalog", get(d, &["catalog"]));
    // Embed hosts (pending ones with their game counts), thumbnail cache, OSS builds (WAVE-C §4.4).
    object_table(&mut out, "Games", get(d, &["games"]));
    object_table(&mut out, "VPN exit checks", get(d, &["vpn"]));
    filters_table(&mut out, get(d, &["filters"]));
    object_table(&mut out, "Database", get(d, &["db"]));
    object_table(&mut out, "Static files", get(d, &["static"]));
    object_table(&mut out, "Configuration", get(d, &["config"]));

    let raw = serde_json::to_string_pretty(&Value::Object(d.clone())).unwrap_or_default();
    let _ = write!(
        out,
        "<section><details><summary>Raw diagnostics</summary><pre>{}</pre></details></section>",
        html_escape(&raw)
    );
    out.push_str("</main></body></html>");
    out
}

const STYLE: &str = r#"
:root { color-scheme: dark; --bg:#0f0f0d; --s1:#1a1a16; --line:rgba(236,228,208,.08); --line2:rgba(236,228,208,.14);
        --text:#ece6d8; --text2:#b4ac9b; --text3:#7f786a; --accent:#d6b47a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
header { border-bottom: 1px solid var(--line2); padding-bottom: 16px; margin-bottom: 24px; }
h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: .04em; }
h1 span { color: var(--accent); font-weight: 500; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--text2); font-weight: 600; margin: 32px 0 8px; }
nav { display: flex; gap: 16px; margin-top: 8px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.muted { color: var(--text3); margin: 4px 0 0; }
.note { color: var(--text2); margin: 12px 0 0; padding: 10px 14px; border-left: 2px solid var(--accent); background: var(--s1); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.stat { padding: 14px 16px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.label { color: var(--text3); font-size: 12px; }
.value { font-size: 20px; font-variant-numeric: tabular-nums; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: baseline; }
th { color: var(--text2); font-weight: 500; white-space: nowrap; }
td { overflow-wrap: anywhere; }
table.kv th { width: 28%; }
thead th { color: var(--text3); font-size: 12px; }
.scroll { overflow-x: auto; }
table.jobs td { white-space: nowrap; }
table.jobs td:last-child { white-space: normal; min-width: 12em; }
table.jobs td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
code, pre { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--s1); border: 1px solid var(--line); padding: 16px; overflow: auto; max-height: 60vh; }
summary { cursor: pointer; color: var(--text2); }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_and_escapes() {
        let mut d = Diagnostics::new();
        d.insert("uptime_s".into(), 3725.into());
        d.insert(
            "build".into(),
            serde_json::json!({"version": "<script>x</script>", "profile": "debug", "target": "x"}),
        );
        d.insert("jobs".into(), serde_json::json!([{"name": "sessions.cleanup", "every_s": 3600, "runs": 1, "failures": 0, "running": false, "last_duration_ms": 3, "last_error": null}]));
        d.insert("proxy".into(), serde_json::json!({"isolated": false, "explanation": "single-origin <mode>"}));
        let html = render(&d, Some(5));
        assert!(html.contains("Proxy isolation is off: single-origin &lt;mode&gt;."));
        assert!(html.contains("&lt;script&gt;x&lt;/script&gt;"));
        assert!(!html.contains("<script>"));
        assert!(html.contains("1h 2m"));
        assert!(html.contains("sessions.cleanup"));
        assert!(html.contains("http-equiv=\"refresh\" content=\"5\""));
        assert_eq!(fmt_bytes(1536.0), "1.5 KiB");
    }
}
