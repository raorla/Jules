//! Cœur du desktop Jules (ARCHITECTURE.md §4.7) : connexion OAuth avec PKCE sur une adresse de
//! bouclage (RFC 8252), compatibilité avec le serveur, vérification des mises à jour signées et
//! texte des notifications ; et, pour le mode local (M10), le moteur de conteneurs, la pile et la
//! remise des secrets au worker ; enfin la confirmation des actions sensibles (navigateur du système,
//! ou signature du trousseau en mode local). Aucune dépendance à Tauri : tout se teste avec `cargo test`.

pub mod callback;
pub mod engine;
pub mod handoff;
pub mod local;
pub mod notify;
pub mod pkce;
pub mod stack;
pub mod stepup;
pub mod update;
pub mod version;
