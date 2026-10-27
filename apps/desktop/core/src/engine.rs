//! Moteur de conteneurs du mode local (ARCHITECTURE.md §4.7) : Docker ou Podman, et le niveau
//! d'isolation qui en découle pour les sandboxes. Le shell lance `docker info` ou `podman info` avec
//! les formats ci-dessous ; ce module ne fait que lire leur sortie.

use std::fmt;

/// `docker info --format …` : version, système, puis les runtimes séparés par des espaces.
pub const DOCKER_INFO_FORMAT: &str =
    "{{.ServerVersion}}\n{{.OperatingSystem}}\n{{range $k, $v := .Runtimes}}{{$k}} {{end}}";
/// `podman info --format …` : version, système, service distant (machine virtuelle), runtime OCI.
pub const PODMAN_INFO_FORMAT: &str =
    "{{.Version.Version}}\n{{.Host.OS}}\n{{.Host.ServiceIsRemote}}\n{{.Host.OCIRuntime.Name}}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Docker,
    Podman,
}

/// Du plus fort au plus faible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    /// gVisor (`runsc`) : le noyau de l'hôte n'est pas exposé aux agents.
    Gvisor,
    /// VM de Docker Desktop ou de Podman (macOS, Windows) : sans gVisor, mais hors de l'hôte.
    Vm,
    /// Conteneur ordinaire sur l'hôte : isolation faible.
    Runc,
}

impl Isolation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gvisor => "gvisor",
            Self::Vm => "vm",
            Self::Runc => "runc",
        }
    }

    /// Runtime des sandboxes, transmis au worker (`JULES_SANDBOX_RUNTIME`).
    pub fn runtime(self) -> &'static str {
        match self {
            Self::Gvisor => "runsc",
            Self::Vm | Self::Runc => "runc",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    pub kind: EngineKind,
    pub version: String,
    pub isolation: Isolation,
    /// Le démon tourne dans une VM : l'app la joint par `host.docker.internal`, pas par un socket.
    pub in_vm: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct EngineError(pub &'static str);

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

fn version_of(line: Option<&str>) -> Result<String, EngineError> {
    let version = line.map(str::trim).unwrap_or_default();
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+~".contains(c)) {
        return Err(EngineError("version du moteur illisible"));
    }
    Ok(version.to_string())
}

pub fn parse_docker_info(output: &str) -> Result<Engine, EngineError> {
    let mut lines = output.lines();
    let version = version_of(lines.next())?;
    let os = lines.next().unwrap_or_default();
    let runtimes: Vec<&str> = lines.next().unwrap_or_default().split_whitespace().collect();
    // Docker Desktop (macOS, Windows, et aussi Linux) fait tourner le démon dans sa VM.
    let in_vm = os.contains("Docker Desktop");
    let isolation = if runtimes.contains(&"runsc") {
        Isolation::Gvisor
    } else if in_vm {
        Isolation::Vm
    } else {
        Isolation::Runc
    };
    Ok(Engine { kind: EngineKind::Docker, version, isolation, in_vm })
}

pub fn parse_podman_info(output: &str) -> Result<Engine, EngineError> {
    let mut lines = output.lines();
    let version = version_of(lines.next())?;
    let _os = lines.next();
    let in_vm = lines.next().map(str::trim) == Some("true");
    let runtime = lines.next().map(str::trim).unwrap_or_default();
    let isolation = if runtime == "runsc" {
        Isolation::Gvisor
    } else if in_vm {
        Isolation::Vm
    } else {
        Isolation::Runc
    };
    Ok(Engine { kind: EngineKind::Podman, version, isolation, in_vm })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_engine_with_gvisor_on_linux() {
        let engine = parse_docker_info("28.5.1\nUbuntu 24.04.3 LTS\nio.containerd.runc.v2 runc runsc \n").unwrap();
        assert_eq!(engine.kind, EngineKind::Docker);
        assert_eq!(engine.version, "28.5.1");
        assert_eq!(engine.isolation, Isolation::Gvisor);
        assert_eq!(engine.isolation.runtime(), "runsc");
        assert!(!engine.in_vm);
    }

    #[test]
    fn docker_desktop_runs_agents_in_its_vm() {
        let engine = parse_docker_info("29.0.0\nDocker Desktop\nio.containerd.runc.v2 runc \n").unwrap();
        assert_eq!(engine.isolation, Isolation::Vm);
        assert_eq!(engine.isolation.as_str(), "vm");
        assert_eq!(engine.isolation.runtime(), "runc");
        assert!(engine.in_vm);
    }

    #[test]
    fn docker_engine_without_gvisor_is_weak() {
        let engine = parse_docker_info("28.5.1\nDebian GNU/Linux 13 (trixie)\nio.containerd.runc.v2 runc \n").unwrap();
        assert_eq!(engine.isolation, Isolation::Runc);
    }

    #[test]
    fn podman_machine_and_podman_on_linux() {
        let machine = parse_podman_info("5.6.2\nlinux\ntrue\ncrun\n").unwrap();
        assert_eq!((machine.kind, machine.isolation, machine.in_vm), (EngineKind::Podman, Isolation::Vm, true));
        let native = parse_podman_info("5.6.2\nlinux\nfalse\ncrun\n").unwrap();
        assert_eq!(native.isolation, Isolation::Runc);
        let gvisor = parse_podman_info("5.6.2\nlinux\nfalse\nrunsc\n").unwrap();
        assert_eq!(gvisor.isolation, Isolation::Gvisor);
    }

    #[test]
    fn unreadable_output_is_refused() {
        assert!(parse_docker_info("").is_err());
        assert!(parse_docker_info("Cannot connect to the Docker daemon\n").is_err());
        assert!(parse_podman_info("$(touch x)\n").is_err());
    }
}
