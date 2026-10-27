//! Lancement de la pile locale (M10) : détection du moteur, secrets du trousseau, remise de la clé
//! maître et de la clé API du fournisseur au worker, `compose up`. Le shell Tauri n'y ajoute que ses dossiers et le trousseau du
//! système (trait `Vault`).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::engine::{parse_docker_info, parse_podman_info, Engine, EngineKind, DOCKER_INFO_FORMAT, PODMAN_INFO_FORMAT};
use crate::handoff::{random_master_key, serve_once, HandoffError, Secrets};
use crate::pkce::random_token;
use crate::stack::{compose_command, compose_env, compose_failure, daemon_path, login_hash, StackConfig, PROJECT};

pub const LOCAL_API_PORT: u16 = 43117;
pub const MASTER_KEY_ENTRY: &str = "local:master-key";
pub const LOGIN_ENTRY: &str = "local:login-secret";
/// Clé API du fournisseur de modèle, saisie dans l'app : en mode local, elle ne passe ni par la base
/// ni par une passkey (la webview Linux n'en gère pas), seulement par le trousseau et la remise.
pub const API_KEY_ENTRY: &str = "local:anthropic-api-key";
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(180);

/// Le trousseau du système (Keychain, Gestionnaire d'identifiants, Secret Service).
pub trait Vault {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;

    /// Secret tiré au premier usage, puis toujours relu du trousseau.
    fn get_or_create(&self, name: &str, create: fn() -> String) -> Result<String, String> {
        if let Some(value) = self.get(name)? {
            return Ok(value);
        }
        let value = create();
        self.set(name, &value)?;
        Ok(value)
    }
}

/// Dossiers de l'app : la config compose embarquée, les données, le dossier d'exécution du système.
pub struct LocalPaths {
    pub compose: PathBuf,
    pub data: PathBuf,
    /// `XDG_RUNTIME_DIR` sous Linux : effacé à la fermeture de session.
    pub runtime: Option<PathBuf>,
    /// Dossiers autorisés (le dossier personnel par défaut).
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub engine: Option<Engine>,
    pub running: bool,
}

impl Status {
    pub fn url(&self) -> Option<String> {
        self.running.then(local_url)
    }
}

pub fn local_url() -> String {
    format!("http://127.0.0.1:{LOCAL_API_PORT}")
}

/// `docker info`, sinon `podman info` : le premier moteur qui répond.
pub fn detect() -> Option<Engine> {
    let info = |program: &str, format: &str| -> Option<String> {
        let output = Command::new(program).args(["info", "--format", format]).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    info("docker", DOCKER_INFO_FORMAT)
        .and_then(|out| parse_docker_info(&out).ok())
        .or_else(|| info("podman", PODMAN_INFO_FORMAT).and_then(|out| parse_podman_info(&out).ok()))
}

/// L'api locale répond sur l'adresse de bouclage, et c'est bien une api en mode local.
pub fn healthy(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let mut response = String::new();
    stream.write_all(request.as_bytes()).is_ok()
        && stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"mode\":\"local\"")
}

/// Le worker de la pile tourne. Il s'arrête sans redémarrer (la remise n'a lieu qu'une fois) : une api
/// qui répond ne suffit donc pas à dire que la pile tourne.
pub fn worker_running(kind: EngineKind) -> bool {
    let (program, _) = compose_command(kind);
    let project = format!("label=com.docker.compose.project={PROJECT}");
    Command::new(program)
        .args(["ps", "-q", "--filter", &project, "--filter", "label=com.docker.compose.service=worker"])
        .args(["--filter", "status=running"])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.trim_ascii().is_empty())
}

pub fn status() -> Status {
    let engine = detect();
    let running = engine.as_ref().is_some_and(|e| healthy(LOCAL_API_PORT) && worker_running(e.kind));
    Status { engine, running }
}

/// Clé API saisie dans l'app : une seule ligne, sans espace, de taille raisonnable.
pub fn api_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if !(20..=512).contains(&key.len()) || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("clé API invalide : une seule ligne, sans espace".into());
    }
    Ok(key.to_string())
}

fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn daemon(path: &Path) -> Result<String, String> {
    daemon_path(&path.to_string_lossy(), cfg!(windows)).ok_or_else(|| format!("chemin non pris en charge : {}", path.display()))
}

/// Chemin d'un dossier choisi, tel que le worker le voit (même chemin, sauf sous Windows).
pub fn container_path(path: &str) -> Result<String, String> {
    daemon(Path::new(path))
}

