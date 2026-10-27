//! Texte des notifications natives (DESIGN.md §11) : court, et il nomme l'environnement.

pub fn approval_notification(environment: &str, server: &str) -> String {
    let mut chars = environment.chars();
    let env = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Environnement inconnu".to_string(),
    };
    format!("{env} · {server} : approbation demandée")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_environment() {
        assert_eq!(approval_notification("production", "app-prod"), "Production · app-prod : approbation demandée");
        assert_eq!(approval_notification("", "x"), "Environnement inconnu · x : approbation demandée");
    }
}
