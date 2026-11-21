//! `gnome-server` binary entry point; see `gnome_server::cli`.

fn main() -> std::process::ExitCode {
    gnome_server::cli::main()
}
