use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use taskhub_backend::{build_app, AppState, Database};
use tempfile::TempDir;
use tower::ServiceExt;

fn app() -> (axum::Router, TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let state = AppState::new(db, Some("test-instance".into()));
    (build_app(state), directory)
}

async fn json_request(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn health_identifies_the_rust_backend() {
    let (app, _directory) = app();
    let (status, value) = json_request(&app, "GET", "/api/backend/health", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["service"], "taskhub");
    assert_eq!(value["runtime"], "rust");
    assert_eq!(value["instanceId"], "test-instance");
}

#[tokio::test]
async fn project_task_and_dashboard_contracts_round_trip() {
    let (app, _directory) = app();
    let (_, project) = json_request(&app, "POST", "/api/projects", json!({"name":"Native","repo":"openai/codex","workspace":"/tmp/native","jiraProjectKey":"task"})).await;
    assert_eq!(project["name"], "Native");
    assert_eq!(project["repo"], "openai/codex");
    assert_eq!(project["jiraProjectKey"], "TASK");
    let id = project["id"].as_str().unwrap();

    let (status, _) = json_request(&app, "POST", "/api/tasks", json!({"id":"session-1","projectId":id,"workspace":"/tmp/native","worktree":"/tmp/native.worktrees/task"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, tasks) = json_request(&app, "GET", "/api/tasks", Value::Null).await;
    assert_eq!(tasks[0]["id"], "session-1");
    assert_eq!(tasks[0]["pinned"], false);

    let (_, dashboard) = json_request(&app, "GET", "/api/dashboard", Value::Null).await;
    assert_eq!(dashboard[0]["id"], id);
    assert_eq!(dashboard[0]["prs"], json!([]));
}

#[tokio::test]
async fn settings_and_tabs_preserve_existing_json_shapes() {
    let (app, _directory) = app();
    let (status, _) =
        json_request(&app, "PUT", "/api/settings/theme", json!({"value":"dark"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, settings) = json_request(&app, "GET", "/api/settings", Value::Null).await;
    assert_eq!(settings["theme"], "dark");

    let (_, tabs) = json_request(&app, "POST", "/api/tabs", json!({"url":"https://github.com/openai/codex/pull/1","kind":"github","title":"PR 1","repo":"openai/codex","branch":"feature","category":"review","login":"octocat"})).await;
    assert_eq!(tabs["active"], "https://github.com/openai/codex/pull/1");
    assert_eq!(tabs["tabs"][0]["paneView"], "term");
}

#[tokio::test]
async fn invalid_project_and_tab_inputs_match_node_errors() {
    let (app, _directory) = app();
    let (status, value) = json_request(
        &app,
        "POST",
        "/api/projects",
        json!({"name":"","repo":"bad"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "name required");
    let (status, _) = json_request(
        &app,
        "POST",
        "/api/tabs",
        json!({"url":"file:///etc/passwd","kind":"web"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
