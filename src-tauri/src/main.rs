// SwarmPath Agent Bridge — Tauri v2 Main Process
//
// Spawns the Fastify sidecar server, health-checks it,
// then loads http://localhost:3300 in the webview.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

struct SidecarState {
    child: Option<CommandChild>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .setup(|app| {
            // --- Resolve paths ---
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");
            // Tauri puts "../web" and "../knowledge" under "_up_/" in Resources.
            // Set BRIDGE_ROOT to _up_/ so the server finds web/ and knowledge/.
            let bridge_root = resource_dir.join("_up_");
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            // Ensure data dir exists
            std::fs::create_dir_all(&app_data_dir).ok();

            // --- macOS PATH recovery ---
            // Apps launched from Finder have a minimal PATH.
            // Read the full PATH from the user's login shell.
            #[cfg(target_os = "macos")]
            {
                let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
                if let Ok(output) = std::process::Command::new(&user_shell)
                    .args(["-ilc", "echo -n \"$PATH\""])
                    .output()
                {
                    if let Ok(path) = String::from_utf8(output.stdout) {
                        if !path.is_empty() {
                            unsafe { std::env::set_var("PATH", &path); }
                        }
                    }
                }
            }

            // --- System Tray ---
            let show_item =
                MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SwarmPath Agent Bridge")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // --- Spawn sidecar ---
            let port: u16 = 3300;
            let sidecar_cmd = app
                .shell()
                .sidecar("swarmpath-server")
                .expect("failed to setup sidecar")
                .env("PORT", port.to_string())
                .env(
                    "DATA_DIR",
                    app_data_dir.to_string_lossy().to_string(),
                )
                .env(
                    "BRIDGE_ROOT",
                    bridge_root.to_string_lossy().to_string(),
                )
                .env("ELECTRON", "1") // reuse flag to disable live-reload
                .env(
                    "SDK_ASSETS_DIR",
                    resource_dir.join("sdk-assets").to_string_lossy().to_string(),
                );

            let (mut rx, child) = sidecar_cmd.spawn().expect("failed to spawn sidecar");

            // Store child handle for cleanup
            app.state::<Mutex<SidecarState>>()
                .lock()
                .unwrap()
                .child = Some(child);

            // Log sidecar output in background
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // --- Health check loop → show window ---
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let url = format!("http://localhost:{}/health", port);
                let client = reqwest::Client::new();
                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if let Ok(resp) = client.get(&url).send().await {
                        if resp.status().is_success() {
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let load_url =
                                    format!("http://localhost:{}", port);
                                let _ = w.navigate(load_url.parse().unwrap());
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            return;
                        }
                    }
                }
                eprintln!("[tauri] Server health check timed out after 30s");
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app")
        .run(|app_handle, event| {
            match event {
                // macOS: hide window on close instead of quitting
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window(&label) {
                            let _ = w.hide();
                        }
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = (&label, &api); // suppress warnings
                    }
                }
                // Kill sidecar on exit
                RunEvent::ExitRequested { .. } => {
                    kill_sidecar(app_handle);
                }
                RunEvent::Exit => {
                    kill_sidecar(app_handle);
                }
                _ => {}
            }
        });
}

fn kill_sidecar(app_handle: &AppHandle) {
    if let Ok(mut state) = app_handle.state::<Mutex<SidecarState>>().lock() {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
    }
}
