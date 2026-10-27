// Logo de Jules (apps/desktop/src-tauri/icons/logo.svg) : un J dont le haut est un nœud,
// l'orchestrateur, et trois points pour ses agents. Couleurs par rôles de tokens, jamais en hex.

export function JulesLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <rect width="1024" height="1024" rx="230" fill="var(--cream)" />
      <path
        d="M600 330 V600 a150 150 0 0 1 -300 0"
        fill="none"
        stroke="var(--on-cream)"
        strokeWidth="96"
        strokeLinecap="round"
      />
      <circle cx="600" cy="250" r="66" fill="var(--on-cream)" />
      <circle cx="735" cy="420" r="34" fill="var(--ink-3)" />
      <circle cx="735" cy="560" r="34" fill="var(--ink-3)" />
      <circle cx="735" cy="700" r="34" fill="var(--ok)" />
    </svg>
  );
}
