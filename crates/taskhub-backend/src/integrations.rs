use std::{
    collections::{HashMap, HashSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{Datelike, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    process::Child,
    sync::Mutex,
};
use uuid::Uuid;

use crate::{cli, error::ApiError, AppState};

type ApiResult<T> = Result<Json<T>, ApiError>;

pub struct ForwarderManager {
    children: Mutex<HashMap<String, Child>>,
    started: AtomicBool,
}

impl ForwarderManager {
    pub fn new() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            started: AtomicBool::new(false),
        }
    }
    pub fn start(self: &std::sync::Arc<Self>, app: AppState, port: u16) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                manager.sync(&app, port).await;
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    async fn sync(&self, app: &AppState, port: u16) {
        let desired: HashSet<String> = app
            .db
            .projects()
            .unwrap_or_default()
            .into_iter()
            .filter(|project| project["forwardWebhooks"].as_bool() == Some(true))
            .filter_map(|project| {
                project["repo"]
                    .as_str()
                    .filter(|repo| !repo.is_empty())
                    .map(str::to_owned)
            })
            .collect();
        let mut children = self.children.lock().await;
        let existing = children.keys().cloned().collect::<Vec<_>>();
        for repo in existing {
            let exited = children
                .get_mut(&repo)
                .and_then(|child| child.try_wait().ok())
                .flatten()
                .is_some();
            if exited || !desired.contains(&repo) {
                if let Some(mut child) = children.remove(&repo) {
                    let _ = child.start_kill();
                }
            }
        }
        for repo in desired {
            if children.contains_key(&repo) {
                continue;
            }
            let child = crate::cli::command("gh")
                .args([
                    "webhook",
                    "forward",
                    &format!("--repo={repo}"),
                    "--events=pull_request",
                    &format!("--url=http://127.0.0.1:{port}/webhook/github"),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn();
            match child {
                Ok(child) => {
                    children.insert(repo.clone(), child);
                    if let Ok(event) = app.db.add_log(
                        "webhook",
                        "info",
                        "forwarder_started",
                        &json!({"repo":repo}),
                    ) {
                        app.broadcast(json!({"type":"activity","event":event}));
                    }
                }
                Err(error) => {
                    let _ = app.db.add_log(
                        "webhook",
                        "error",
                        "forwarder_failed",
                        &json!({"repo":repo,"error":error.to_string()}),
                    );
                }
            }
        }
    }
    pub async fn list(&self) -> Vec<String> {
        let mut values = self
            .children
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        values.sort();
        values
    }
    pub async fn stop(&self) {
        let mut children = self.children.lock().await;
        for (_, child) in children.iter_mut() {
            let _ = child.start_kill();
        }
        children.clear();
    }
}

pub async fn jira_site(State(app): State<AppState>) -> ApiResult<Value> {
    let configured = app.db.config_value("jira_base_url")?.unwrap_or_default();
    let auth = cli::run("acli", ["jira", "auth", "status"], Duration::from_secs(15))
        .await
        .unwrap_or_default();
    let field = |name: &str| {
        auth.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.trim().eq_ignore_ascii_case(name))
                .map(|(_, value)| value.trim().to_owned())
        })
    };
    let mut base = if configured.is_empty() {
        field("Site").unwrap_or_default()
    } else {
        configured
    };
    if !base.is_empty() && !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("https://{base}")
    }
    while base.ends_with('/') {
        base.pop();
    }
    Ok(Json(
        json!({"baseUrl":base,"me":{"email":field("Email"),"accountId":null}}),
    ))
}

pub(crate) fn render_version_template(template: &str, pr_number: i64) -> Result<String, ApiError> {
    let raw = template.trim();
    if raw.is_empty() {
        return Err(ApiError::bad_request("version template is empty"));
    }
    if raw.contains("${")
        || raw.contains("return ")
        || raw.contains("=>")
        || raw.contains("function")
    {
        return Err(ApiError::bad_request("JavaScript version scripts are no longer executed. Replace this value with a template such as 0.{isoWeek}."));
    }
    let now = Utc::now();
    let replacements = [
        ("{year}", format!("{:04}", now.year())),
        ("{month}", format!("{:02}", now.month())),
        ("{day}", format!("{:02}", now.day())),
        ("{isoWeek}", format!("{:02}", now.iso_week().week())),
        ("{prNumber}", pr_number.to_string()),
    ];
    let mut value = raw.to_owned();
    for (key, replacement) in replacements {
        value = value.replace(key, &replacement)
    }
    if value.contains('{') || value.contains('}') || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "Unknown or invalid version-template placeholder",
        ));
    }
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(ApiError::bad_request(
            "version template must produce 1–128 characters",
        ));
    }
    Ok(value.into())
}

