//! Design Harness demo server.
//!
//! Serves the canvas UI and turns each design request into one run of the
//! `claude` command-line tool, streaming its text back to the browser as
//! server-sent events. The tool signs in with whatever Claude Code login the
//! machine has (`CLAUDE_CODE_OAUTH_TOKEN` in the container), so the demo is
//! private: every route but the login page needs the demo password.

use std::{collections::HashSet, convert::Infallible, process::Stdio, sync::Arc, time::Duration};

mod reference;

use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, Semaphore, mpsc},
};
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

const SESSION_COOKIE: &str = "dh_session";
const SYSTEM_PROMPT: &str = include_str!("prompt.md");
const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const APP_CSS: &str = include_str!("../web/app.css");

struct AppState {
    password: String,
    model: String,
    claude_bin: String,
    capture_script: String,
    work_dir: String,
    secure_cookie: bool,
    sessions: Mutex<HashSet<String>>,
    /// One design at a time: the subscription and the server both have limits.
    busy: Arc<Semaphore>,
    timeout: Duration,
}

type Shared = Arc<AppState>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "design_harness=info".into()),
        )
        .init();

    let password = std::env::var("DEMO_PASSWORD").unwrap_or_default();
    if password.is_empty() {
        eprintln!("DEMO_PASSWORD must be set");
        std::process::exit(1);
    }
    let work_dir = std::env::var("WORK_DIR").unwrap_or_else(|_| "/tmp/design-harness".into());
    tokio::fs::create_dir_all(&work_dir).await.ok();

    let state = Arc::new(AppState {
        password,
        model: std::env::var("CLAUDE_MODEL").unwrap_or_else(|_| "claude-sonnet-5-5".into()),
        claude_bin: std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".into()),
        capture_script: std::env::var("CAPTURE_SCRIPT")
            .unwrap_or_else(|_| "capture/capture.mjs".into()),
        work_dir,
        secure_cookie: std::env::var("SECURE_COOKIE")
            .map(|v| v == "true")
            .unwrap_or(false),
        sessions: Mutex::new(HashSet::new()),
        busy: Arc::new(Semaphore::new(1)),
        timeout: Duration::from_secs(
            std::env::var("DESIGN_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(600),
        ),
    });

    let app = Router::new()
        .route(
            "/",
            get(|| async { static_file("text/html; charset=utf-8", INDEX_HTML) }),
        )
        .route(
            "/app.js",
            get(|| async { static_file("text/javascript; charset=utf-8", APP_JS) }),
        )
        .route(
            "/app.css",
            get(|| async { static_file("text/css; charset=utf-8", APP_CSS) }),
        )
        .route("/health", get(|| async { "ok" }))
        .route("/api/me", get(me))
        .route("/api/login", post(login))
        .route("/api/design", post(design))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind");
    tracing::info!("listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("serve");
}

fn static_file(content_type: &'static str, body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

async fn signed_in(state: &AppState, jar: &CookieJar) -> bool {
    match jar.get(SESSION_COOKIE) {
        Some(c) => state.sessions.lock().await.contains(c.value()),
        None => false,
    }
}

async fn me(State(state): State<Shared>, jar: CookieJar) -> StatusCode {
    if signed_in(&state, &jar).await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    }
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

async fn login(
    State(state): State<Shared>,
    jar: CookieJar,
    Json(body): Json<LoginBody>,
) -> Response {
    if body.password != state.password {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(token.clone());
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.secure_cookie)
        .path("/")
        .build();
    (jar.add(cookie), StatusCode::NO_CONTENT).into_response()
}

#[derive(Deserialize)]
struct DesignBody {
    /// What the person typed.
    message: String,
    /// The current design file, when this is a change to an existing one.
    html: Option<String>,
    /// The conversation so far, oldest first, so a follow-up like "you only
    /// changed the colour" can be understood.
    #[serde(default)]
    history: Vec<Turn>,
}

#[derive(Deserialize)]
struct Turn {
    role: String,
    text: String,
}

async fn design(
    State(state): State<Shared>,
    jar: CookieJar,
    Json(body): Json<DesignBody>,
) -> Response {
    if !signed_in(&state, &jar).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(permit) = state.busy.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Another design is being made. Try again in a minute.",
        )
            .into_response();
    };

    let (tx, rx) = mpsc::channel::<Event>(256);
    let state2 = state.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let result = tokio::time::timeout(state2.timeout, run_design(&state2, &body, &tx)).await;
        let end = match result {
            Ok(Ok(())) => Event::default().event("done").data("{}"),
            Ok(Err(message)) => {
                tracing::warn!("design failed: {message}");
                Event::default()
                    .event("error")
                    .data(json!({ "message": message }).to_string())
            }
            Err(_) => Event::default().event("error").data(
                json!({ "message": "The design took too long and was stopped." }).to_string(),
            ),
        };
        tx.send(end).await.ok();
    });

    Sse::new(ReceiverStream::new(rx).map(Ok::<_, Infallible>))
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn status(tx: &mpsc::Sender<Event>, text: &str) {
    tx.send(
        Event::default()
            .event("status")
            .data(json!({ "text": text }).to_string()),
    )
    .await
    .ok();
}