type Server = JoinHandle<Result<(), HandoffError>>;

/// Point de remise : TCP pour un démon dans une VM, socket Unix sinon.
fn handoff_server(engine: &Engine, dir: &Path, token: &str, secrets: Secrets) -> Result<(String, Server), String> {
    let token = token.to_string();
    if engine.in_vm {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let server = std::thread::spawn(move || serve_once(&listener, &token, &secrets, HANDOFF_TIMEOUT));
        return Ok((format!("http://host.docker.internal:{port}/handoff"), server));
    }
    #[cfg(unix)]
    {
        // Un socket par essai : après un lancement raté, l'attente du précédent (jusqu'à son délai)
        // ne doit pas effacer celui de l'essai suivant en se terminant.
        let name = format!("handoff-{}.sock", random_token(8));
        let socket = dir.join(&name);
        let listener = std::os::unix::net::UnixListener::bind(&socket).map_err(|e| e.to_string())?;
        let server = std::thread::spawn(move || {
            let result = serve_once(&listener, &token, &secrets, HANDOFF_TIMEOUT);
            let _ = std::fs::remove_file(&socket);
            result
        });
        Ok((format!("unix:/run/jules/handoff/{name}"), server))
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, secrets);
        Err("moteur hors VM non pris en charge sur ce système".into())
    }
}

/// Lance la pile et remet la clé maître et la clé API au worker, une seule fois. Rien de secret sur le
/// disque. `recreate_worker` relance le worker même s'il tourne : il reçoit alors une clé API changée.
pub fn start(paths: &LocalPaths, vault: &dyn Vault, version: &str, recreate_worker: bool) -> Result<Status, String> {
    let engine = detect().ok_or("ni Docker ni Podman ne répond")?;
    if !recreate_worker && healthy(LOCAL_API_PORT) && worker_running(engine.kind) {
        return Ok(Status { engine: Some(engine), running: true });
    }
    let api_key = vault.get(API_KEY_ENTRY)?.ok_or("clé API du fournisseur absente du trousseau")?;
    let master_key = vault.get_or_create(MASTER_KEY_ENTRY, random_master_key)?;
    let login_secret = vault.get_or_create(LOGIN_ENTRY, || random_token(32))?;
    let runs_dir = paths.data.join("runs");
    private_dir(&runs_dir)?;
    let handoff_dir = paths.runtime.as_ref().map_or_else(|| paths.data.join("handoff"), |d| d.join("jules"));
    private_dir(&handoff_dir)?;
    let token = random_token(32);
    let secrets = Secrets { master_key, previous_keys: vec![], anthropic_api_key: Some(api_key) };
    let (handoff_url, server) = handoff_server(&engine, &handoff_dir, &token, secrets)?;

    #[cfg(unix)]
    let (user, docker_gid) = {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&paths.root).map_err(|e| e.to_string())?;
        let gid = std::fs::metadata("/var/run/docker.sock").map(|m| m.gid().to_string()).ok();
        (Some(format!("{}:{}", meta.uid(), meta.gid())), gid)
    };
    #[cfg(not(unix))]
    let (user, docker_gid): (Option<String>, Option<String>) = (None, None);

    let (root, runs, handoff) = (daemon(&paths.root)?, daemon(&runs_dir)?, daemon(&handoff_dir)?);
    let hash = login_hash(&login_secret);
    let config = StackConfig {
        engine: engine.kind,
        isolation: engine.isolation,
        api_port: LOCAL_API_PORT,
        root: &root,
        runs_dir: &runs,
        handoff_url: &handoff_url,
        handoff_token: &token,
        handoff_dir: Some(&handoff),
        login_hash: &hash,
        user: user.as_deref(),
        docker_gid: docker_gid.as_deref(),
        version,
    };
    let (program, prefix) = compose_command(engine.kind);
    // Un jeton de remise neuf change l'environnement du worker : compose le recrée à chaque lancement.
    let recreate: &[&str] = if recreate_worker { &["--force-recreate", "worker"] } else { &[] };
    let up = Command::new(program)
        .args(prefix)
        .args(["-p", PROJECT, "-f"])
        .arg(&paths.compose)
        .args(["up", "-d", "--wait"])
        .args(recreate)
        .envs(compose_env(&config))
        .output()
        .map_err(|e| e.to_string())?;
    if !up.status.success() {
        let stderr = String::from_utf8_lossy(&up.stderr);
        return Err(compose_failure(program, version, &stderr, &[&token, &hash, &handoff_url]));
    }
    server.join().map_err(|_| "remise des secrets interrompue".to_string())?.map_err(|e| e.to_string())?;
    let running = healthy(LOCAL_API_PORT);
    Ok(Status { engine: Some(engine), running })
}

