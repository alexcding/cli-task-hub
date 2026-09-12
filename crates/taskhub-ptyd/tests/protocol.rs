use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use serde_json::{json, Value};

struct Fixture { child: Child, directory: std::path::PathBuf }
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn standalone_helper_preserves_protocol_and_reconnects() {
    let directory = std::path::PathBuf::from(format!("/tmp/taskhub-ptyd-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("ptyd.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_taskhub-ptyd"))
        .arg(&directory).env("TASKHUB_PTYD_SOCK", &socket)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let mut fixture = Fixture { child, directory };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        if let Ok(stream) = UnixStream::connect(&socket) { break stream; }
        assert!(Instant::now() < deadline, "daemon did not bind");
        assert!(fixture.child.try_wait().unwrap().is_none(), "daemon exited");
        std::thread::sleep(Duration::from_millis(20));
    };
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    // Fragment one request and coalesce its end with the next request.
    stream.write_all(b"{\"id\":1,\"op\":").unwrap();
    stream.write_all(b"\"hello\"}\n{\"id\":2,\"op\":\"list\"}\n").unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], 1);
    assert_eq!(response["ok"]["protocol"], taskhub_ptyd::PROTOCOL);
    assert_eq!(response["ok"]["pid"], fixture.child.id());
    line.clear();
    reader.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"id":2,"ok":[]}));
    drop(reader);
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    stream.write_all(b"{\"id\":3,\"op\":\"hello\"}\n").unwrap();
    line.clear();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"]["pid"], fixture.child.id());
}
