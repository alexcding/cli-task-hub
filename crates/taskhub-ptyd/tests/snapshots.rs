#![cfg(feature = "terminal-snapshots")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Connection {
    reader: BufReader<UnixStream>,
    events: VecDeque<Value>,
    next_id: u64,
}

impl Connection {
    fn connect(path: &PathBuf) -> Self {
        let stream = UnixStream::connect(path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        Self {
            reader: BufReader::new(stream),
            events: VecDeque::new(),
            next_id: 0,
        }
    }
    fn frame(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.reader.read_line(&mut line).unwrap() > 0);
        assert!(line.len() < 2 * 1024 * 1024);
        serde_json::from_str(&line).unwrap()
    }
    fn request(&mut self, mut value: Value) -> Result<Value, String> {
        self.next_id += 1;
        value["id"] = json!(self.next_id);
        writeln!(self.reader.get_mut(), "{value}").unwrap();
        loop {
            let response = self.frame();
            if response["id"].as_u64() == Some(self.next_id) {
                return if let Some(error) = response["err"].as_str() {
                    Err(error.to_string())
                } else {
                    Ok(response["ok"].clone())
                };
            }
            self.events.push_back(response);
        }
    }
    fn event(&mut self) -> Value {
        self.events.pop_front().unwrap_or_else(|| self.frame())
    }
    fn hello(&mut self) {
        let hello = self
            .request(json!({"op":"hello", "dataEncoding":"base64",
            "snapshotRevision":taskhub_vt::GHOSTTY_REVISION}))
            .unwrap();
        assert_eq!(hello["snapshotRevision"], taskhub_vt::GHOSTTY_REVISION);
    }
    fn snapshot(&mut self, term: &str) -> (Value, Vec<u8>) {
        let header = self
            .request(json!({"op":"snapshotBegin", "term":term}))
            .unwrap();
        let mut bytes = Vec::new();
        while bytes.len() < header["size"].as_u64().unwrap() as usize {
            let chunk = self
                .request(
                    json!({"op":"snapshotRead", "token":header["token"], "offset":bytes.len()}),
                )
                .unwrap();
            let part = BASE64.decode(chunk["bytes"].as_str().unwrap()).unwrap();
            assert!(part.len() <= 128 * 1024);
            bytes.extend(part);
        }
        assert_eq!(bytes.len(), header["size"].as_u64().unwrap() as usize);
        (header, bytes)
    }
}

