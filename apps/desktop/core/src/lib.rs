//! Cœur du desktop Jules (ARCHITECTURE.md §4.7) : connexion OAuth avec PKCE sur une adresse de
//! bouclage (RFC 8252), compatibilité avec le serveur, vérification des mises à jour signées et
//! texte des notifications. Aucune dépendance à Tauri : tout se teste avec `cargo test`.

pub mod callback;
pub mod notify;
pub mod pkce;
pub mod update;
pub mod version;
