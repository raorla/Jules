// Analyse d'une commande shell (ARCHITECTURE.md §9) : un vrai découpage en mots, opérateurs,
// redirections et substitutions, jamais des expressions régulières sur le texte brut. Ce qui sort
// du sous-ensemble compris ici (structures de contrôle, here-documents, substitutions imbriquées)
// lève une erreur : la classification la traite comme `dangerous`.

export type Word = {
  /** Texte du mot, guillemets retirés ; une expansion laisse sa forme d'origine (`$HOME`). */
  readonly text: string;
  /** Le mot contient une variable ou une expansion : sa valeur n'est connue qu'à l'exécution. */
  readonly expansion: boolean;
  /** Substitutions de commande (`$(…)`, `` `…` ``, `<(…)`) contenues dans le mot. */
  readonly substitutions: readonly Script[];
};

export type RedirectOp = ">" | ">>" | ">|" | "&>" | "&>>" | "<" | "<<<" | ">&" | "<&";
export type Redirect = { readonly op: RedirectOp; readonly target: Word };

export type SimpleCommand = {
  readonly assignments: readonly string[];
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  /** Sous-shell `( … )` à la place d'une commande. */
  readonly subshell?: Script;
};

export type Pipeline = { readonly commands: readonly SimpleCommand[] };
export type Script = { readonly pipelines: readonly Pipeline[] };

export class ShellParseError extends Error {}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
]);
const OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")"]);
const MAX_DEPTH = 1;

type Token =
  { kind: "word"; word: Word } | { kind: "op"; op: string } | { kind: "subshell"; script: Script };

/** Fin d'un bloc parenthésé qui commence juste après `start` (la parenthèse ouvrante). */
function closingParen(input: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < input.length) {
    const c = input[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // Une parenthèse entre guillemets ne compte pas.
      let end = input.indexOf(c, i + 1);
      while (c === '"' && end > 0 && input[end - 1] === "\\") {
        end = input.indexOf(c, end + 1);
      }
      if (end < 0) {
        break;
      }
      i = end + 1;
      continue;
    }
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }
  throw new ShellParseError("parenthèse non fermée");
}

function tokenize(input: string, depth: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let text = "";
  let started = false;
  let expansion = false;
  let substitutions: Script[] = [];

  const flush = () => {
    if (started) {
      tokens.push({ kind: "word", word: { text, expansion, substitutions } });
    }
    text = "";
    started = false;
    expansion = false;
    substitutions = [];
  };
  const substitute = (body: string) => {
    if (depth >= MAX_DEPTH) {
      throw new ShellParseError("substitutions imbriquées");
    }
    substitutions.push(parseShell(body, depth + 1));
  };
  /** `$…` à la position `i` (sur le `$`) : renvoie la position qui suit l'expansion. */
  const dollar = (at: number): number => {
    const next = input[at + 1];
    if (next === "(") {
      if (input[at + 2] === "(") {
        const end = closingParen(input, at + 3);
        if (input[end + 1] !== ")") {
          throw new ShellParseError("expression arithmétique mal fermée");
        }
        expansion = true;
        text += input.slice(at, end + 2);
        return end + 2;
      }
      const end = closingParen(input, at + 2);
      substitute(input.slice(at + 2, end));
      text += input.slice(at, end + 1);
      return end + 1;
    }
    if (next === "{") {
      const end = input.indexOf("}", at + 2);
      if (end < 0) {
        throw new ShellParseError("expansion ${…} non fermée");
      }
      expansion = true;
      text += input.slice(at, end + 1);
      return end + 1;
    }
    if (next === "'") {
      // Chaîne ANSI-C ($'\x72\x6d') : un moyen classique de masquer une commande.
      const end = input.indexOf("'", at + 2);
      if (end < 0) {
        throw new ShellParseError("chaîne $'…' non fermée");
      }
      expansion = true;
      text += input.slice(at, end + 1);
      return end + 1;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(input.slice(at + 1));
    if (!name) {
      text += "$";
      return at + 1;
    }
    expansion = true;
    text += `$${name[0]}`;
    return at + 1 + name[0].length;
  };
  const backtick = (at: number): number => {
    const end = input.indexOf("`", at + 1);
    if (end < 0) {
      throw new ShellParseError("substitution `…` non fermée");
    }
    substitute(input.slice(at + 1, end));
    text += input.slice(at, end + 1);
    return end + 1;
  };

  while (i < input.length) {
    const c = input.charAt(i);
    if (c === " " || c === "\t") {
      flush();
      i += 1;
    } else if (c === "\n") {
      flush();
      tokens.push({ kind: "op", op: "\n" });
      i += 1;
    } else if (c === "#" && !started) {
      const end = input.indexOf("\n", i);
      i = end < 0 ? input.length : end;
    } else if (c === "\\") {
      if (i + 1 >= input.length) {
        throw new ShellParseError("barre oblique inverse finale");
      }
      started = true;
      if (input[i + 1] !== "\n") {
        text += input.charAt(i + 1);
      }
      i += 2;
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) {
        throw new ShellParseError("guillemet simple non fermé");
      }
      started = true;
      text += input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      started = true;
      i += 1;
      for (;;) {
        if (i >= input.length) {
          throw new ShellParseError("guillemet double non fermé");
        }
        const d = input.charAt(i);
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === "\\" && i + 1 < input.length && '$`"\\\n'.includes(input.charAt(i + 1))) {
          text += input.charAt(i + 1);
          i += 2;
        } else if (d === "$") {
          i = dollar(i);
        } else if (d === "`") {
          i = backtick(i);
        } else {
          text += d;
          i += 1;
        }
      }
    } else if (c === "$") {
      started = true;
      i = dollar(i);
    } else if (c === "`") {
      started = true;
      i = backtick(i);
    } else if ((c === "<" || c === ">") && input[i + 1] === "(") {
      // Substitution de processus : <(cmd) ou >(cmd).
      started = true;
      const end = closingParen(input, i + 2);
      substitute(input.slice(i + 2, end));
      text += input.slice(i, end + 1);
      i = end + 1;
    } else if (c === "(" && !started) {
      flush();
      const end = closingParen(input, i + 1);
      // Un sous-shell n'est pas une substitution : même profondeur.
      tokens.push({ kind: "subshell", script: parseShell(input.slice(i + 1, end), depth) });
      i = end + 1;
    } else if (OPERATOR_CHARS.has(c)) {
      // Descripteur collé à une redirection (2>, 2>&1) : le nombre n'est pas un mot.
      // Un mot fait seulement de chiffres n'a ni expansion ni substitution.
      const fd = /^\d+$/.test(text) && (c === "<" || c === ">");
      if (fd) {
        text = "";
        started = false;
      }
      flush();
      const three = input.slice(i, i + 3);
      const two = input.slice(i, i + 2);
      const op = ["&>>", "<<<"].includes(three)
        ? three
        : ["&&", "||", ">>", ">|", "&>", ">&", "<&", ";;", "<<", "|&"].includes(two)
          ? two
          : c;
      if (op === "<<") {
        throw new ShellParseError("here-document non pris en charge");
      }
      if (op === ";;" || op === "|&" || op === "(" || op === ")") {
        throw new ShellParseError(`opérateur ${op} non pris en charge`);
      }
      tokens.push({ kind: "op", op });
      i += op.length;
    } else {
      started = true;
      text += c;
      i += 1;
    }
  }
  flush();
  return tokens;
}

