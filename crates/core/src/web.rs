//! OpenBlocks' own web tools for the AI: search (DuckDuckGo's HTML page, no key) and fetch (a
//! page as readable text). Only used when the user turns on the Web pill.

use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(25))
        .build()
        .unwrap_or_default()
}

pub async fn search(q: &str, n: usize) -> Result<Vec<Value>> {
    let html = client()
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", q)])
        .send()
        .await?
        .text()
        .await?;
    let mut out = vec![];
    for chunk in html.split("class=\"result__a\"").skip(1) {
        let href = between(chunk, "href=\"", "\"").unwrap_or_default();
        let title = between(chunk, ">", "</a>")
            .map(strip_tags)
            .unwrap_or_default();
        let snippet = chunk
            .split("class=\"result__snippet\"")
            .nth(1)
            .and_then(|s| between(s, ">", "</a>"))
            .map(strip_tags)
            .unwrap_or_default();
        let url = decode_ddg(href);
        if url.starts_with("http") && !url.contains("duckduckgo.com/y.js") {
            out.push(json!({"title": title.trim(), "url": url, "snippet": snippet.trim()}));
        }
        if out.len() >= n {
            break;
        }
    }
    Ok(out)
}

pub async fn fetch(url: &str, max: usize) -> Result<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        anyhow::bail!("solo enlaces http(s)");
    }
    let r = client().get(url).send().await?;
    let ct = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = r.text().await?;
    let text = if ct.contains("html") || body.trim_start().starts_with('<') {
        html_to_text(&body)
    } else {
        body
    };
    Ok(crate::util::clip(text.trim(), max))
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)?;
    Some(&s[i..i + j])
}

fn decode_ddg(href: &str) -> String {
    let h = href.replace("&amp;", "&");
    if let Some(u) = h.split("uddg=").nth(1) {
        let u = u.split('&').next().unwrap_or(u);
        return percent_encoding::percent_decode_str(u)
            .decode_utf8_lossy()
            .into_owned();
    }
    if h.starts_with("//") {
        return format!("https:{h}");
    }
    h
}

pub fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

pub fn strip_tags(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => o.push(c),
            _ => {}
        }
    }
    decode_entities(&o)
}

/// Readable text of an HTML page: drops scripts, styles and navigation, keeps line structure.
pub fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    for tag in [
        "script", "style", "noscript", "svg", "nav", "footer", "header", "form",
    ] {
        loop {
            let lower = s.to_ascii_lowercase();
            let Some(a) = lower.find(&format!("<{tag}")) else {
                break;
            };
            let end_tag = format!("</{tag}>");
            let b = lower[a..]
                .find(&end_tag)
                .map(|i| a + i + end_tag.len())
                .unwrap_or(s.len());
            s.replace_range(a..b, " ");
        }
    }
    for t in [
        "</p>", "<br", "</h1>", "</h2>", "</h3>", "</li>", "</tr>", "</div>",
    ] {
        s = s
            .replace(t, &format!("\n{t}"))
            .replace(&t.to_uppercase(), &format!("\n{t}"));
    }
    let text = strip_tags(&s);
    let mut out = String::new();
    let mut blank = 0;
    for l in text.lines() {
        let l = l.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank == 1 {
                out.push('\n');
            }
        } else {
            blank = 0;
            out.push_str(&l);
            out.push('\n');
        }
    }
    out
}