/// Gathers what the designer needs — the conversation, the current file and
/// any reference sites — and runs it.
async fn run_design(
    state: &AppState,
    body: &DesignBody,
    tx: &mpsc::Sender<Event>,
) -> Result<(), String> {
    // Links in this message, or in the one before it when this one is a
    // follow-up about the same reference ("you only changed the colour").
    let mut links = reference::find_links(&body.message);
    if links.is_empty()
        && let Some(previous) = body.history.iter().rev().find(|t| t.role == "user")
    {
        links = reference::find_links(&previous.text);
    }

    let mut content: Vec<Value> = Vec::new();
    let request_dir = std::path::Path::new(&state.work_dir).join(uuid::Uuid::new_v4().to_string());
    for link in &links {
        let host = link
            .split("//")
            .nth(1)
            .and_then(|r| r.split('/').next())
            .unwrap_or(link);
        status(tx, &format!("Opening {host}…")).await;
        let capture = reference::capture(&state.capture_script, link, &request_dir).await;
        match &capture.error {
            None => status(tx, &format!("Studying {host}…")).await,
            Some(e) => {
                tracing::info!("reference {} failed: {e}", capture.url);
                status(tx, &format!("Could not open {host}")).await;
            }
        }
        content.extend(capture.blocks);
    }
    tokio::fs::remove_dir_all(&request_dir).await.ok();

    let mut prompt = String::new();
    let earlier: Vec<String> = body
        .history
        .iter()
        .rev()
        .take(8)
        .rev()
        .map(|t| {
            let who = if t.role == "user" { "Person" } else { "You" };
            format!("{who}: {}", t.text)
        })
        .collect();
    if !earlier.is_empty() {
        prompt.push_str("The conversation so far:\n\n");
        prompt.push_str(&earlier.join("\n"));
        prompt.push_str("\n\n");
    }
    match body.html.as_deref().filter(|h| !h.trim().is_empty()) {
        None => prompt.push_str(&format!(
            "New project. The person wrote:\n\n{}\n\nWrite your note, then create the design system and the page as one complete HTML file.",
            body.message
        )),
        Some(html) => prompt.push_str(&format!(
            "Here is the current design file:\n\n```html\n{html}\n```\n\nThe person now writes:\n\n{}\n\nWrite your note, then the complete updated HTML file (or only the note, if no change to the design is wanted).",
            body.message
        )),
    }
    if !links.is_empty() {
        prompt.push_str(
            "\n\nThe reference site(s) above were opened for you; follow the reference rules.",
        );
    }
    content.push(json!({ "type": "text", "text": prompt }));

    status(tx, "Designing…").await;
    run_claude(state, content, tx).await
}

/// Runs one `claude -p` turn with no tools and forwards its text as it streams.
async fn run_claude(
    state: &AppState,
    content: Vec<Value>,
    tx: &mpsc::Sender<Event>,
) -> Result<(), String> {
    let mut child = Command::new(&state.claude_bin)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--model",
            &state.model,
            "--system-prompt",
            SYSTEM_PROMPT,
        ])
        .current_dir(&state.work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start claude: {e}"))?;

    // The request can hold a whole design file and screenshots, so it goes in
    // on stdin as one user message rather than on the command line.
    let message = json!({
        "type": "user",
        "message": { "role": "user", "content": content },
    });
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = child.stdin.take().expect("stdin");
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(stdin);

    let stderr = child.stderr.take().expect("stderr");
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut failure: Option<String> = None;
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("stream_event") => {
                let inner = &event["event"];
                let text = inner["delta"]["text"].as_str();
                if let (true, Some(text)) = (inner["type"] == "content_block_delta", text) {
                    let data = json!({ "text": text }).to_string();
                    if tx
                        .send(Event::default().event("delta").data(data))
                        .await
                        .is_err()
                    {
                        // The browser went away; dropping the child stops claude.
                        return Ok(());
                    }
                }
            }
            Some("result") if event["is_error"].as_bool() == Some(true) => {
                failure = Some(
                    event["result"]
                        .as_str()
                        .unwrap_or("Claude returned an error.")
                        .to_string(),
                );
            }
            _ => {}
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if let Some(message) = failure {
        return Err(message);
    }
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            format!("claude exited with {status}")
        } else {
            stderr
        };
        return Err(detail);
    }
    Ok(())
}
