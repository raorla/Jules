//! Compatibilité avec le serveur : un desktop trop ancien demande une mise à jour au lieu de se
//! connecter (`/v1/health` publie `desktop.minVersion`).

use semver::Version;

#[derive(Debug, PartialEq, Eq)]
pub enum Compatibility {
    Compatible,
    UpdateRequired { minimum: String },
    /// Version illisible : par prudence, on ne se connecte pas.
    Unknown,
}

pub fn check(app: &str, minimum: &str) -> Compatibility {
    match (Version::parse(app), Version::parse(minimum)) {
        (Ok(app), Ok(min)) if app >= min => Compatibility::Compatible,
        (Ok(_), Ok(min)) => Compatibility::UpdateRequired { minimum: min.to_string() },
        _ => Compatibility::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semantic_versions() {
        assert_eq!(check("0.2.0", "0.1.0"), Compatibility::Compatible);
        assert_eq!(check("0.1.0", "0.1.0"), Compatibility::Compatible);
        assert_eq!(check("0.9.9", "1.0.0"), Compatibility::UpdateRequired { minimum: "1.0.0".into() });
        assert_eq!(check("1.0.0-beta.1", "1.0.0"), Compatibility::UpdateRequired { minimum: "1.0.0".into() });
        assert_eq!(check("1.0", "1.0.0"), Compatibility::Unknown);
    }
}
