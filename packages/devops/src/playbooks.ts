import { parse } from "yaml";
import { z } from "zod";
import { classify, type CommandClass } from "./classify.js";

// Playbooks (ARCHITECTURE.md §9) : séquences relues une fois, déclarées dans `.jules/playbooks.yml`
// sur la branche par défaut. Les paramètres sont typés : une valeur n'est jamais du texte libre
// interpolé, elle ne peut donc pas sortir de la commande où elle est insérée.

const PARAM_PATTERNS = {
  git_sha: /^[0-9a-f]{7,40}$/,
  git_ref: /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/,
  semver: /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/,
  int: /^\d{1,9}$/,
  port: /^\d{1,5}$/,
  bool: /^(true|false)$/,
} as const;

const SAFE_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const DURATION = /^(\d{1,4})(s|m)$/;

const paramSchema = z.union([
  z.object({
    type: z.enum(["git_sha", "git_ref", "semver", "int", "port", "bool"]),
    required: z.boolean().default(false),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("enum"),
    values: z.array(z.string().regex(SAFE_VALUE)).min(1).max(50),
    required: z.boolean().default(false),
    default: z.string().optional(),
  }),
]);
export type ParamSpec = z.infer<typeof paramSchema>;

const verifySchema = z.union([
  z.object({
    http: z.url({ protocol: /^https?$/ }),
    expect_status: z.number().int().min(100).max(599).default(200),
    within: z.string().regex(DURATION).default("60s"),
  }),
  z.object({ run: z.string().min(1).max(2000) }),
]);

const playbookSchema = z.object({
  description: z.string().max(500).optional(),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), paramSchema).default({}),
  steps: z
    .array(z.object({ run: z.string().min(1).max(2000) }))
    .min(1)
    .max(30),
  verify: z.array(verifySchema).max(10).default([]),
  rollback: z
    .array(z.object({ run: z.string().min(1).max(2000) }))
    .max(30)
    .default([]),
});
export type Playbook = z.infer<typeof playbookSchema>;

const fileSchema = z.object({
  playbooks: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/), playbookSchema),
});

/** Paramètres fournis par le worker, jamais par l'agent. */
export const BUILTIN_PARAMS = { previous_ref: "git_sha" } as const;
export type Builtins = Partial<Record<keyof typeof BUILTIN_PARAMS, string>>;

export type VerifyStep =
  | {
      readonly kind: "http";
      readonly url: string;
      readonly expectStatus: number;
      readonly withinMs: number;
    }
  | { readonly kind: "command"; readonly command: string };

export type RenderedPlaybook = {
  readonly name: string;
  readonly steps: readonly string[];
  readonly verify: readonly VerifyStep[];
  readonly rollback: readonly string[];
};

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Lit `.jules/playbooks.yml`. Un fichier invalide donne des erreurs lisibles, jamais un playbook partiel. */
export function parsePlaybooks(text: string): Result<Record<string, Playbook>> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { ok: false, errors: [`YAML invalide : ${(error as Error).message}`] };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`),
    };
  }
  const errors = Object.entries(parsed.data.playbooks).flatMap(([name, pb]) =>
    Object.entries(pb.params).flatMap(([param, spec]) =>
      spec.default !== undefined && checkValue(spec, spec.default) !== undefined
        ? [`${name}.params.${param} : valeur par défaut invalide`]
        : [],
    ),
  );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed.data.playbooks };
}

function checkValue(spec: ParamSpec, value: string): string | undefined {
  if (spec.type === "enum") {
    return spec.values.includes(value) ? undefined : `attendu parmi ${spec.values.join(", ")}`;
  }
  if (!PARAM_PATTERNS[spec.type].test(value)) {
    return `type ${spec.type} attendu`;
  }
  if (spec.type === "port" && (Number(value) < 1 || Number(value) > 65535)) {
    return "port hors de 1 à 65535";
  }
  return undefined;
}

/** Remplace `{{param}}` par des valeurs validées. Un paramètre inconnu ou invalide est une erreur. */
export function renderPlaybook(
  name: string,
  playbook: Playbook,
  params: Readonly<Record<string, string>>,
  builtins: Builtins = {},
): Result<RenderedPlaybook> {
  const errors: string[] = [];
  const values: Record<string, string> = {};
  for (const key of Object.keys(params)) {
    if (!(key in playbook.params)) {
      errors.push(`paramètre inconnu : ${key}`);
    }
  }
  for (const [key, spec] of Object.entries(playbook.params)) {
    const value = params[key] ?? spec.default;
    if (value === undefined) {
      if (spec.required) {
        errors.push(`paramètre requis : ${key}`);
      }
      continue;
    }
    const problem = checkValue(spec, value);
    if (problem) {
      errors.push(`${key} : ${problem}`);
    } else {
      values[key] = value;
    }
  }
  for (const [key, value] of Object.entries(builtins)) {
    if (PARAM_PATTERNS[BUILTIN_PARAMS[key as keyof typeof BUILTIN_PARAMS]].test(value)) {
      values[key] = value;
    } else {
      errors.push(`${key} : valeur interne invalide`);
    }
  }
  const fill = (template: string) =>
    template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
      const value = values[key];
      if (value === undefined) {
        errors.push(`{{${key}}} sans valeur`);
        return "";
      }
      return value;
    });
  const steps = playbook.steps.map((s) => fill(s.run));
  const verify = playbook.verify.map((v): VerifyStep => {
    if ("http" in v) {
      // `within` est déjà validé par le schéma : un nombre suivi de `s` ou `m`.
      return {
        kind: "http",
        url: fill(v.http),
        expectStatus: v.expect_status,
        withinMs: Number.parseInt(v.within, 10) * (v.within.endsWith("m") ? 60_000 : 1000),
      };
    }
    return { kind: "command", command: fill(v.run) };
  });
  const rollback = playbook.rollback.map((s) => fill(s.run));
  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : { ok: true, value: { name, steps, verify, rollback } };
}

/** Classe d'un playbook rendu : la plus haute de ses étapes, `shutdown` et `reboot` y étant permis. */
export function classifyPlaybook(rendered: RenderedPlaybook): {
  class: CommandClass;
  reasons: string[];
} {
  const results = [...rendered.steps, ...rendered.rollback].map((step) =>
    classify(step, { inPlaybook: true }),
  );
  const rank = { read: 0, change: 1, dangerous: 2 } as const;
  const worst = results.reduce<CommandClass>(
    (acc, r) => (rank[r.class] > rank[acc] ? r.class : acc),
    "read",
  );
  return { class: worst, reasons: results.flatMap((r) => r.reasons) };
}