pub async fn fix_version_preview(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Value> {
    let project = app
        .db
        .project(&id)?
        .ok_or_else(|| ApiError::not_found("project not found"))?;
    let number = render_version_template(body["script"].as_str().unwrap_or(""), 0)?;
    let version = format!("{}{}", body["prefix"].as_str().unwrap_or(""), number);
    let key = project["jiraProjectKey"].as_str().unwrap_or("");
    let existing = if key.is_empty() {
        vec![]
    } else {
        cli::run(
            "acli",
            ["jira", "project", "view", "--key", key, "--json"],
            Duration::from_secs(30),
        )
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value["versions"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item["name"].as_str().map(String::from))
        .collect::<Vec<_>>()
    };
    Ok(Json(
        json!({"version":version,"number":number,"exists":existing.contains(&version)}),
    ))
}

pub async fn cli_tools() -> ApiResult<Value> {
    async fn probe(program: &str, auth: Option<Vec<&str>>) -> Value {
        let present = cli::run(program, ["--version"], Duration::from_secs(4))
            .await
            .is_ok();
        let authed = if present {
            if let Some(args) = auth {
                Some(
                    cli::run(program, args, Duration::from_secs(8))
                        .await
                        .is_ok(),
                )
            } else {
                None
            }
        } else {
            None
        };
        let mut value = json!({"present":present});
        if let Some(authed) = authed {
            value["authed"] = json!(authed)
        }
        value
    }
    let (claude, codex, gh, acli) = tokio::join!(
        probe("claude", None),
        probe("codex", None),
        probe("gh", Some(vec!["auth", "status"])),
        probe("acli", Some(vec!["jira", "auth", "status"]))
    );
    Ok(Json(
        json!({"claude":claude,"codex":codex,"gh":gh,"acli":acli}),
    ))
}

const MARKER: &str = "taskhub-workflow-hook";
const EVENTS: [(&str, &str); 2] = [
    ("UserPromptSubmit", "/api/hooks/turn-start"),
    ("Stop", "/api/hooks/turn-done"),
];
fn hook_file(cli: &str) -> Result<(PathBuf, Value), ApiError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| ApiError::bad_request("Home directory is unavailable"))?;
    match cli {
        "claude" => Ok((home.join(".claude/settings.json"), json!({}))),
        "codex" => Ok((home.join(".codex/hooks.json"), json!({"hooks":{}}))),
        _ => Err(ApiError::bad_request(format!("unknown CLI: {cli}"))),
    }
}
fn read_json(path: &PathBuf) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}
fn is_our_entry(entry: &Value) -> bool {
    entry["hooks"].as_array().is_some_and(|hooks| {
        hooks.iter().any(|hook| {
            hook["command"]
                .as_str()
                .is_some_and(|command| command.contains(MARKER))
        })
    })
}
fn hook_status_for(cli: &str) -> String {
    let Ok((file, _)) = hook_file(cli) else {
        return "absent".into();
    };
    let Some(value) = read_json(&file) else {
        return "absent".into();
    };
    if EVENTS.iter().all(|(event, _)| {
        value["hooks"][event]
            .as_array()
            .is_some_and(|items| items.iter().any(is_our_entry))
    }) {
        "installed".into()
    } else {
        "absent".into()
    }
}
fn hook_status() -> Value {
    json!({"claude":hook_status_for("claude"),"codex":hook_status_for("codex")})
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace(char::from(39), "'\"'\"'"))
}
fn hook_entry(cli: &str, endpoint: &str, port_file: &PathBuf) -> Value {
    let script=format!("P=$(cat {} 2>/dev/null || echo 3000); curl -s -m 2 -X POST \"http://127.0.0.1:$P{endpoint}?cli={cli}&runId=${{TASKHUB_RUN_ID:-}}\" -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1 || true # {MARKER}",shell_quote(&port_file.to_string_lossy()));
    let mut entry =
        json!({"hooks":[{"type":"command","command":format!("sh -c {}",shell_quote(&script))}]});
    if cli == "claude" {
        entry["matcher"] = json!(".*")
    }
    entry
}
fn write_json(path: &PathBuf, value: &Value) -> Result<(), ApiError> {
    let destination = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?
    }
    let temporary = destination.with_file_name(format!(".taskhub-hooks-{}.json", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value).map_err(ApiError::internal)?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes).map_err(ApiError::internal)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(ApiError::internal)?;
    fs::rename(temporary, destination).map_err(ApiError::internal)
}
fn change_hooks(app: &AppState, cli_name: &str, install: bool) -> Result<Value, ApiError> {
    let (file, base) = hook_file(cli_name)?;
    let mut config = match fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| {
            ApiError::bad_request(format!(
                "Cannot update hooks: {} contains invalid JSON. The file was not changed.",
                file.display()
            ))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => base,
        Err(error) => return Err(ApiError::internal(error)),
    };
    if !config.is_object() {
        return Err(ApiError::bad_request(format!("Cannot update hooks: {} has an unsupported configuration shape. The file was not changed.",file.display())));
    }
    if !config["hooks"].is_object() {
        config["hooks"] = json!({})
    }
    let port_file = app.db.data_dir.join(".server-port");
    for (event, endpoint) in EVENTS {
        let mut entries = config["hooks"][event]
            .as_array()
            .cloned()
            .unwrap_or_default();
        entries.retain(|entry| !is_our_entry(entry));
        if install {
            entries.push(hook_entry(cli_name, endpoint, &port_file))
        }
        config["hooks"][event] = Value::Array(entries)
    }
    write_json(&file, &config)?;
    Ok(hook_status())
}
pub async fn agent_hooks() -> ApiResult<Value> {
    Ok(Json(hook_status()))
}
pub async fn install_hook(
    State(app): State<AppState>,
    Path(cli): Path<String>,
) -> ApiResult<Value> {
    let status = change_hooks(&app, &cli, true)?;
    Ok(Json(json!({"ok":true,"status":status})))
}
pub async fn uninstall_hook(
    State(app): State<AppState>,
    Path(cli): Path<String>,
) -> ApiResult<Value> {
    let status = change_hooks(&app, &cli, false)?;
    Ok(Json(json!({"ok":true,"status":status})))
}