const REDIRECTS = new Set<string>([">", ">>", ">|", "&>", "&>>", "<", "<<<", ">&", "<&"]);

/** Découpe `input` en suites de pipelines. `depth` compte les substitutions qui l'englobent. */
export function parseShell(input: string, depth = 0): Script {
  const tokens = tokenize(input, depth);
  const pipelines: Pipeline[] = [];
  let commands: SimpleCommand[] = [];
  let current: { assignments: string[]; words: Word[]; redirects: Redirect[]; subshell?: Script } =
    {
      assignments: [],
      words: [],
      redirects: [],
    };
  const empty = () =>
    current.words.length === 0 &&
    current.assignments.length === 0 &&
    current.redirects.length === 0 &&
    !current.subshell;
  const endCommand = (required: boolean) => {
    if (empty()) {
      if (required) {
        throw new ShellParseError("commande vide autour d'un opérateur");
      }
      return;
    }
    commands.push(current);
    current = { assignments: [], words: [], redirects: [] };
  };
  const endPipeline = (required: boolean) => {
    endCommand(required || commands.length > 0);
    if (commands.length > 0) {
      pipelines.push({ commands });
    }
    commands = [];
  };

  /** Après `|`, `&&` ou `||`, une commande doit suivre. */
  let pending = false;
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token;
    pending = pending && !(token.kind !== "op" || REDIRECTS.has(token.op));
    if (token.kind === "subshell") {
      if (!empty()) {
        throw new ShellParseError("sous-shell au milieu d'une commande");
      }
      current.subshell = token.script;
      continue;
    }
    if (token.kind === "word") {
      const { word } = token;
      if (current.words.length === 0 && !current.subshell) {
        if (KEYWORDS.has(word.text) && !word.expansion) {
          throw new ShellParseError(
            `structure de contrôle « ${word.text} » non prise en charge : utilise des commandes simples ou un playbook`,
          );
        }
        if (word.text === "{" || word.text === "}") {
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) {
          current.assignments.push(word.text);
          continue;
        }
      }
      if (current.subshell) {
        throw new ShellParseError("mot après un sous-shell");
      }
      current.words.push(word);
      continue;
    }
    if (token.op === "\n") {
      // Saut de ligne : séparateur souple, permis après `|`, `&&` ou `||`.
      if (!pending) {
        endPipeline(false);
      }
      continue;
    }
    if (pending && empty() && !REDIRECTS.has(token.op)) {
      throw new ShellParseError("commande manquante après un opérateur");
    }
    if (REDIRECTS.has(token.op)) {
      const target = tokens[k + 1];
      if (target?.kind !== "word") {
        throw new ShellParseError(`redirection ${token.op} sans cible`);
      }
      current.redirects.push({ op: token.op as RedirectOp, target: target.word });
      k += 1;
    } else if (token.op === "|") {
      endCommand(true);
      pending = true;
    } else {
      // ; & && || : fin du pipeline. Un `;` ou `&` final est permis.
      endPipeline(token.op === "&&" || token.op === "||" || k === 0);
      pending = token.op === "&&" || token.op === "||";
    }
  }
  if (pending && empty()) {
    throw new ShellParseError("commande manquante après un opérateur");
  }
  endPipeline(false);
  return { pipelines };
}
