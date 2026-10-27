//! PKCE (RFC 7636), méthode S256 : le vérificateur reste dans l'app, seul son condensé part.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

/// Une valeur aléatoire de `bytes` octets, encodée en base64url sans remplissage.
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("source d'aléa du système indisponible");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// base64url(SHA-256(vérificateur)), comme l'api le recalcule à l'échange du code.
pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_token(32);
        let challenge = challenge_of(&verifier);
        Self { verifier, challenge }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// Adresse de connexion à ouvrir dans le navigateur du système.
pub fn login_url(server: &str, challenge: &str, redirect: &str, state: &str) -> Result<String, url::ParseError> {
    let mut url = url::Url::parse(server)?.join("/v1/auth/github")?;
    url.query_pairs_mut()
        .append_pair("client", "desktop")
        .append_pair("challenge", challenge)
        .append_pair("redirect", redirect)
        .append_pair("state", state);
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_and_challenge_have_the_rfc_shape() {
        let pkce = Pkce::new();
        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(pkce.challenge.len(), 43);
        assert!(pkce.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(Pkce::new().verifier, pkce.verifier);
    }

    #[test]
    fn challenge_matches_rfc7636_appendix_b() {
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn login_url_carries_the_desktop_parameters() {
        let url = login_url("https://jules.example.org", "abc", "http://127.0.0.1:5000/callback", "xyz").unwrap();
        assert_eq!(
            url,
            "https://jules.example.org/v1/auth/github?client=desktop&challenge=abc&redirect=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=xyz"
        );
        assert!(login_url("pas une url", "a", "b", "c").is_err());
    }
}
