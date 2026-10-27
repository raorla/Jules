// Thèmes (DESIGN.md §3) : sombre par défaut, `.light` sur <html>. Au premier lancement, la préférence
// du système fait foi ; ensuite, le choix de l'utilisateur (gardé dans ce navigateur seulement).

export type Theme = "system" | "dark" | "light";
const KEY = "jules.theme";

export function currentTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "light" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = currentTheme()): void {
  const light =
    theme === "light" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.classList.toggle("light", light);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Stockage indisponible (navigation privée) : le thème vaut pour cette page seulement.
  }
  applyTheme(theme);
}
