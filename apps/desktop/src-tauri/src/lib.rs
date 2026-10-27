//! Shell Tauri de Jules (ARCHITECTURE.md §4.7) : trousseau, connexion OAuth avec PKCE sur une adresse
//! de bouclage, notifications natives, barre système, ouverture dans l'éditeur ; et, en mode local
//! (M10), la pile Jules sur la machine, lancée par Docker ou Podman, avec la clé maître remise au
//! worker depuis le trousseau. L'app n'a aucun chemin de code propre pour les agents : elle parle à
//! l'api comme le web.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use jules_desktop_core::callback::parse_callback;
use jules_desktop_core::engine::EngineKind;
use jules_desktop_core::local::{self, Vault};
use jules_desktop_core::pkce::{login_url, random_token, Pkce};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const SERVICE: &str = "jules-desktop";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Après une notification, le premier retour au premier plan (clic sur la notification) l'ouvre.
const NOTIFICATION_WINDOW: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Shell {
    pending_route: Mutex<Option<(String, Instant)>>,
    approvals_item: Mutex<Option<MenuItem<Wry>>>,
}

#[derive(Serialize)]
struct LoginResult {
    code: String,
    verifier: String,
}

fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, server).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_get(server: String) -> Result<Option<String>, String> {
    match entry(&server)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn token_set(server: String, token: String) -> Result<(), String> {
    entry(&server)?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_delete(server: String) -> Result<(), String> {
    match entry(&server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Attend le retour du navigateur sur l'adresse de bouclage, puis répond une page simple.
fn wait_for_callback(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; 8192];
                let read = stream.read(&mut buffer).map_err(|e| e.to_string())?;
                let request = String::from_utf8_lossy(&buffer[..read]);
                let result = parse_callback(&request, state);
                let (status, body) = match &result {
                    Ok(_) => ("200 OK", "Connexion réussie : tu peux revenir dans Jules."),
                    Err(_) => ("400 Bad Request", "Connexion refusée : recommence depuis Jules."),
                };
                let page = format!("<!doctype html><meta charset=utf-8><title>Jules</title><p>{body}</p>");
                let _ = write!(stream, "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}", page.len());
                return result.map_err(|e| e.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("connexion non terminée dans le navigateur".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// OAuth dans le navigateur du système (RFC 8252) : PKCE S256, port de bouclage éphémère.
#[tauri::command]
async fn login(app: AppHandle, server: String) -> Result<LoginResult, String> {
    let pkce = Pkce::new();
    let state = random_token(24);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let url = login_url(&server, &pkce.challenge, &redirect, &state).map_err(|e| e.to_string())?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, &state))
        .await
        .map_err(|e| e.to_string())??;
    Ok(LoginResult { code, verifier: pkce.verifier })
}

#[tauri::command]
fn notify(app: AppHandle, shell: State<'_, Shell>, title: String, body: String, route: String) -> Result<(), String> {
    *shell.pending_route.lock().map_err(|e| e.to_string())? = Some((route, Instant::now()));
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_tray_count(app: AppHandle, shell: State<'_, Shell>, count: u32) -> Result<(), String> {
    if let Some(item) = shell.approvals_item.lock().map_err(|e| e.to_string())?.as_ref() {
        item.set_text(format!("Approbations en attente : {count}")).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("jules") {
        tray.set_tooltip(Some(format!("Jules · {count} approbation(s) en attente")))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Ouvre un fichier ou un dossier local dans l'éditeur (`JULES_EDITOR`, sinon `code`), sans shell.
#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.is_absolute() || !target.exists() {
        return Err("chemin local absolu et existant attendu".into());
    }
    let editor = std::env::var("JULES_EDITOR").unwrap_or_else(|_| "code".into());
    std::process::Command::new(editor).arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Mode local (M10) : la logique est dans jules_desktop_core::local ; le shell fournit ses dossiers
// et le trousseau du système.

struct Keychain;

impl Vault for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
struct EngineInfo {
    kind: &'static str,
    version: String,
}

#[derive(Serialize)]
struct LocalStatus {
    engine: Option<EngineInfo>,
    isolation: Option<&'static str>,
    running: bool,
    url: Option<String>,
}

impl From<local::Status> for LocalStatus {
    fn from(status: local::Status) -> Self {
        Self {
            url: status.url(),
            isolation: status.engine.as_ref().map(|e| e.isolation.as_str()),
            engine: status.engine.map(|e| EngineInfo {
                kind: match e.kind {
                    EngineKind::Docker => "docker",
                    EngineKind::Podman => "podman",
                },
                version: e.version,
            }),
            running: status.running,
        }
    }
}

#[derive(Serialize)]
struct LocalLogin {
    secret: String,
    login: String,
}

fn local_paths(app: &AppHandle) -> Result<local::LocalPaths, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("dossier personnel introuvable")?;
    Ok(local::LocalPaths {
        compose: app.path().resource_dir().map_err(|e| e.to_string())?.join("local").join("compose.yaml"),
        data: app.path().app_data_dir().map_err(|e| e.to_string())?,
        runtime: std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
        root: std::env::var_os("JULES_LOCAL_ROOT").map(PathBuf::from).unwrap_or(home),
    })
}

#[tauri::command]
async fn local_status() -> Result<LocalStatus, String> {
    tauri::async_runtime::spawn_blocking(|| local::status().into()).await.map_err(|e| e.to_string())
}

/// Lance la pile et remet la clé maître et la clé API du trousseau au worker, une seule fois.
#[tauri::command]
async fn local_start(app: AppHandle) -> Result<LocalStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        local::start(&local_paths(&app)?, &Keychain, env!("CARGO_PKG_VERSION"), false).map(Into::into)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// La clé API du fournisseur est dans le trousseau ; l'interface ne la relit jamais.
#[tauri::command]
fn local_has_api_key() -> Result<bool, String> {
    Ok(Keychain.get(local::API_KEY_ENTRY)?.is_some())
}

/// Range la clé API dans le trousseau. Si la pile tourne, le worker est relancé pour la recevoir.
#[tauri::command]
async fn local_set_api_key(app: AppHandle, key: String) -> Result<LocalStatus, String> {
    let key = local::api_key(&key)?;
    Keychain.set(local::API_KEY_ENTRY, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !local::status().running {
            return Ok(local::status().into());
        }
        local::start(&local_paths(&app)?, &Keychain, env!("CARGO_PKG_VERSION"), true).map(Into::into)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || local::stop(&local_paths(&app)?))
        .await
        .map_err(|e| e.to_string())?
}

/// Secret de connexion à l'api locale, et le nom de la session du système comme login.
#[tauri::command]
fn local_login_secret() -> Result<LocalLogin, String> {
    let secret = Keychain.get_or_create(local::LOGIN_ENTRY, || random_token(32))?;
    let login = local::login_name(&std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default());
    Ok(LocalLogin { secret, login })
}

/// Chemin d'un dossier choisi, tel que le worker le voit (même chemin, sauf sous Windows).
#[tauri::command]
fn local_container_path(path: String) -> Result<String, String> {
    local::container_path(&path)
}

fn show(app: &AppHandle, route: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("navigate", route.to_string());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app, "/")))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            token_get,
            token_set,
            token_delete,
            login,
            notify,
            set_tray_count,
            open_in_editor,
            local_status,
            local_start,
            local_stop,
            local_has_api_key,
            local_set_api_key,
            local_login_secret,
            local_container_path
        ])
        .setup(|app| {
            // Barre système (DESIGN.md §11) : approbations en attente, arrêt d'urgence, quitter.
            let approvals = MenuItem::with_id(app, "approvals", "Approbations en attente : 0", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Arrêt d'urgence…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter Jules", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&approvals, &stop, &separator, &quit])?;
            app.state::<Shell>().approvals_item.lock().map_err(|e| e.to_string())?.replace(approvals);
            TrayIconBuilder::with_id("jules")
                .tooltip("Jules")
                .icon(app.default_window_icon().cloned().ok_or("icône absente")?)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "approvals" => show(app, "/approvals"),
                    "stop" => show(app, "/?stop=1"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let app = window.app_handle();
                let route = app
                    .state::<Shell>()
                    .pending_route
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.take())
                    .filter(|(_, at)| at.elapsed() < NOTIFICATION_WINDOW);
                if let Some((route, _)) = route {
                    let _ = app.emit("navigate", route);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du lancement de Jules");
}