#[derive(Default, Deserialize)]
pub struct HookQuery {
    cli: Option<String>,
    #[serde(rename = "runId")]
    run_id: Option<String>,
}
async fn relay(app: AppState, query: HookQuery, body: Value, kind: &str) -> StatusCode {
    let session = body["session_id"].as_str().unwrap_or("");
    app.broadcast(json!({"type":kind,"cli":query.cli.unwrap_or_default(),"runId":query.run_id.unwrap_or_default(),"sessionId":session,"payload":body}));
    StatusCode::NO_CONTENT
}
pub async fn turn_start(
    State(app): State<AppState>,
    Query(query): Query<HookQuery>,
    Json(body): Json<Value>,
) -> StatusCode {
    relay(app, query, body, "agent-turn-start").await
}
pub async fn turn_done(
    State(app): State<AppState>,
    Query(query): Query<HookQuery>,
    Json(body): Json<Value>,
) -> StatusCode {
    relay(app, query, body, "agent-turn-done").await
}

fn analysis_prompt(text: &str, context: &str) -> String {
    let workflow = !context.trim().is_empty();
    let mut prompt=format!("You are monitoring a coding agent in a terminal. Reply with ONLY a compact JSON object. Required fields: summary (max 18 words), state (done, needs_input, working, or blocked){}.",if workflow{", decision (proceed, retry, or stop), and reason (max 12 words)"}else{""});
    if workflow {
        prompt.push_str("\nWorkflow context: ");
        prompt.push_str(context)
    }
    prompt.push_str("\n---\n");
    prompt.push_str(text);
    prompt
}
fn parse_analysis(raw: &str, workflow: bool) -> Value {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let mut value = serde_json::from_str::<Value>(trimmed).unwrap_or_else(
        |_| json!({"summary":trimmed.lines().last().unwrap_or("").trim(),"state":""}),
    );
    if workflow
        && !matches!(
            value["decision"].as_str(),
            Some("proceed" | "retry" | "stop")
        )
    {
        value["decision"] = json!("proceed")
    }
    value
}
pub async fn agent_analyze(
    State(app): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Value> {
    let text = body["text"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad_request("no text to analyze"))?;
    let context = body["context"].as_str().unwrap_or("");
    let agent = if body["cli"] == "codex" {
        "codex"
    } else {
        "claude"
    };
    let prompt = analysis_prompt(text, context);
    let result = if agent == "codex" {
        cli::run(
            "codex",
            [
                "exec",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                &prompt,
            ],
            Duration::from_secs(120),
        )
        .await
    } else {
        cli::run(
            "claude",
            ["-p", "--max-turns", "1", "--output-format", "text", &prompt],
            Duration::from_secs(120),
        )
        .await
    };
    match result {
        Ok(raw) => Ok(Json(parse_analysis(&raw, !context.trim().is_empty()))),
        Err(error) => {
            let _ = app.db.add_log(
                "agent",
                "error",
                "analyze_failed",
                &json!({"cli":agent,"error":error.to_string()}),
            );
            Err(ApiError::status(StatusCode::BAD_GATEWAY, error.to_string()))
        }
    }
}

pub async fn forwarders(State(app): State<AppState>) -> ApiResult<Vec<String>> {
    Ok(Json(app.forwarders.list().await))
}

pub async fn github_webhook(
    State(app): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    if headers.get("x-github-event").and_then(|v| v.to_str().ok()) != Some("pull_request")
        || body["action"] != "closed"
        || body["pull_request"]["merged"] != true
    {
        return StatusCode::OK;
    }
    let repo = body["repository"]["full_name"].as_str().unwrap_or("");
    if let Ok(projects) = app.db.projects() {
        if let Some(project) = projects.into_iter().find(|p| {
            p["repo"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(repo))
        }) {
            let mut pr = body["pull_request"].clone();
            pr["url"] = pr["html_url"].clone();
            pr["state"] = json!("MERGED");
            app.poller.handle_merge(&app, &project, &pr);
        }
    }
    StatusCode::OK
}
