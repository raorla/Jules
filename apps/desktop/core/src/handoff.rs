//! Remise des secrets au worker du mode local (ARCHITECTURE.md §4.7, §9). La clé maître vit dans le
//! trousseau du système ; au démarrage de la pile, l'app la remet une seule fois au worker, sur un
//! socket Unix monté dans son conteneur (Linux) ou une adresse de bouclage jointe par
//! `host.docker.internal` (Docker Desktop). Rien n'est écrit sur le disque : le jeton d'accès, qui peut
//! traîner dans la config du conteneur, ne sert qu'une fois, et le point d'accès disparaît ensuite.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

/// Après autant de jetons faux, le point d'accès se ferme : aucune nouvelle tentative.
pub const MAX_BAD_ATTEMPTS: u32 = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum HandoffError {
    Timeout,
    TooManyAttempts,
    Io(String),
}

impl fmt::Display for HandoffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => f.write_str("le worker n'a pas demandé ses secrets à temps"),
            Self::TooManyAttempts => f.write_str("trop de jetons faux : remise des secrets annulée"),
            Self::Io(e) => write!(f, "remise des secrets : {e}"),
        }
    }
}

/// Contenu remis : clé maître (base64) et, si la personne l'y a rangée, la clé API du fournisseur.
pub struct Secrets {
    pub master_key: String,
    pub previous_keys: Vec<String>,
    pub anthropic_api_key: Option<String>,
}

