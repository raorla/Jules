import type { CommandClass } from "@jules/policy";
import { parseShell, type Script, type SimpleCommand, type Word } from "./shell.js";

// Classification des commandes serveur (ARCHITECTURE.md §9) : `read`, `change` ou `dangerous`, sur
// l'arbre produit par le parseur shell. Une commande inconnue est au moins `change` ; une commande
// qui ne se parse pas ou qui est obfusquée est `dangerous`, même si quelqu'un voulait l'approuver.

export type { CommandClass };
export type Classification = { readonly class: CommandClass; readonly reasons: readonly string[] };
export type ClassifyOptions = {
  /** Étape d'un playbook relu : `shutdown` et `reboot` y deviennent de simples changements. */
  readonly inPlaybook?: boolean;
};

const RANK: Record<CommandClass, number> = { read: 0, change: 1, dangerous: 2 };

class Verdict {
  level: CommandClass = "read";
  readonly reasons: string[] = [];
  raise(level: CommandClass, reason: string): void {
    if (RANK[level] > RANK[this.level]) {
      this.level = level;
    }
    if (level !== "read") {
      this.reasons.push(reason);
    }
  }
}

const READ_COMMANDS = new Set([
  "ls",
  "pwd",
  "whoami",
  "id",
  "groups",
  "hostname",
  "uname",
  "uptime",
  "date",
  "df",
  "du",
  "free",
  "ps",
  "pgrep",
  "top",
  "htop",
  "vmstat",
  "iostat",
  "mpstat",
  "sar",
  "lsblk",
  "lscpu",
  "lsof",
  "lsmod",
  "lspci",
  "lsusb",
  "blkid",
  "findmnt",
  "ss",
  "netstat",
  "ping",
  "traceroute",
  "tracepath",
  "dig",
  "nslookup",
  "host",
  "getent",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "jq",
  "diff",
  "cmp",
  "file",
  "stat",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "sleep",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "strings",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "zcat",
  "zgrep",
  "last",
  "lastlog",
  "w",
  "who",
  "nproc",
  "arch",
  "cd",
  "alias",
  "apt-cache",
  "loginctl",
  "lsattr",
  ":",
]);

/** Commandes dont la sortie expose l'environnement, donc des secrets. */
const ENV_DUMPS = new Set(["printenv"]);
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "ash",
  "fish",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "node",
  "nodejs",
  "php",
  "lua",
  "tclsh",
  "deno",
  "bun",
]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"]);
const DISK_TOOLS = new Set([
  "mkfs",
  "mke2fs",
  "mkswap",
  "fdisk",
  "sfdisk",
  "gdisk",
  "sgdisk",
  "parted",
  "wipefs",
  "blkdiscard",
  "pvremove",
  "vgremove",
  "lvremove",
]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "telinit"]);
const LOG_UNITS = /^(rsyslog|syslog|syslog-ng|systemd-journald|journald|auditd)(\.service)?$/;
const PACKAGE_MANAGERS = new Set([
  "apt",
  "apt-get",
  "aptitude",
  "dnf",
  "yum",
  "apk",
  "zypper",
  "snap",
  "pip",
  "pip3",
  "npm",
  "pnpm",
  "yarn",
  "gem",
  "dpkg",
  "rpm",
  "brew",
]);
const PACKAGE_READ = new Set([
  "list",
  "show",
  "search",
  "policy",
  "info",
  "--version",
  "-l",
  "-L",
  "-s",
  "-q",
  "-qa",
  "-qi",
  "-ql",
  "outdated",
  "ls",
  "view",
  "freeze",
  "check",
]);

/** Une copie ou une lecture de ces fichiers expose un secret (§9). */
export function isSensitivePath(raw: string): boolean {
  // `@.env` (curl), `if=/root/.ssh/id_rsa` (dd), `--file=.env` : le chemin est après le préfixe.
  const path = raw
    .replace(/^@/, "")
    .replace(/^-{0,2}[A-Za-z][A-Za-z-]*=/, "")
    .replace(/^@/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) {
    return true;
  }
  if (
    /\.(pem|key|p12|pfx|kdbx|keystore|jks)$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base) ||
    /^ssh_host_.+_key$/.test(base)
  ) {
    return true;
  }
  if (
    /^(\.netrc|\.pgpass|\.git-credentials|credentials|credentials\.json|\.htpasswd)$/.test(base)
  ) {
    return true;
  }
  return (
    /(^|\/)\/?etc\/g?shadow$/.test(path) ||
    /(^|\/)\.ssh\/(?!known_hosts$|authorized_keys$|[^/]+\.pub$|config$)/.test(path) ||
    /(^|\/)\.(aws|docker|kube)\/(credentials|config\.json|config)$/.test(path) ||
    /^\/run\/secrets(\/|$)/.test(path) ||
    /^\/proc\/[^/]+\/environ$/.test(path)
  );
}

