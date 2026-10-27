import type { FindingInput } from "./findings.js";

// Audit de la plateforme (`audit_platform`) : la config de Jules lui-même, métadonnées seulement.

export type PlatformSnapshot = {
  readonly orgId: string;
  readonly admins: readonly { id: string; hasPasskey: boolean }[];
  readonly fourEyes: boolean;
  readonly githubProductionApproval: boolean;
  readonly servers: readonly { id: string; name: string; hostKeyStatus: string }[];
  readonly deniedLast7Days: number;
};

export function platformFindings(s: PlatformSnapshot): FindingInput[] {
  const base = {
    scope: "platform" as const,
    targetId: s.orgId,
    category: "platform" as const,
    scanner: "platform-audit",
  };
  const out: FindingInput[] = [];
  for (const admin of s.admins.filter((a) => !a.hasPasskey)) {
    out.push({
      ...base,
      component: `admin ${admin.id}`,
      title: "Admin sans passkey",
      severity: "medium",
      evidence: "aucune passkey enregistrée : aucune action sensible possible, compte à sécuriser",
    });
  }
  if (s.githubProductionApproval) {
    out.push({
      ...base,
      component: "réglages",
      title: "Production approuvable depuis GitHub",
      severity: "medium",
      evidence: "un commentaire suffit, sans passkey",
    });
  }
  if (!s.fourEyes && s.admins.length >= 2) {
    out.push({
      ...base,
      component: "réglages",
      title: "Option quatre yeux désactivée",
      severity: "low",
      evidence: `${s.admins.length} admins`,
    });
  }
  for (const server of s.servers.filter((x) => x.hostKeyStatus === "changed")) {
    out.push({
      ...base,
      component: `serveur ${server.name}`,
      title: "Clé d'hôte changée non revalidée",
      severity: "high",
      evidence: server.id,
    });
  }
  if (s.deniedLast7Days > 20) {
    out.push({
      ...base,
      component: "politique",
      title: "Nombreux refus récents",
      severity: "low",
      evidence: `${s.deniedLast7Days} refus en 7 jours`,
    });
  }
  return out;
}