impl Drop for Secrets {
    fn drop(&mut self) {
        // Effacement de la mémoire, au mieux : les chaînes ne se recopient pas ailleurs ici.
        for value in std::iter::once(&mut self.master_key)
            .chain(self.previous_keys.iter_mut())
            .chain(self.anthropic_api_key.iter_mut())
        {
            // SAFETY : des zéros sont un UTF-8 valide.
            unsafe { value.as_bytes_mut().fill(0) };
        }
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Secrets {
    /// Le JSON attendu par le worker (apps/worker/src/local/handoff.ts).
    pub fn to_json(&self) -> String {
        let previous: Vec<String> = self.previous_keys.iter().map(|k| json_string(k)).collect();
        let mut json = format!(
            "{{\"masterKey\":{},\"previousKeys\":[{}]",
            json_string(&self.master_key),
            previous.join(",")
        );
        if let Some(key) = &self.anthropic_api_key {
            json.push_str(&format!(",\"anthropicApiKey\":{}", json_string(key)));
        }
        json.push('}');
        json
    }
}

/// Nouvelle clé maître : 32 octets aléatoires en base64, le format de `JULES_MASTER_KEY`.
pub fn random_master_key() -> String {
    use base64::Engine;
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("source d'aléa du système indisponible");
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    key.fill(0);
    encoded
}

/// Comparaison sans court-circuit.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Ce que la requête demande : la remise (jeton correct) ou rien.
pub fn authorized(request: &str, token: &str) -> bool {
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or_default();
    if !first.starts_with("POST /handoff ") {
        return false;
    }
    lines.take_while(|l| !l.is_empty()).any(|line| {
        let (name, value) = line.split_once(':').unwrap_or_default();
        name.trim().eq_ignore_ascii_case("authorization")
            && same(value.trim().as_bytes(), format!("Bearer {token}").as_bytes())
    })
}

/// Un point d'écoute : TCP sur l'adresse de bouclage, ou socket Unix.
pub trait Listener {
    type Stream: Read + Write;
    fn accept_stream(&self) -> std::io::Result<Self::Stream>;
    fn set_nonblocking(&self, nonblocking: bool) -> std::io::Result<()>;
}

impl Listener for std::net::TcpListener {
    type Stream = std::net::TcpStream;
    fn accept_stream(&self) -> std::io::Result<Self::Stream> {
        let (stream, _) = self.accept()?;
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        Ok(stream)
    }
    fn set_nonblocking(&self, nonblocking: bool) -> std::io::Result<()> {
        std::net::TcpListener::set_nonblocking(self, nonblocking)
    }
}

#[cfg(unix)]
impl Listener for std::os::unix::net::UnixListener {
    type Stream = std::os::unix::net::UnixStream;
    fn accept_stream(&self) -> std::io::Result<Self::Stream> {
        let (stream, _) = self.accept()?;
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        Ok(stream)
    }
    fn set_nonblocking(&self, nonblocking: bool) -> std::io::Result<()> {
        std::os::unix::net::UnixListener::set_nonblocking(self, nonblocking)
    }
}

fn respond(stream: &mut impl Write, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Sert les secrets une seule fois, puis rend la main. Le point d'écoute est fermé par l'appelant.
pub fn serve_once<L: Listener>(listener: &L, token: &str, secrets: &Secrets, timeout: Duration) -> Result<(), HandoffError> {
    listener.set_nonblocking(true).map_err(|e| HandoffError::Io(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    let mut bad = 0;
    loop {
        match listener.accept_stream() {
            Ok(mut stream) => {
                let mut buffer = [0u8; 8192];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                if authorized(&request, token) {
                    let mut body = secrets.to_json();
                    respond(&mut stream, "200 OK", &body);
                    // SAFETY : des zéros sont un UTF-8 valide.
                    unsafe { body.as_bytes_mut().fill(0) };
                    return Ok(());
                }
                respond(&mut stream, "401 Unauthorized", "{}");
                bad += 1;
                if bad >= MAX_BAD_ATTEMPTS {
                    return Err(HandoffError::TooManyAttempts);
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(HandoffError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(HandoffError::Io(error.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    fn secrets() -> Secrets {
        Secrets {
            master_key: "a2V5LWRlLXRlc3QtMzItb2N0ZXRzLXBvdXItamV1eA==".into(),
            previous_keys: vec![],
            anthropic_api_key: Some("sk-ant-\"test\"".into()),
        }
    }

    fn post(stream: &mut (impl Read + Write), token: &str) -> String {
        write!(stream, "POST /handoff HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\n\r\n").unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }

    #[test]
    fn master_keys_are_32_random_bytes() {
        use base64::Engine;
        let a = random_master_key();
        let decoded = base64::engine::general_purpose::STANDARD.decode(&a).unwrap();
        assert_eq!(decoded.len(), 32);
        assert_ne!(a, random_master_key());
    }

    #[test]
    fn json_matches_what_the_worker_expects() {
        assert_eq!(
            secrets().to_json(),
            r#"{"masterKey":"a2V5LWRlLXRlc3QtMzItb2N0ZXRzLXBvdXItamV1eA==","previousKeys":[],"anthropicApiKey":"sk-ant-\"test\""}"#
        );
    }

    #[test]
    fn only_a_post_with_the_right_token_is_authorized() {
        assert!(authorized("POST /handoff HTTP/1.1\r\nauthorization: Bearer t0k\r\n\r\n", "t0k"));
        assert!(!authorized("POST /handoff HTTP/1.1\r\nAuthorization: Bearer t0kX\r\n\r\n", "t0k"));
        assert!(!authorized("GET /handoff HTTP/1.1\r\nAuthorization: Bearer t0k\r\n\r\n", "t0k"));
        assert!(!authorized("POST /autre HTTP/1.1\r\nAuthorization: Bearer t0k\r\n\r\n", "t0k"));
        // Un en-tête après le corps ne compte pas.
        assert!(!authorized("POST /handoff HTTP/1.1\r\n\r\nAuthorization: Bearer t0k", "t0k"));
    }

    #[test]
    fn serves_once_over_tcp_then_closes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let result = serve_once(&listener, "jeton", &secrets(), Duration::from_secs(10));
            drop(listener);
            result
        });
        let refused = post(&mut TcpStream::connect(address).unwrap(), "faux");
        assert!(refused.starts_with("HTTP/1.1 401"));
        let served = post(&mut TcpStream::connect(address).unwrap(), "jeton");
        assert!(served.starts_with("HTTP/1.1 200"));
        assert!(served.ends_with(&secrets().to_json()));
        assert_eq!(server.join().unwrap(), Ok(()));
        // Plus personne n'écoute : une seconde demande échoue.
        assert!(TcpStream::connect(address).is_err());
    }

    #[test]
    fn closes_after_too_many_bad_tokens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || serve_once(&listener, "jeton", &secrets(), Duration::from_secs(10)));
        for _ in 0..MAX_BAD_ATTEMPTS {
            post(&mut TcpStream::connect(address).unwrap(), "faux");
        }
        assert_eq!(server.join().unwrap(), Err(HandoffError::TooManyAttempts));
    }

    #[test]
    fn gives_up_when_nobody_asks() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        assert_eq!(serve_once(&listener, "jeton", &secrets(), Duration::from_millis(100)), Err(HandoffError::Timeout));
    }

    #[cfg(unix)]
    #[test]
    fn serves_over_a_unix_socket() {
        use std::os::unix::net::{UnixListener, UnixStream};
        let dir = std::env::temp_dir().join(format!("jules-handoff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("handoff.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || serve_once(&listener, "jeton", &secrets(), Duration::from_secs(10)));
        let served = post(&mut UnixStream::connect(&path).unwrap(), "jeton");
        assert!(served.starts_with("HTTP/1.1 200"));
        assert_eq!(server.join().unwrap(), Ok(()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