/** Commandes qui peuvent toucher un fichier sensible sans en lire le contenu. */
const METADATA_ONLY = new Set(["ls", "stat", "test", "[", "chmod", "chown", "touch", "file", "du"]);

const BROAD_ROOTS = new Set([
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib32",
  "lib64",
  "opt",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "usr",
  "var",
  "mnt",
  "media",
]);

/** Chemin large : la racine, un répertoire système de premier niveau, le home, `.`, `*`. */
export function isBroadPath(word: Word): boolean {
  if (word.expansion || word.substitutions.length > 0) {
    return true;
  }
  // `/var/*` et `/var/` valent `/var` ; `/*` vaut `/`.
  const path = word.text.replace(/\/\*$/, "/").replace(/(.)\/+$/, "$1");
  if (["/", "~", ".", "..", "*"].includes(path)) {
    return true;
  }
  const parts = path.split("/").filter(Boolean);
  return path.startsWith("/") && parts.length === 1 && BROAD_ROOTS.has(parts.join(""));
}

const isDevice = (text: string) =>
  /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|mapper\/|disk\/|md|loop|dm-)/.test(text);
const isLog = (text: string) => /^\/var\/log(\/|$)/.test(text);
const flagSet = (args: readonly string[]) =>
  args.filter((a) => a.startsWith("-") && !a.startsWith("--")).join("");
/** Retire les commandes enveloppes (sudo, env, timeout…) et renvoie la commande réelle. */
function unwrap(words: readonly Word[], verdict: Verdict): readonly Word[] {
  let rest = words;
  for (;;) {
    const name = rest[0] ? baseName(rest[0].text) : "";
    let skip = 0;
    const at = (k: number) => rest[k]?.text ?? "";
    if (name === "sudo" || name === "doas") {
      skip = 1;
      while (at(skip).startsWith("-")) {
        skip += ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U"].includes(at(skip)) ? 2 : 1;
      }
      const flags = rest.slice(1, skip).map((w) => w.text);
      if (rest.length <= skip && (flags.includes("-i") || flags.includes("-s"))) {
        verdict.raise("dangerous", "shell root interactif");
      }
    } else if (name === "env") {
      skip = 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(at(skip)) || at(skip).startsWith("-")) {
        skip += ["-u", "--unset", "-C", "--chdir"].includes(at(skip)) ? 2 : 1;
      }
      if (rest.length <= skip) {
        verdict.raise("dangerous", "affiche l'environnement, donc des secrets");
      }
    } else if (name === "timeout") {
      skip = 1;
      while (at(skip).startsWith("-")) {
        skip += ["-s", "--signal", "-k", "--kill-after"].includes(at(skip)) ? 2 : 1;
      }
      skip += 1;
    } else if (name === "nice" || name === "ionice") {
      skip = 1;
      while (at(skip).startsWith("-")) {
        skip += ["-n", "-c"].includes(at(skip)) ? 2 : 1;
      }
    } else if (["nohup", "time", "command", "exec", "stdbuf", "chrt", "setsid"].includes(name)) {
      skip = 1;
      while (at(skip).startsWith("-")) {
        skip += 1;
      }
    }
    if (skip === 0 || rest.length <= skip) {
      return skip === 0 ? rest : [];
    }
    rest = rest.slice(skip);
  }
}

const baseName = (text: string) => text.slice(text.lastIndexOf("/") + 1);

