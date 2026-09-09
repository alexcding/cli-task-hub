// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `taskhub __ptyd__ <dir>`: run as the detached PTY daemon instead of the app (see ptyd.rs).
  let args: Vec<String> = std::env::args().collect();
  if args.get(1).map(String::as_str) == Some("__ptyd__") {
    let dir = args.get(2).map(std::path::PathBuf::from).expect("__ptyd__ needs a directory");
    app_lib::ptyd::main(dir);
  }
  app_lib::run();
}
