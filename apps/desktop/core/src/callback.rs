//! Retour de l'OAuth sur l'adresse de bouclage : une seule requête `GET /callback?code=…&state=…`.

use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum CallbackError {
    Malformed,
    WrongPath,
    StateMismatch,
    MissingCode,
}

impl fmt::Display for CallbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "requête de retour illisible",
            Self::WrongPath => "chemin de retour inattendu",
            Self::StateMismatch => "état OAuth différent : connexion refusée",
            Self::MissingCode => "code absent",
        })
    }
}

/// Comparaison sans court-circuit : la durée ne révèle pas où l'état diffère.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Extrait le code de la première ligne de la requête HTTP reçue sur l'adresse de bouclage.
pub fn parse_callback(request: &str, expected_state: &str) -> Result<String, CallbackError> {
    let line = request.lines().next().ok_or(CallbackError::Malformed)?;
    let mut parts = line.split(' ');
    let (method, target) = (parts.next(), parts.next());
    if method != Some("GET") {
        return Err(CallbackError::Malformed);
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{}", target.ok_or(CallbackError::Malformed)?))
        .map_err(|_| CallbackError::Malformed)?;
    if url.path() != "/callback" {
        return Err(CallbackError::WrongPath);
    }
    let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    if !same(&get("state").unwrap_or_default(), expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    match get("code") {
        Some(code) if !code.is_empty() && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => Ok(code),
        _ => Err(CallbackError::MissingCode),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_code_when_the_state_matches() {
        let request = "GET /callback?code=Ab-12_cd&state=etat HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n";
        assert_eq!(parse_callback(request, "etat"), Ok("Ab-12_cd".to_string()));
    }

    #[test]
    fn refuses_anything_else() {
        assert_eq!(parse_callback("GET /callback?code=a&state=autre HTTP/1.1", "etat"), Err(CallbackError::StateMismatch));
        assert_eq!(parse_callback("GET /callback?code=a HTTP/1.1", "etat"), Err(CallbackError::StateMismatch));
        assert_eq!(parse_callback("GET /autre?code=a&state=etat HTTP/1.1", "etat"), Err(CallbackError::WrongPath));
        assert_eq!(parse_callback("POST /callback?code=a&state=etat HTTP/1.1", "etat"), Err(CallbackError::Malformed));
        assert_eq!(parse_callback("GET", "etat"), Err(CallbackError::Malformed));
        assert_eq!(parse_callback("", "etat"), Err(CallbackError::Malformed));
        assert_eq!(parse_callback("GET /callback?state=etat HTTP/1.1", "etat"), Err(CallbackError::MissingCode));
        assert_eq!(parse_callback("GET /callback?code=%3Cscript%3E&state=etat HTTP/1.1", "etat"), Err(CallbackError::MissingCode));
        assert_eq!(CallbackError::StateMismatch.to_string(), "état OAuth différent : connexion refusée");
    }
}