function classifyWords(
  words: readonly Word[],
  verdict: Verdict,
  options: ClassifyOptions,
  depth: number,
): void {
  const real = unwrap(words, verdict);
  const first = real[0];
  if (!first) {
    return;
  }
  if (first.expansion || first.substitutions.length > 0) {
    verdict.raise("dangerous", "nom de commande calculé à l'exécution (obfuscation)");
    return;
  }
  const name = baseName(first.text);
  const argWords = real.slice(1);
  const args = argWords.map((w) => w.text);

  if (!METADATA_ONLY.has(name) && args.some(isSensitivePath)) {
    verdict.raise("dangerous", "lit ou copie un fichier sensible (.env, clé, identifiants)");
  }

  if (INTERPRETERS.has(name)) {
    // Code en ligne : `-c` (et `-ec`, `-lc`…) pour un shell, `-c` ou `-e` pour les autres langages.
    const c = args.findIndex((a) =>
      SHELLS.has(name) ? /^-[a-zA-Z]*c$/.test(a) : a === "-c" || a === "-e" || a === "-E",
    );
    if (c >= 0) {
      const code = argWords[c + 1];
      if (!code || code.expansion || code.substitutions.length > 0) {
        verdict.raise("dangerous", "code calculé exécuté par un interpréteur");
      } else if (SHELLS.has(name)) {
        classifyText(code.text, verdict, options, depth + 1);
      } else {
        verdict.raise("change", `code ${name} exécuté en ligne`);
      }
      return;
    }
    const script = argWords.find((w) => w.text === "-" || !w.text.startsWith("-"));
    if (
      script &&
      (script.substitutions.length > 0 || /^(\/dev\/stdin|-|https?:)/.test(script.text))
    ) {
      verdict.raise("dangerous", "exécute du code téléchargé ou reçu en flux");
    } else {
      verdict.raise("change", `script ${name} exécuté`);
    }
    return;
  }

  const rule = RULES[name];
  if (rule) {
    rule(args, argWords, verdict, options, depth);
  } else if (READ_COMMANDS.has(name)) {
    verdict.raise("read", "");
  } else if (ENV_DUMPS.has(name)) {
    verdict.raise("dangerous", "affiche l'environnement, donc des secrets");
  } else if (DISK_TOOLS.has(name) || name.startsWith("mkfs.")) {
    verdict.raise("dangerous", `${name} : formatage ou effacement de disque`);
  } else if (POWER.has(name)) {
    verdict.raise(options.inPlaybook ? "change" : "dangerous", `${name} hors playbook`);
  } else if (PACKAGE_MANAGERS.has(name)) {
    const sub = args.find((a) => !a.startsWith("-") || PACKAGE_READ.has(a));
    verdict.raise(
      sub !== undefined && PACKAGE_READ.has(sub) ? "read" : "change",
      `${name} ${sub ?? ""}`.trim(),
    );
  } else {
    verdict.raise("change", `commande inconnue (${name}) : classée change au minimum`);
  }
}

type Rule = (
  args: readonly string[],
  words: readonly Word[],
  v: Verdict,
  o: ClassifyOptions,
  depth: number,
) => void;

const subcommand = (args: readonly string[]) => args.find((a) => !a.startsWith("-"));

const sourceRule: Rule = (_a, words, v) => {
  const target = words[0];
  v.raise(
    !target || target.substitutions.length > 0 || /^(\/dev\/stdin|-)$/.test(target.text)
      ? "dangerous"
      : "change",
    "source exécute un script dans le shell courant",
  );
};

