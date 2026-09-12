fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(directory) = args.next() else {
        eprintln!("usage: taskhub-ptyd <data-directory>");
        std::process::exit(2);
    };
    if args.next().is_some() {
        eprintln!("usage: taskhub-ptyd <data-directory>");
        std::process::exit(2);
    }
    // The helper is its own session leader; shells survive a native app crash.
    if unsafe { libc::setsid() } == -1 {
        eprintln!("setsid: {}", std::io::Error::last_os_error());
        std::process::exit(1);
    }
    taskhub_ptyd::main(directory.into());
}