/// Arrête la pile ; les données (volume PostgreSQL) restent.
pub fn stop(paths: &LocalPaths) -> Result<(), String> {
    let engine = detect().ok_or("ni Docker ni Podman ne répond")?;
    let (program, prefix) = compose_command(engine.kind);
    let status = Command::new(program)
        .args(prefix)
        .args(["-p", PROJECT, "-f"])
        .arg(&paths.compose)
        .arg("stop")
        .status()
        .map_err(|e| e.to_string())?;
    status.success().then_some(()).ok_or_else(|| format!("{program} compose stop a échoué"))
}

/// Nom de la session du système, comme login de la personne dans son instance locale.
pub fn login_name(raw: &str) -> String {
    let login: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).take(39).collect();
    if login.is_empty() {
        "local".into()
    } else {
        login
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryVault(RefCell<HashMap<String, String>>);

    impl Vault for MemoryVault {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
    }

    #[test]
    fn secrets_are_created_once_then_read_back() {
        let vault = MemoryVault::default();
        let first = vault.get_or_create(MASTER_KEY_ENTRY, random_master_key).unwrap();
        assert_eq!(vault.get_or_create(MASTER_KEY_ENTRY, random_master_key).unwrap(), first);
        assert_ne!(vault.get_or_create(LOGIN_ENTRY, || random_token(32)).unwrap(), first);
    }

    #[test]
    fn health_requires_an_api_in_local_mode() {
        let serve = |body: &'static str| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer);
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            });
            port
        };
        assert!(healthy(serve(r#"{"ok":true,"api":"v1","mode":"local"}"#)));
        assert!(!healthy(serve(r#"{"ok":true,"api":"v1","mode":"server"}"#)));
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!healthy(closed));
    }

    #[test]
    fn api_keys_are_one_line_without_spaces() {
        let key = format!("sk-ant-api03-{}", "a".repeat(40));
        assert_eq!(api_key(&format!("  {key}\n")), Ok(key.clone()));
        assert!(api_key("trop-courte").is_err());
        assert!(api_key(&format!("{key} {key}")).is_err());
        assert!(api_key(&format!("{key}\n{key}")).is_err());
        assert!(api_key(&"a".repeat(513)).is_err());
        assert!(api_key("clé-avec-des-accents-é-0123456789").is_err());
    }

    #[test]
    fn login_names_are_safe() {
        assert_eq!(login_name("ada"), "ada");
        assert_eq!(login_name("Ada Lovelace"), "AdaLovelace");
        assert_eq!(login_name("$(rm)"), "rm");
        assert_eq!(login_name(""), "local");
    }

    #[cfg(unix)]
    #[test]
    fn the_handoff_point_is_a_private_unix_socket_outside_a_vm() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("jules-local-{}", std::process::id()));
        private_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let engine = parse_docker_info("28.5.1\nUbuntu\nrunc runsc\n").unwrap();
        let secrets = Secrets { master_key: random_master_key(), previous_keys: vec![], anthropic_api_key: None };
        let (url, server) = handoff_server(&engine, &dir, "jeton", secrets).unwrap();
        let name = url.strip_prefix("unix:/run/jules/handoff/").unwrap();
        assert!(name.starts_with("handoff-") && name.ends_with(".sock"), "{url}");
        // L'essai suivant a son propre socket.
        let other = Secrets { master_key: random_master_key(), previous_keys: vec![], anthropic_api_key: None };
        let (next, _) = handoff_server(&engine, &dir, "autre", other).unwrap();
        assert_ne!(next, url);
        let mut stream = std::os::unix::net::UnixStream::connect(dir.join(name)).unwrap();
        write!(stream, "POST /handoff HTTP/1.1\r\nAuthorization: Bearer jeton\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("\"masterKey\""));
        assert_eq!(server.join().unwrap(), Ok(()));
        // Le socket disparaît après la remise ; celui de l'essai suivant reste.
        assert!(!dir.join(name).exists());
        assert!(dir.join(next.strip_prefix("unix:/run/jules/handoff/").unwrap()).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