const RULES: Record<string, Rule> = {
  eval: (_a, _w, v) => {
    v.raise("dangerous", "eval exécute du texte calculé");
  },
  source: sourceRule,
  ".": sourceRule,
  set: (args, _w, v) => {
    if (args.length === 0) {
      v.raise("dangerous", "set sans argument affiche les variables, donc des secrets");
    }
  },
  export: (args, _w, v) => {
    if (args.length === 0 || args.includes("-p")) {
      v.raise("dangerous", "export sans argument affiche les variables, donc des secrets");
    }
  },
  unset: (args, _w, v) => {
    if (args.some((a) => /^HIST/.test(a))) {
      v.raise("dangerous", "désactive l'historique des commandes");
    }
  },
  history: (args, _w, v) => {
    if (args.some((a) => /^-[a-z]*[cdw]/.test(a))) {
      v.raise("dangerous", "efface ou réécrit l'historique");
    }
  },
  rm: (args, words, v) => {
    const recursive = /[rR]/.test(flagSet(args)) || args.includes("--recursive");
    const targets = words.filter((w) => !w.text.startsWith("-"));
    if (args.includes("--no-preserve-root")) {
      v.raise("dangerous", "rm --no-preserve-root");
    } else if (recursive && targets.some(isBroadPath)) {
      v.raise("dangerous", "rm récursif sur un chemin large");
    } else if (targets.some((w) => isLog(w.text))) {
      v.raise("dangerous", "supprime des journaux");
    } else {
      v.raise("change", "suppression de fichiers");
    }
  },
  shred: (args, _w, v) => {
    v.raise(args.some((a) => isLog(a) || isDevice(a)) ? "dangerous" : "change", "shred");
  },
  truncate: (args, _w, v) => {
    v.raise(args.some(isLog) ? "dangerous" : "change", "truncate");
  },
  dd: (args, _w, v) => {
    v.raise(
      args.some((a) => a.startsWith("of=") && isDevice(a.slice(3))) ? "dangerous" : "change",
      "dd vers un disque",
    );
  },
  cryptsetup: (args, _w, v) => {
    v.raise(
      args.some((a) => /^(luksFormat|erase|luksErase)$/.test(a)) ? "dangerous" : "change",
      "cryptsetup",
    );
  },
  init: (args, _w, v, o) => {
    v.raise(
      args.some((a) => a === "0" || a === "6") && !o.inPlaybook ? "dangerous" : "change",
      "init : arrêt ou redémarrage",
    );
  },
  systemctl: (args, _w, v, o) => {
    const sub = subcommand(args) ?? "list-units";
    const units = args.filter((a) => !a.startsWith("-")).slice(1);
    if (
      /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|show|cat)$/.test(
        sub,
      )
    ) {
      v.raise("read", "");
    } else if (
      /^(poweroff|reboot|halt|kexec|suspend|hibernate|rescue|emergency|isolate|default)$/.test(sub)
    ) {
      v.raise(o.inPlaybook ? "change" : "dangerous", `systemctl ${sub} hors playbook`);
    } else if (/^(stop|disable|mask|kill)$/.test(sub) && units.some((u) => LOG_UNITS.test(u))) {
      v.raise("dangerous", "arrête les journaux ou l'audit");
    } else {
      v.raise("change", `systemctl ${sub}`);
    }
  },
  service: (args, _w, v) => {
    const [unit, action] = args;
    if (action === "status" || action === undefined) {
      v.raise("read", "");
    } else if (/^(stop|disable)$/.test(action) && unit !== undefined && LOG_UNITS.test(unit)) {
      v.raise("dangerous", "arrête les journaux ou l'audit");
    } else {
      v.raise("change", `service ${action}`);
    }
  },
  journalctl: (args, _w, v) => {
    if (args.some((a) => /^--(vacuum-|rotate|flush|relinquish-var)/.test(a))) {
      v.raise("dangerous", "efface ou déplace les journaux");
    }
  },
  dmesg: (args, _w, v) => {
    if (args.some((a) => /^-[a-zA-Z]*[cC]|^--(clear|read-clear)/.test(a))) {
      v.raise("dangerous", "efface le tampon du noyau");
    }
  },
  auditctl: (args, _w, v) => {
    if (args.includes("-D") || args.join(" ").includes("-e 0")) {
      v.raise("dangerous", "désactive l'audit");
    } else if (!args.every((a) => a === "-l" || a === "-s")) {
      v.raise("change", "auditctl");
    }
  },
  iptables: (...a) => {
    ipTables(...a);
  },
  ip6tables: (...a) => {
    ipTables(...a);
  },
  "iptables-save": (_a, _w, v) => {
    v.raise("read", "");
  },
  nft: (args, _w, v) => {
    const text = args.join(" ");
    v.raise(
      /flush ruleset|delete table/.test(text)
        ? "dangerous"
        : /^list/.test(text)
          ? "read"
          : "change",
      "nft",
    );
  },
  ufw: (args, _w, v) => {
    const sub = subcommand(args);
    v.raise(
      sub === "disable" || sub === "reset" ? "dangerous" : sub === "status" ? "read" : "change",
      `ufw ${sub ?? ""}`,
    );
  },
  chmod: (args, words, v) => {
    const recursive = /R/.test(flagSet(args)) || args.includes("--recursive");
    const mode = args.find((a) => !a.startsWith("-")) ?? "";
    const worldWritable =
      /^0?[0-7]?[0-7][0-7][2367]$/.test(mode) || /(^|,)[ugoa]*[oa][ugoa]*[+=][rwxXst]*w/.test(mode);
    const targets = words.filter((w) => !w.text.startsWith("-")).slice(1);
    v.raise(
      recursive && (worldWritable || targets.some(isBroadPath)) ? "dangerous" : "change",
      recursive ? "chmod -R permissif ou sur un chemin large" : "chmod",
    );
  },
  chown: (args, words, v) => {
    const recursive = /R/.test(flagSet(args)) || args.includes("--recursive");
    const targets = words.filter((w) => !w.text.startsWith("-")).slice(1);
    v.raise(recursive && targets.some(isBroadPath) ? "dangerous" : "change", "chown");
  },
  kill: (args, _w, v) => {
    v.raise(args.includes("1") || args.includes("-1") ? "dangerous" : "change", "kill");
  },
  find: (args, words, v, o, depth) => {
    const exec = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    const destructive = exec >= 0 || args.includes("-delete");
    const start = words.find((w) => !w.text.startsWith("-"));
    if (destructive && start !== undefined && isBroadPath(start)) {
      v.raise("dangerous", "find destructif sur un chemin large");
    } else if (destructive) {
      v.raise("change", "find -delete ou -exec");
    }
    if (exec >= 0) {
      const end = words.findIndex((w, i) => i > exec && (w.text === ";" || w.text === "+"));
      classifyWords(words.slice(exec + 1, end < 0 ? undefined : end), v, o, depth);
    }
  },
  xargs: (_args, words, v, o, depth) => {
    const command = words.findIndex((w) => !w.text.startsWith("-"));
    if (command >= 0) {
      classifyWords(words.slice(command), v, o, depth);
      v.raise("change", "xargs applique une commande à une liste");
    }
  },
  sed: (args, _w, v) => {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
      v.raise("change", "sed -i modifie un fichier");
    }
  },
  awk: awkRule,
  gawk: awkRule,
  tee: (args, _w, v) => {
    const targets = args.filter((a) => !a.startsWith("-"));
    if (targets.some(isDevice)) {
      v.raise("dangerous", "écrit sur un disque");
    } else if (targets.some((t) => t !== "/dev/null")) {
      v.raise("change", "tee écrit un fichier");
    }
  },
  curl: (args, _w, v) => {
    const writes = args.some(
      (a) => /^-[a-zA-Z]*[oO]$/.test(a) || /^--(output|remote-name)/.test(a),
    );
    const sends =
      args.some((a) => /^-(d|F|T)$/.test(a) || /^--(data|form|upload-file|json)/.test(a)) ||
      args.some(
        (a, i) =>
          (a === "-X" || a === "--request") && /^(POST|PUT|DELETE|PATCH)$/i.test(args[i + 1] ?? ""),
      );
    if (writes || sends) {
      v.raise("change", writes ? "curl écrit un fichier" : "curl envoie des données");
    }
  },
  wget: (args, _w, v) => {
    const toStdout = args.some(
      (a, i) => (/^-[a-zA-Z]*O$/.test(a) && args[i + 1] === "-") || /^-[a-zA-Z]*O-$/.test(a),
    );
    const spider = args.includes("--spider");
    if (!toStdout && !spider) {
      v.raise("change", "wget enregistre un fichier");
    }
  },
  git: (args, _w, v) => {
    // Options globales avant la sous-commande : `-C <chemin>`, `-c <clé=valeur>`, `--git-dir=…`.
    let k = 0;
    for (; k < args.length; k += 1) {
      const arg = args[k] as string;
      if (!arg.startsWith("-")) {
        break;
      }
      if (arg === "-C" || arg === "-c") {
        k += 1;
      }
    }
    const sub = args[k] ?? "";
    if (sub === "credential") {
      v.raise("dangerous", "git credential expose des identifiants");
    } else if (
      sub === "remote" &&
      args.some((a) => /^(add|remove|rm|rename|set-url|set-head|prune)$/.test(a))
    ) {
      v.raise("change", "git remote modifié");
    } else if (
      /^(status|log|diff|show|rev-parse|describe|ls-files|blame|shortlog|reflog|remote|ls-remote|cat-file|grep)$/.test(
        sub,
      )
    ) {
      v.raise("read", "");
    } else if (
      sub === "branch" &&
      !args.some((a) => /^-[dDmMcC]$/.test(a) || /^--(delete|move|copy)/.test(a))
    ) {
      v.raise("read", "");
    } else if (sub === "config" && args.some((a) => /^--(get|list|get-all)$|^-l$/.test(a))) {
      v.raise("read", "");
    } else {
      v.raise("change", `git ${sub}`);
    }
  },
  docker: containerRule,
  podman: containerRule,
  kubectl: (args, _w, v) => {
    const sub = subcommand(args) ?? "";
    if (sub === "config" && args.includes("--raw")) {
      v.raise("dangerous", "kubectl config --raw expose des identifiants");
    } else if (
      /^(get|describe|logs|top|version|cluster-info|explain|api-resources|api-versions|config|auth)$/.test(
        sub,
      )
    ) {
      v.raise("read", "");
    } else {
      v.raise("change", `kubectl ${sub}`);
    }
  },
  nc: netcatRule,
  ncat: netcatRule,
  netcat: netcatRule,
  socat: (args, _w, v) => {
    v.raise(args.some((a) => /exec:|system:/i.test(a)) ? "dangerous" : "change", "socat");
  },
  su: (args, words, v, o, depth) => {
    const c = args.indexOf("-c");
    const code = words[c + 1];
    if (c < 0 || !code) {
      v.raise("dangerous", "su ouvre un shell interactif");
    } else {
      classifyText(code.text, v, o, depth + 1);
    }
  },
  crontab: (args, _w, v) => {
    if (!args.includes("-l")) {
      v.raise("change", "crontab modifiée");
    }
  },
  ip: (args, _w, v) => {
    if (args.some((a) => /^(add|del|delete|set|flush|change|replace|append)$/.test(a))) {
      v.raise("change", "ip modifie le réseau");
    }
  },
  mount: (args, _w, v) => {
    if (args.some((a) => !a.startsWith("-"))) {
      v.raise("change", "mount");
    }
  },
  sysctl: (args, _w, v) => {
    if (args.includes("-w") || args.some((a) => a.includes("=")) || args.includes("-p")) {
      v.raise("change", "sysctl modifie le noyau");
    }
  },
  timedatectl: setterRule("timedatectl"),
  hostnamectl: setterRule("hostnamectl"),
  openssl: (args, _w, v) => {
    if (args.some((a) => /^(genrsa|genpkey|req|enc|ca|rsa|pkcs12)$/.test(a))) {
      v.raise("change", "openssl crée ou transforme une clé");
    }
  },
};

