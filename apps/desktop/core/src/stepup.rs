//! Confirmation des actions sensibles depuis le desktop (ARCHITECTURE.md §4.7). La webview n'a pas de
//! passkey (WebKitGTK n'en gère aucune), et son origine n'est pas celle du serveur :
//! - mode connecté : la passkey se fait dans le navigateur du système, sur l'adresse du serveur ;
//! - mode local : le shell affiche une confirmation native, puis signe le défi de l'api avec une clé
//!   Ed25519 du trousseau. La page ne voit jamais cette clé : sans le clic dans la fenêtre native, elle
//!   n'obtient aucune signature. L'api ne connaît que la clé publique.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{Ed25519KeyPair, KeyPair};

/// Domaine de la signature : elle ne vaut que pour une confirmation de Jules, jamais pour autre chose.
pub const STEP_UP_DOMAIN: &str = "jules:local-step-up:";

fn is_token(value: &str, min: usize) -> bool {
    (min..=128).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Graine Ed25519 neuve (32 octets aléatoires), rangée telle quelle dans le trousseau.
pub fn random_seed() -> String {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("source d'aléa du système indisponible");
    URL_SAFE_NO_PAD.encode(seed)
}

fn key_pair(seed: &str) -> Result<Ed25519KeyPair, String> {
    let bytes = URL_SAFE_NO_PAD.decode(seed).map_err(|_| "clé de confirmation illisible".to_string())?;
    Ed25519KeyPair::from_seed_unchecked(&bytes).map_err(|_| "clé de confirmation invalide".to_string())
}

/// Clé publique (base64url) passée à l'api locale : elle n'est pas secrète.
pub fn public_key(seed: &str) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(key_pair(seed)?.public_key().as_ref()))
}

/// Signature (base64url) du défi de l'api, à usage unique et lié à la session.
pub fn sign(seed: &str, challenge: &str) -> Result<String, String> {
    if !is_token(challenge, 32) {
        return Err("défi de confirmation invalide".into());
    }
    let message = format!("{STEP_UP_DOMAIN}{challenge}");
    Ok(URL_SAFE_NO_PAD.encode(key_pair(seed)?.sign(message.as_bytes()).as_ref()))
}

/// Texte de la fenêtre native : le but annoncé par la page, sur une ligne et borné.
pub fn dialog_text(purpose: &str) -> String {
    let purpose: String = purpose.chars().filter(|c| !c.is_control()).take(100).collect();
    let purpose = purpose.trim();
    format!(
        "Action sensible demandée dans Jules :\n\n{}\n\nConfirme seulement si c'est toi qui viens de la demander.",
        if purpose.is_empty() { "action sensible" } else { purpose }
    )
}

/// Page de confirmation du serveur, à ouvrir dans le navigateur du système (mode connecté).
pub fn browser_url(server: &str, request: &str) -> Result<String, String> {
    let mut url = url::Url::parse(server).map_err(|_| "adresse du serveur invalide".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || !is_token(request, 32) {
        return Err("demande de confirmation invalide".into());
    }
    url.set_path("/stepup");
    url.set_query(None);
    url.query_pairs_mut().append_pair("request", request);
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    // RFC 8032, §7.1, test 1 : graine et clé publique connues.
    const SEED_HEX: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const PUBLIC_HEX: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const CHALLENGE: &str = "defi-de-test-0123456789abcdefghijklmnop";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn signs_the_challenge_with_the_keychain_key() {
        let seed = URL_SAFE_NO_PAD.encode(unhex(SEED_HEX));
        let public = public_key(&seed).unwrap();
        assert_eq!(hex(&URL_SAFE_NO_PAD.decode(&public).unwrap()), PUBLIC_HEX);
        let signature = sign(&seed, CHALLENGE).unwrap();
        // Même vecteur dans apps/api/test/local.test.ts : l'api vérifie ce que le shell signe.
        assert_eq!(signature, "NKjwF_f_4_ldDTp6fYJ2FbDiTKPdEenirp-MT6jWzCbXk8qCI2_xPAvPcNCB-w98nocM5gr7-Bv1Mw27f0e-Aw");
        let message = format!("{STEP_UP_DOMAIN}{CHALLENGE}");
        let verifier = UnparsedPublicKey::new(&ED25519, URL_SAFE_NO_PAD.decode(&public).unwrap());
        assert!(verifier.verify(message.as_bytes(), &URL_SAFE_NO_PAD.decode(&signature).unwrap()).is_ok());
        assert!(verifier.verify(CHALLENGE.as_bytes(), &URL_SAFE_NO_PAD.decode(&signature).unwrap()).is_err());
    }

    #[test]
    fn refuses_bad_seeds_and_challenges() {
        let seed = random_seed();
        assert_ne!(seed, random_seed());
        assert!(sign(&seed, "court").is_err());
        assert!(sign(&seed, &format!("{CHALLENGE} ; autre")).is_err());
        assert!(public_key("!!!").is_err());
        assert!(public_key(&URL_SAFE_NO_PAD.encode([1u8; 5])).is_err());
    }

    #[test]
    fn the_dialog_shows_one_bounded_line() {
        let text = dialog_text("Relever l'autonomie\nde local/calculs");
        assert!(text.contains("Relever l'autonomiede local/calculs"));
        assert!(dialog_text(&"x".repeat(500)).contains(&"x".repeat(100)));
        assert!(!dialog_text(&"x".repeat(500)).contains(&"x".repeat(101)));
        assert!(dialog_text("  ").contains("action sensible"));
    }

    #[test]
    fn the_browser_page_is_on_the_server() {
        let request = "R".repeat(43);
        assert_eq!(
            browser_url("https://jules.example.org/chemin?x=1", &request).unwrap(),
            format!("https://jules.example.org/stepup?request={request}")
        );
        assert!(browser_url("file:///etc/passwd", &request).is_err());
        assert!(browser_url("https://jules.example.org", "court").is_err());
        assert!(browser_url("https://jules.example.org", &format!("{request}&x=1")).is_err());
    }
}
