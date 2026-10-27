// Masquage des secrets connus (ARCHITECTURE.md §4.3, §16), dans les deux sens du proxy modèle,
// dans les entrées d'outils journalisées et dans les logs. Défense en profondeur : aucun secret
// n'entre dans le sandbox, mais un secret d'un repo ou d'un serveur peut se trouver dans du texte.

const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bjrt_[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export const MASK = "[masqué]";

export class Masker {
  readonly #values: string[];

  constructor(knownSecrets: readonly string[] = []) {
    // Les plus longs d'abord : un secret qui en contient un autre est masqué en entier.
    this.#values = knownSecrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  }

  mask(text: string): string {
    let out = text;
    for (const value of this.#values) {
      out = out.split(value).join(MASK);
    }
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, MASK);
    }
    return out;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${text.length - max} caractères tronqués]`;
}
