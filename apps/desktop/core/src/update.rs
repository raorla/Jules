//! Mises à jour signées (minisign, comme le plugin updater de Tauri) : une archive dont la signature
//! ne correspond pas à la clé publique embarquée est refusée.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    InvalidPublicKey,
    InvalidSignature,
    BadSignature,
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidPublicKey => "clé publique de mise à jour illisible",
            Self::InvalidSignature => "mise à jour sans signature valide",
            Self::BadSignature => "signature de la mise à jour incorrecte : installation refusée",
        })
    }
}

fn decode(text: &str) -> Option<String> {
    String::from_utf8(STANDARD.decode(text.trim()).ok()?).ok()
}

/// `public_key` et `signature` sont encodés en base64, comme dans `tauri.conf.json` et les `.sig`.
pub fn verify_update(public_key: &str, data: &[u8], signature: &str) -> Result<(), UpdateError> {
    let key = decode(public_key)
        .and_then(|text| PublicKey::decode(&text).ok())
        .ok_or(UpdateError::InvalidPublicKey)?;
    let sig = decode(signature)
        .and_then(|text| Signature::decode(&text).ok())
        .ok_or(UpdateError::InvalidSignature)?;
    key.verify(data, &sig, false).map_err(|_| UpdateError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn keypair() -> (minisign::PublicKey, minisign::SecretKey) {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        (pair.pk, pair.sk)
    }

    fn sign(pk: &minisign::PublicKey, sk: &minisign::SecretKey, data: &[u8]) -> String {
        let signature = minisign::sign(Some(pk), sk, Cursor::new(data), Some("jules"), Some("test")).unwrap();
        STANDARD.encode(signature.into_string())
    }

    fn public(pk: &minisign::PublicKey) -> String {
        STANDARD.encode(pk.to_box().unwrap().into_string())
    }

    #[test]
    fn accepts_a_release_signed_with_the_embedded_key() {
        let (pk, sk) = keypair();
        let archive = b"jules-desktop-0.2.0.AppImage";
        assert_eq!(verify_update(&public(&pk), archive, &sign(&pk, &sk, archive)), Ok(()));
    }

    #[test]
    fn refuses_unsigned_tampered_or_foreign_releases() {
        let (pk, sk) = keypair();
        let (other_pk, other_sk) = keypair();
        let archive = b"jules-desktop-0.2.0.AppImage";
        let key = public(&pk);
        assert_eq!(verify_update(&key, archive, ""), Err(UpdateError::InvalidSignature));
        assert_eq!(verify_update(&key, archive, "pas-une-signature"), Err(UpdateError::InvalidSignature));
        assert_eq!(verify_update(&key, b"archive modifiee", &sign(&pk, &sk, archive)), Err(UpdateError::BadSignature));
        assert_eq!(verify_update(&key, archive, &sign(&other_pk, &other_sk, archive)), Err(UpdateError::BadSignature));
        assert_eq!(verify_update("", archive, &sign(&pk, &sk, archive)), Err(UpdateError::InvalidPublicKey));
        assert_eq!(UpdateError::BadSignature.to_string(), "signature de la mise à jour incorrecte : installation refusée");
    }
}
