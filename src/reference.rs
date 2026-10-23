//! Reference sites: links in a message are opened in a headless browser by
//! `capture/capture.mjs`, and what it sees — screenshots and the page's real
//! fonts, colours and structure — goes to the designer with the request.

use std::{path::Path, process::Stdio, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tokio::process::Command;

/// At most this many links per request are opened.
const MAX_REFERENCES: usize = 2;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(75);

/// Endings a bare domain ("getartcraft.com") may have to count as a link, so
/// words like "Node.js" in a message aren't taken for one.
const BARE_TLDS: &[&str] = &[
    "com", "net", "org", "io", "co", "app", "dev", "design", "studio", "xyz", "ai", "me", "ng",
    "uk", "us", "ca", "de", "fr", "nl", "so", "site", "store", "shop", "agency", "art",
];

/// The links in a message, in order, normalised to `https://` when bare.
pub fn find_links(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    for raw in text.split_whitespace() {
        let word = raw
            .trim_start_matches(['(', '[', '<', '"', '\''])
            .trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '>', '"', '\'']);
        let link = if word.starts_with("http://") || word.starts_with("https://") {
            Some(word.to_string())
        } else if looks_like_domain(word) {
            Some(format!("https://{word}"))
        } else {
            None
        };
        if let Some(link) = link
            && !links.contains(&link)
        {
            links.push(link);
        }
        if links.len() == MAX_REFERENCES {
            break;
        }
    }
    links
}

fn looks_like_domain(word: &str) -> bool {
    if word.contains('@') {
        return false;
    }
    let host = word.split('/').next().unwrap_or("");
    let host = host.strip_prefix("www.").unwrap_or(host);
    let mut labels = host.split('.');
    let Some(first) = labels.next() else {
        return false;
    };
    let rest: Vec<&str> = labels.collect();
    let Some(tld) = rest.last() else {
        return false;
    };
    !first.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && BARE_TLDS.contains(&tld.to_ascii_lowercase().as_str())
}

pub struct Capture {
    pub url: String,
    /// Content blocks for the designer: the facts as text, then the screenshots.
    pub blocks: Vec<Value>,
    /// Why it failed, when it did; the designer is told so it can say so.
    pub error: Option<String>,
}

/// Opens one link and turns what the browser saw into content blocks.
pub async fn capture(script: &str, url: &str, dir: &Path) -> Capture {
    let failed = |error: String| Capture {
        url: url.to_string(),
        blocks: vec![json!({
            "type": "text",
            "text": format!("Reference site {url} could not be opened: {error}. Tell the person, and do your best from what they said."),
        })],
        error: Some(error),
    };

    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        return failed(e.to_string());
    }
    let run = Command::new("node")
        .arg(script)
        .arg(url)
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(CAPTURE_TIMEOUT, run).await {
        Err(_) => return failed("the site took too long to load".into()),
        Ok(Err(e)) => return failed(format!("the browser could not start ({e})")),
        Ok(Ok(output)) => output,
    };
    let Ok(result) = serde_json::from_slice::<Value>(&output.stdout) else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!("capture of {url} failed: {stderr}");
        return failed("the browser stopped unexpectedly".into());
    };
    if result["ok"] != true {
        return failed(
            result["error"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string(),
        );
    }

    let final_url = result["url"].as_str().unwrap_or(url);
    let style = serde_json::to_string_pretty(&result["style"]).unwrap_or_default();
    let mut blocks = vec![json!({
        "type": "text",
        "text": format!(
            "REFERENCE SITE: {final_url}\n\nThese are the styles the page really uses, read from the browser (computed CSS; colours by area or amount of text, most used first):\n\n{style}\n\nScreenshots follow."
        ),
    })];
    for shot in result["screenshots"].as_array().into_iter().flatten() {
        let (Some(path), Some(label)) = (shot["path"].as_str(), shot["label"].as_str()) else {
            continue;
        };
        let Ok(bytes) = tokio::fs::read(path).await else {
            continue;
        };
        blocks.push(json!({ "type": "text", "text": format!("Screenshot — {label}:") }));
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/jpeg", "data": STANDARD.encode(bytes) },
        }));
    }
    Capture {
        url: final_url.to_string(),
        blocks,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::find_links;

    #[test]
    fn finds_full_and_bare_links() {
        assert_eq!(
            find_links("can you use this style from this site? https://getartcraft.com/"),
            vec!["https://getartcraft.com/"]
        );
        assert_eq!(
            find_links("make it like getartcraft.com, please"),
            vec!["https://getartcraft.com"]
        );
        assert_eq!(
            find_links("like (www.stripe.com/pricing)."),
            vec!["https://www.stripe.com/pricing"]
        );
    }

    #[test]
    fn ignores_words_that_are_not_links() {
        assert!(find_links("built with Node.js and e.g. React; mail me at a@b.com").is_empty());
        assert!(find_links("a bakery website").is_empty());
    }

    #[test]
    fn keeps_at_most_two() {
        assert_eq!(find_links("a.com b.com c.com a.com").len(), 2);
    }
}
