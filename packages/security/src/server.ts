import type { FindingInput, Severity } from "./findings.js";

// Audit d'un serveur (ARCHITECTURE.md §7, `audit_server`) : un script fixe, relu, exécuté par le
// worker. Les fichiers de secrets ne sortent du serveur que sous forme de chemin, droits, propriétaire
// et NOMS de variables : le script n'imprime jamais une valeur, et le parseur rejette tout le reste.

export const SERVER_AUDIT_SCRIPT = String.raw`
for f in $(find /srv /opt /var/www /home /etc /root -maxdepth 4 -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa' -o -name 'id_ed25519' \) 2>/dev/null | head -n 200); do
  case "$f" in *.example|*.sample|*.template) continue ;; esac
  perms=$(stat -c '%a' "$f" 2>/dev/null)
  owner=$(stat -c '%U' "$f" 2>/dev/null)
  names=$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p' "$f" 2>/dev/null | head -n 50 | tr '\n' ',')
  printf 'FILE\t%s\t%s\t%s\t%s\n' "$f" "$perms" "$owner" "$names"
done
printf 'SSHD\t%s\n' "$(grep -Eih '^[[:space:]]*(PasswordAuthentication|PermitRootLogin)[[:space:]]+[a-z-]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tr -s ' \t' ' ' | tr '\n' ';')"
( ss -ltnH 2>/dev/null | awk '{print $4}' ; netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}' ) | sort -u | while read -r a; do printf 'PORT\t%s\n' "$a"; done
awk -F: '$3 == 0 {print $1}' /etc/passwd | while read -r u; do printf 'UID0\t%s\n' "$u"; done
printf 'UPDATES\t%s\n' "$( (apt list --upgradable 2>/dev/null | grep -c upgradable) || (apk version -l '<' 2>/dev/null | tail -n +2 | wc -l) || echo 0)"
docker ps -q 2>/dev/null | while read -r c; do docker inspect --format '{{.Name}}	{{.HostConfig.Privileged}}	{{.Config.User}}' "$c" 2>/dev/null | sed 's/^/CONTAINER\t/'; done
true
`;

/** Ce que l'agent voit d'un fichier de secrets : des noms et des états, jamais une valeur. */
export type SecretFileInventory = {
  readonly path: string;
  readonly permissions: string;
  readonly owner: string;
  readonly variables: readonly string[];
};

export type ServerAudit = { findings: FindingInput[]; inventory: SecretFileInventory[] };

const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]{1,300}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DB_PORTS = new Set(["5432", "3306", "6379", "27017", "9200", "11211"]);

export function parseServerAudit(serverId: string, output: string): ServerAudit {
  const findings: FindingInput[] = [];
  const inventory: SecretFileInventory[] = [];
  const add = (component: string, title: string, severity: Severity, evidence: string) =>
    findings.push({
      scope: "server",
      targetId: serverId,
      category: "server",
      component,
      title,
      severity,
      scanner: "server-audit",
      evidence,
    });
  let updates = 0;
  for (const line of output.split("\n")) {
    const [tag, ...fields] = line.split("\t");
    if (tag === "FILE") {
      const [path = "", perms = "", owner = "", names = ""] = fields;
      if (!SAFE_PATH.test(path) || !/^[0-7]{3,4}$/.test(perms)) {
        continue;
      }
      const variables = names.split(",").filter((n) => VAR_NAME.test(n));
      const ownerName = /^[a-z_][a-z0-9_-]{0,31}$/.test(owner) ? owner : "?";
      inventory.push({ path, permissions: perms, owner: ownerName, variables });
      const other = Number(perms.slice(-1));
      const group = Number(perms.slice(-2, -1));
      if (other >= 4) {
        add(
          path,
          "Fichier de secrets lisible par tous",
          "high",
          `droits ${perms}, propriétaire ${ownerName}`,
        );
      } else if ((group & 2) !== 0 || (other & 2) !== 0) {
        add(path, "Fichier de secrets modifiable par d'autres", "high", `droits ${perms}`);
      }
    } else if (tag === "SSHD") {
      const settings = (fields[0] ?? "").toLowerCase();
      if (/passwordauthentication yes/.test(settings)) {
        add(
          "sshd",
          "Connexion SSH par mot de passe autorisée",
          "medium",
          "PasswordAuthentication yes",
        );
      }
      if (/permitrootlogin yes/.test(settings)) {
        add("sshd", "Connexion SSH root autorisée", "high", "PermitRootLogin yes");
      }
    } else if (tag === "PORT") {
      const address = fields[0] ?? "";
      const port = address.slice(address.lastIndexOf(":") + 1);
      const exposed = /^(0\.0\.0\.0|\*|\[?::\]?):/.test(address);
      if (exposed && DB_PORTS.has(port)) {
        add(`port ${port}`, "Base de données exposée sur toutes les interfaces", "high", address);
      }
    } else if (tag === "UID0") {
      const user = fields[0] ?? "";
      if (user !== "root" && /^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
        add(`user ${user}`, "Autre compte que root avec l'UID 0", "critical", user);
      }
    } else if (tag === "UPDATES") {
      updates = Number.parseInt(fields[0] ?? "0", 10) || 0;
    } else if (tag === "CONTAINER") {
      const [name = "", privileged = "", user = ""] = fields;
      const container = name.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "");
      if (container === "") {
        continue;
      }
      if (privileged === "true") {
        add(`container ${container}`, "Conteneur privilégié", "high", "HostConfig.Privileged");
      } else if (user === "" || user === "root" || user === "0") {
        add(`container ${container}`, "Conteneur exécuté en root", "medium", "Config.User vide");
      }
    }
  }
  if (updates > 0) {
    add(
      "paquets",
      "Mises à jour en attente",
      updates > 50 ? "medium" : "low",
      `${updates} paquet(s)`,
    );
  }
  return { findings, inventory };
}

/** Résumé pour l'agent : « `DB_PASSWORD` : défini ». */
export function describeInventory(inventory: readonly SecretFileInventory[]): string {
  return inventory
    .map(
      (f) =>
        `${f.path} (droits ${f.permissions}, ${f.owner}) : ${
          f.variables.length > 0
            ? f.variables.map((v) => `\`${v}\` : défini`).join(", ")
            : "aucune variable lisible"
        }`,
    )
    .join("\n");
}
