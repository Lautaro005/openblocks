// OpenBlocks desktop app and command line.
//
//   openblocks              opens the app (or focuses it if it is open)
//   openblocks serve        runs only the local server (http://127.0.0.1:47880), for a browser or AI WorkStudio
//   openblocks mcp          the vault as an MCP server over stdio (--vault, --read-only, --with web,brain,lumina)
//   openblocks --version
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use openblocks_core::{http, AppState, DEFAULT_PORT, VERSION};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HELP: &str = "OpenBlocks — block notes on your own Markdown vault

Usage:
  openblocks                 open the app
  openblocks serve [--port N] [--open]
                             run only the local server (default port 47880)
  openblocks mcp [--vault DIR] [--read-only] [--with web,brain,lumina]
                             the vault as an MCP server over stdio
  openblocks update          install the latest release
  openblocks uninstall       remove the app (your vaults stay)
  openblocks --version
";

fn port_arg(args: &[String]) -> u16 {
    args.iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .or_else(|| {
            std::env::var("OPENBLOCKS_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
        })
        .unwrap_or(DEFAULT_PORT)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("mcp") => {
            if let Err(e) = openblocks_core::mcp_server::serve(&args[1..]) {
                eprintln!("openblocks mcp: {e}");
                std::process::exit(1);
            }
        }
        Some("serve") => serve(&args[1..]),
        // Internal: writes the page images of a scanned PDF, in its own process.
        Some("__pdf-images") => {
            let a =
                |i: usize| std::path::PathBuf::from(args.get(i).map(|s| s.as_str()).unwrap_or(""));
            if openblocks_core::localai::pdf_images_here(&a(1), &a(2)).is_err() {
                std::process::exit(2);
            }
        }
        // Internal: reads a PDF's text in its own process (a broken PDF can't take the app down).
        Some("__pdf-text") => {
            match openblocks_core::preview::pdf_text_here(std::path::Path::new(
                args.get(1).map(|s| s.as_str()).unwrap_or(""),
            )) {
                Ok(t) => print!("{t}"),
                Err(_) => std::process::exit(2),
            }
        }
        Some("update") => update(false),
        Some("uninstall") => update(true),
        Some("--version") | Some("-V") | Some("version") => println!("openblocks {VERSION}"),
        Some("--help") | Some("-h") | Some("help") => print!("{HELP}"),
        _ => desktop(port_arg(&args)),
    }
}

fn serve(args: &[String]) {
    let port = port_arg(args);
    let open = args.iter().any(|a| a == "--open");
    let rt = tokio::runtime::Runtime::new().expect("tokio");
    rt.block_on(async move {
        if http::running_on(port).await {
            println!("OpenBlocks is already running at http://127.0.0.1:{port}/");
            return;
        }
        let st = AppState::new();
        let (listener, real) = match http::bind(port).await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("openblocks: {e}");
                std::process::exit(1);
            }
        };
        let url = format!("http://127.0.0.1:{real}/");
        println!("OpenBlocks {VERSION} running at {url}  (Ctrl+C to stop)");
        if open {
            let _ = openblocks_core::sys::open_url(&url);
        }
        if let Err(e) = http::serve(st, listener, real).await {
            eprintln!("openblocks: {e}");
        }
    });
}

/// `openblocks update` and `openblocks uninstall` run the same installer the app came from.
fn update(uninstall: bool) {
    let status = if cfg!(windows) {
        let script = if uninstall {
            "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.ps1))) -Uninstall"
        } else {
            "irm https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.ps1 | iex"
        };
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .status()
    } else {
        let flag = if uninstall { " -s -- --uninstall" } else { "" };
        std::process::Command::new("sh")
            .args(["-c", &format!("curl -fsSL https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.sh | sh{flag}")])
            .status()
    };
    std::process::exit(status.map(|s| s.code().unwrap_or(1)).unwrap_or(1));
}

fn desktop(port: u16) {
    // The server runs on its own runtime thread; the window loads it like any page.
    let rt = Arc::new(tokio::runtime::Runtime::new().expect("tokio"));
    let real = rt.block_on(async {
        if http::running_on(port).await {
            // `openblocks serve` (or WorkStudio) already runs one: use it.
            return port;
        }
        let st = AppState::new();
        let (listener, real) = http::bind(port).await.expect("no free port");
        tokio::spawn(async move {
            let _ = http::serve(st, listener, real).await;
        });
        real
    });
    let base = format!("http://127.0.0.1:{real}/");
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "win"
    } else {
        "linux"
    };
    let start = format!("{base}?desktop={platform}");

    let rt_keep = rt.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let _ = &rt_keep;
            let handle = app.handle().clone();
            openblocks_core::set_folder_picker(Box::new(move |title| {
                use tauri_plugin_dialog::DialogExt;
                handle
                    .dialog()
                    .file()
                    .set_title(title)
                    .blocking_pick_folder()
                    .and_then(|p| p.into_path().ok())
            }));
            let url: tauri::Url = start.parse().expect("url");
            let base_c = base.clone();
            // Only macOS changes the builder below.
            #[allow(unused_mut)]
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("OpenBlocks")
                .inner_size(1320.0, 860.0)
                .min_inner_size(820.0, 560.0)
                .disable_drag_drop_handler()
                .on_navigation(move |u| {
                    let s = u.as_str();
                    if s.starts_with(&base_c)
                        || s.starts_with("about:")
                        || s.starts_with("blob:")
                        || s.starts_with("data:")
                    {
                        return true;
                    }
                    // Links to the web open in the browser, never inside the app window.
                    if s.starts_with("http://")
                        || s.starts_with("https://")
                        || s.starts_with("mailto:")
                    {
                        let _ = openblocks_core::sys::open_url(s);
                    }
                    false
                });
            #[cfg(target_os = "macos")]
            {
                b = b
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            b.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running OpenBlocks")
        .run(move |_, e| {
            // Stop the local models and the tunnel this process started.
            if let tauri::RunEvent::Exit = e {
                rt.block_on(async {
                    openblocks_core::localai::shutdown().await;
                    openblocks_core::remote::stop().await;
                });
            }
        });
}