const ipTables: Rule = (args, words, v, o, depth) => {
  firewall(
    /^(-F|--flush|-X|--delete-chain)$/,
    /^(-L|--list|-S|--list-rules|-nL|-nvL|-vnL)$/,
    (list) => list.includes("-P") && list.includes("ACCEPT"),
  )(args, words, v, o, depth);
};

function firewall(
  flush: RegExp,
  list: RegExp,
  openPolicy: (args: readonly string[]) => boolean,
): Rule {
  return (args, _w, v) => {
    if (args.some((a) => flush.test(a)) || openPolicy(args)) {
      v.raise("dangerous", "vide ou ouvre le pare-feu");
    } else if (!args.some((a) => list.test(a))) {
      v.raise("change", "règle de pare-feu");
    }
  };
}

function awkRule(args: readonly string[], _w: readonly Word[], v: Verdict): void {
  if (args.some((a) => /system\s*\(|\|\s*getline|print[^;]*>/.test(a)) || args.includes("-i")) {
    v.raise("change", "awk exécute ou écrit");
  }
}

function netcatRule(args: readonly string[], _w: readonly Word[], v: Verdict): void {
  v.raise(args.some((a) => /^-[a-zA-Z]*[ec]$/.test(a)) ? "dangerous" : "change", "netcat");
}

function setterRule(name: string): Rule {
  return (args, _w, v) => {
    const sub = subcommand(args);
    if (sub !== undefined && sub !== "status" && sub !== "show") {
      v.raise("change", `${name} ${sub}`);
    }
  };
}

function containerRule(args: readonly string[], _w: readonly Word[], v: Verdict): void {
  const positional = args.filter((a) => !a.startsWith("-"));
  const [sub = "", second = ""] = positional;
  const reads = /^(ps|images|logs|inspect|stats|top|version|info|port|diff|history|events|search)$/;
  if (sub === "run" || sub === "create") {
    const hostAccess =
      args.some((a) => /^--privileged|^--pid=host|^--(cap-add=ALL|cap-add=SYS_ADMIN)/.test(a)) ||
      args.some((a, i) => (a === "-v" || a === "--volume") && /^\/(:|$)/.test(args[i + 1] ?? "")) ||
      args.some((a) => /^(-v|--volume=)\/:/.test(a));
    v.raise(
      hostAccess ? "dangerous" : "change",
      hostAccess ? "conteneur avec accès à l'hôte" : `${sub} d'un conteneur`,
    );
  } else if (reads.test(sub)) {
    v.raise("read", "");
  } else if (
    /^(compose|container|image|network|volume|system|buildx)$/.test(sub) &&
    /^(ps|ls|logs|config|images|top|version|inspect|df|events)$/.test(second)
  ) {
    v.raise("read", "");
  } else {
    v.raise("change", `${sub} ${second}`.trim());
  }
}

function classifyCommand(
  command: SimpleCommand,
  verdict: Verdict,
  options: ClassifyOptions,
  depth: number,
): void {
  if (command.subshell) {
    classifyScript(command.subshell, verdict, options, depth);
  }
  for (const word of command.words) {
    for (const sub of word.substitutions) {
      classifyScript(sub, verdict, options, depth);
    }
  }
  for (const redirect of command.redirects) {
    const target = redirect.target;
    for (const sub of target.substitutions) {
      classifyScript(sub, verdict, options, depth);
    }
    if (redirect.op === "<" || redirect.op === "<&" || redirect.op === "<<<") {
      if (redirect.op === "<" && isSensitivePath(target.text)) {
        verdict.raise("dangerous", "lit un fichier sensible");
      }
      continue;
    }
    if (redirect.op === ">&" && /^\d+$|^-$/.test(target.text)) {
      continue;
    }
    if (/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(target.text)) {
      continue;
    }
    if (isDevice(target.text)) {
      verdict.raise("dangerous", "écrit directement sur un disque");
    } else if (isLog(target.text)) {
      verdict.raise("dangerous", "écrase des journaux");
    } else if (/(authorized_keys|\/etc\/(sudoers|shadow|passwd)(\.d\/.*)?)$/.test(target.text)) {
      verdict.raise("dangerous", "réécrit un fichier d'accès ou de privilèges");
    } else {
      verdict.raise("change", "redirection vers un fichier");
    }
  }
  classifyWords(command.words, verdict, options, depth);
}

function classifyScript(
  script: Script,
  verdict: Verdict,
  options: ClassifyOptions,
  depth: number,
): void {
  for (const pipeline of script.pipelines) {
    pipeline.commands.forEach((command, index) => {
      if (index > 0) {
        const real = unwrap(command.words, new Verdict());
        const name = real[0] ? baseName(real[0].text) : "";
        const viaXargs =
          name === "xargs" && real.slice(1).some((w) => INTERPRETERS.has(baseName(w.text)));
        if (INTERPRETERS.has(name) || viaXargs || name === "source" || name === ".") {
          verdict.raise("dangerous", "exécute du code reçu par un pipe (… | sh)");
        }
      }
      classifyCommand(command, verdict, options, depth);
    });
  }
}

function classifyText(
  text: string,
  verdict: Verdict,
  options: ClassifyOptions,
  depth: number,
): void {
  if (depth > 2) {
    verdict.raise("dangerous", "shells imbriqués");
    return;
  }
  classifyScript(parseShell(text), verdict, options, depth);
}

/** Classe une commande serveur. Ne lève jamais : une erreur d'analyse donne `dangerous`. */
export function classify(command: string, options: ClassifyOptions = {}): Classification {
  const verdict = new Verdict();
  if (command.trim() === "") {
    return { class: "dangerous", reasons: ["commande vide"] };
  }
  try {
    classifyText(command, verdict, options, 0);
  } catch (error) {
    return { class: "dangerous", reasons: [`ne se parse pas : ${(error as Error).message}`] };
  }
  return { class: verdict.level, reasons: [...new Set(verdict.reasons)] };
}