struct Fixture {
    child: Child,
    root: PathBuf,
    socket: PathBuf,
}
impl Fixture {
    fn start() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(format!("/tmp/th-snapshot-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("pty.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_taskhub-ptyd"))
            .arg(&root)
            .env("TASKHUB_PTYD_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let fixture = Self {
            child,
            root,
            socket,
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fixture.socket.exists() {
            assert!(Instant::now() < deadline, "isolated daemon did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        fixture
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this fixture's private socket/process/directory are touched.
        if let Ok(mut stream) = UnixStream::connect(&self.socket) {
            let _ = writeln!(stream, "{{\"id\":1,\"op\":\"killAll\"}}");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = BufReader::new(stream).read_line(&mut String::new());
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_shell_snapshot_survives_tail_truncation_resize_and_client_reconnect() {
    let fixture = Fixture::start();
    let script = fixture.root.join("shell.sh");
    std::fs::write(
        &script,
        br#"#!/bin/sh
stty -echo
i=0
while [ "$i" -lt 8000 ]; do
  printf 'history %05d styled \033[32mJapanese and crab text\033[0m line\r\n' "$i"
  i=$((i+1))
done
printf 'PRIMARY_MARKER\033[5;9H\0337\033[?2004h\033[?1049hALT_MARKER\033[31'
IFS= read -r next
printf 'mRED\033[0m\033[?1049l\0338AFTER_SAVED_CURSOR'
IFS= read -r next
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut connection = Connection::connect(&fixture.socket);
    assert!(connection
        .request(json!({"op":"snapshotBegin", "term":"unknown"}))
        .is_err());
    assert!(connection
        .request(json!({"op":"hello", "dataEncoding":"base64", "snapshotRevision":"wrong"}))
        .is_err());
    connection.hello();
    let term = connection
        .request(json!({"op":"create", "opts":{"cwd":fixture.root, "shell":script}}))
        .unwrap();
    let id = term["id"].as_str().unwrap();
    let mut output = Vec::new();
    while !output.ends_with(b"ALT_MARKER\x1b[31") {
        let event = connection.event();
        if event["ev"] == "data" {
            output.extend(BASE64.decode(event["bytes"].as_str().unwrap()).unwrap());
        }
    }
    assert!(output.len() > 256 * 1024);
    let tail = connection
        .request(json!({"op":"attach", "term":id}))
        .unwrap();
    assert_eq!(tail["truncated"], true);
    let (header, bytes) = connection.snapshot(id);
    assert_eq!(header["seq"], tail["seq"]);
    assert!(
        bytes.len() > 128 * 1024,
        "exercise more than one transport chunk"
    );
    let mut restored = taskhub_vt::Terminal::restore(&bytes).unwrap();
    assert!(String::from_utf8_lossy(&restored.formatted().unwrap()).contains("ALT_MARKER"));
    assert!(restored.mode(2004, false).unwrap());

    let mut other = Connection::connect(&fixture.socket);
    other.hello();
    assert!(other
        .request(json!({"op":"snapshotRead", "token":header["token"], "offset":0}))
        .is_err());
    assert!(connection
        .request(json!({"op":"resize", "term":id, "cols":65536, "rows":30}))
        .is_err());
    assert!(connection
        .request(json!({"op":"resize", "term":id, "cols":65535, "rows":65535}))
        .is_err());
    assert!(connection
        .request(json!({"op":"resize", "term":id, "cols":90, "rows":0}))
        .is_err());
    connection
        .request(json!({"op":"resize", "term":id, "cols":113, "rows":37}))
        .unwrap();
    restored.resize(113, 37).unwrap();
    let resized = connection.event();
    assert_eq!(resized["ev"], "resize");
    assert_eq!(
        resized["stateSeq"].as_u64().unwrap(),
        header["stateSeq"].as_u64().unwrap() + 1
    );
    connection
        .request(json!({"op":"write", "term":id, "data":"continue\n"}))
        .unwrap();
    let mut suffix = Vec::new();
    while !suffix.ends_with(b"AFTER_SAVED_CURSOR") {
        let event = connection.event();
        if event["ev"] == "data" {
            let bytes = BASE64.decode(event["bytes"].as_str().unwrap()).unwrap();
            restored.feed(&bytes);
            suffix.extend(bytes);
        }
    }
    drop(connection); // the shell and its authoritative state must survive
    let list = other.request(json!({"op":"list"})).unwrap();
    assert_eq!(list[0]["pid"], term["pid"]);
    let (new_header, new_bytes) = other.snapshot(id);
    assert_eq!(new_header["cols"], 113);
    assert_eq!(new_header["rows"], 37);
    let mut current = taskhub_vt::Terminal::restore(&new_bytes).unwrap();
    assert_eq!(current.formatted().unwrap(), restored.formatted().unwrap());
    assert_eq!(current.cursor().unwrap(), restored.cursor().unwrap());
    let text = String::from_utf8_lossy(&current.formatted().unwrap()).into_owned();
    assert!(
        text.contains("history 00000")
            && text.contains("PRIMARY_MARKER")
            && text.contains("AFTER_SAVED_CURSOR")
    );
    other
        .request(json!({"op":"snapshotEnd", "token":new_header["token"]}))
        .unwrap();
    assert!(other
        .request(json!({"op":"snapshotRead", "token":new_header["token"], "offset":0}))
        .is_err());
    other.request(json!({"op":"kill", "term":id})).unwrap();
}
