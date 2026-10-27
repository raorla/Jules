import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };

// Langues de l'interface (DESIGN.md §10), indépendantes de celle des agents (`language` du repo).
export function initI18n(language?: string) {
  const preferred = language ?? (navigator.language.startsWith("fr") ? "fr" : "en");
  void i18n.use(initReactI18next).init({
    resources: { fr: { translation: fr }, en: { translation: en } },
    lng: preferred,
    fallbackLng: "fr",
    // React échappe déjà tout ce qu'il affiche.
    interpolation: { escapeValue: false },
  });
  return i18n;
}
