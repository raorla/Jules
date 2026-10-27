//! Pile locale (ARCHITECTURE.md §4.7) : `deploy/local/compose.yaml`, lancée par `docker compose` ou
//! `podman compose`. Ce module calcule son environnement ; aucune valeur secrète n'y figure, car
//! Docker garde l'environnement des conteneurs sur le disque. La clé maître passe par la remise
//! (`handoff`), et l'api ne reçoit que le hash du secret de connexion.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::engine::{EngineKind, Isolation};

/// Nom du projet compose : un seul par machine et par personne.
pub const PROJECT: &str = "jules-local";

/// Hash du secret de connexion, comme l'api le compare (sha256, base64url sans remplissage).
pub fn login_hash(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

/// Chemin d'un dossier de la machine tel que le démon le voit. Sous Linux et macOS, le même chemin ;
/// sous Windows (Docker Desktop, WSL 2), les disques sont montés sous `/run/desktop/mnt/host`.
pub fn daemon_path(host_path: &str, windows: bool) -> Option<String> {
    if !windows {
        return host_path.starts_with('/').then(|| host_path.trim_end_matches('/').to_string());
    }
    let bytes = host_path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !matches!(bytes[2], b'\\' | b'/') {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = host_path[3..].replace('\\', "/");
    let rest = rest.trim_end_matches('/');
    Some(if rest.is_empty() {
        format!("/run/desktop/mnt/host/{drive}")
    } else {
        format!("/run/desktop/mnt/host/{drive}/{rest}")
    })
}

pub struct StackConfig<'a> {
    pub engine: EngineKind,
    pub isolation: Isolation,
    pub api_port: u16,
    /// Dossiers autorisés, en chemins du démon : montés au même chemin dans le worker.
    pub root: &'a str,
    /// Dossier des exécutions du worker, en chemin du démon.
    pub runs_dir: &'a str,
    pub handoff_url: &'a str,
    pub handoff_token: &'a str,
    /// Dossier du socket de remise (Linux) : monté dans le worker.
    pub handoff_dir: Option<&'a str>,
    pub login_hash: &'a str,
    /// uid:gid de la personne (Linux) : le worker écrit dans ses dossiers avec ses droits.
    pub user: Option<&'a str>,
    pub docker_gid: Option<&'a str>,
    pub version: &'a str,
}

/// Commande compose du moteur.
pub fn compose_command(engine: EngineKind) -> (&'static str, &'static [&'static str]) {
    match engine {
        EngineKind::Docker => ("docker", &["compose"]),
        EngineKind::Podman => ("podman", &["compose"]),
    }
}

/// Variables passées à `compose up`, dans l'environnement du processus, jamais dans un fichier.
pub fn compose_env(config: &StackConfig) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("JULES_VERSION", config.version.to_string()),
        ("JULES_LOCAL_API_PORT", config.api_port.to_string()),
        ("JULES_LOCAL_ROOT", config.root.to_string()),
        ("JULES_LOCAL_RUNS_DIR", config.runs_dir.to_string()),
        ("JULES_SANDBOX_RUNTIME", config.isolation.runtime().to_string()),
        ("JULES_SECRETS_HANDOFF_URL", config.handoff_url.to_string()),
        ("JULES_SECRETS_HANDOFF_TOKEN", config.handoff_token.to_string()),
        ("JULES_LOCAL_LOGIN_HASH", config.login_hash.to_string()),
        (
            "JULES_DOCKER_SOCKET",
            match config.engine {
                EngineKind::Docker => "/var/run/docker.sock".to_string(),
                EngineKind::Podman => "/run/podman/podman.sock".to_string(),
            },
        ),
    ];
    if let Some(dir) = config.handoff_dir {
        env.push(("JULES_HANDOFF_DIR", dir.to_string()));
    }
    if let Some(user) = config.user {
        env.push(("JULES_LOCAL_USER", user.to_string()));
    }
    if let Some(gid) = config.docker_gid {
        env.push(("DOCKER_GID", gid.to_string()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_hash_matches_the_api() {
        // Même calcul que l'api : createHash("sha256").update("abc").digest("base64url").
        assert_eq!(login_hash("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    }

    #[test]
    fn paths_as_the_daemon_sees_them() {
        assert_eq!(daemon_path("/home/ada/projets/", false).as_deref(), Some("/home/ada/projets"));
        assert_eq!(daemon_path("relatif", false), None);
        assert_eq!(
            daemon_path("C:\\Users\\ada\\projets", true).as_deref(),
            Some("/run/desktop/mnt/host/c/Users/ada/projets")
        );
        assert_eq!(daemon_path("D:/", true).as_deref(), Some("/run/desktop/mnt/host/d"));
        assert_eq!(daemon_path("\\\\serveur\\partage", true), None);
    }

    #[test]
    fn the_environment_holds_no_secret_value() {
        let config = StackConfig {
            engine: EngineKind::Docker,
            isolation: Isolation::Gvisor,
            api_port: 43117,
            root: "/home/ada",
            runs_dir: "/home/ada/.local/share/jules/runs",
            handoff_url: "unix:/run/jules/handoff/handoff.sock",
            handoff_token: "jeton-a-usage-unique",
            handoff_dir: Some("/run/user/1000/jules"),
            login_hash: "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
            user: Some("1000:1000"),
            docker_gid: Some("984"),
            version: "0.1.0",
        };
        let env = compose_env(&config);
        let get = |k: &str| env.iter().find(|(key, _)| *key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("JULES_SANDBOX_RUNTIME"), Some("runsc"));
        assert_eq!(get("JULES_LOCAL_LOGIN_HASH"), Some(config.login_hash));
        assert_eq!(get("JULES_LOCAL_USER"), Some("1000:1000"));
        assert!(env.iter().all(|(k, _)| !k.contains("MASTER_KEY") && !k.contains("API_KEY")));
        assert_eq!(compose_command(EngineKind::Podman).0, "podman");
    }
}
