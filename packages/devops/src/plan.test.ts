import { describe, expect, it } from "vitest";
import { expandPlan, inPlan, type ChangePlan } from "./plan.js";
import { classifyPlaybook, parsePlaybooks, renderPlaybook, type Playbook } from "./playbooks.js";

const YAML = `
playbooks:
  deploy:
    description: Déploie une version
    params:
      ref: { type: git_sha, required: true }
      mode: { type: enum, values: [fast, safe], default: safe }
    steps:
      - run: git -C /srv/app fetch --tags && git -C /srv/app checkout {{ref}}
      - run: docker compose -f /srv/app/compose.yaml up -d
    verify:
      - http: https://app.example.com/health
        expect_status: 200
        within: 2m
      - run: docker compose -f /srv/app/compose.yaml ps
    rollback:
      - run: git -C /srv/app checkout {{previous_ref}} && docker compose -f /srv/app/compose.yaml up -d
  restart:
    steps:
      - run: systemctl restart app
    verify:
      - http: https://app.example.com/health
  wipe:
    steps:
      - run: rm -rf /
`;

const playbooks = (() => {
  const parsed = parsePlaybooks(YAML);
  if (!parsed.ok) throw new Error(parsed.errors.join());
  return parsed.value;
})();
const deploy = playbooks.deploy!;

describe("playbooks (ARCHITECTURE.md §9)", () => {
  it("rend les étapes avec des paramètres typés et les valeurs internes du worker", () => {
    const rendered = renderPlaybook(
      "deploy",
      deploy,
      { ref: "4f2a9c1" },
      { previous_ref: "1a2b3c4" },
    );
    expect(rendered).toMatchObject({
      ok: true,
      value: {
        steps: [
          "git -C /srv/app fetch --tags && git -C /srv/app checkout 4f2a9c1",
          "docker compose -f /srv/app/compose.yaml up -d",
        ],
        verify: [
          {
            kind: "http",
            url: "https://app.example.com/health",
            expectStatus: 200,
            withinMs: 120_000,
          },
          { kind: "command", command: "docker compose -f /srv/app/compose.yaml ps" },
        ],
        rollback: [expect.stringContaining("checkout 1a2b3c4")],
      },
    });
  });

  it("refuse une valeur qui sortirait de la commande, un paramètre inconnu ou manquant", () => {
    const bad = renderPlaybook("deploy", deploy, { ref: "main; rm -rf /", extra: "x" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual(
      expect.arrayContaining([
        "paramètre inconnu : extra",
        "ref : type git_sha attendu",
        "{{previous_ref}} sans valeur",
      ]),
    );
    const missing = renderPlaybook("deploy", deploy, {});
    expect(!missing.ok && missing.errors).toContain("paramètre requis : ref");
    expect(
      renderPlaybook(
        "deploy",
        deploy,
        { ref: "4f2a9c1", mode: "turbo" },
        { previous_ref: "1a2b3c4" },
      ).ok,
    ).toBe(false);
    expect(
      renderPlaybook("deploy", deploy, { ref: "4f2a9c1" }, { previous_ref: "HEAD~1" }).ok,
    ).toBe(false);
  });

  it("valide chaque type de paramètre", () => {
    const pb = (type: string, extra = "") => {
      const parsed = parsePlaybooks(
        `playbooks:\n  p:\n    params:\n      v: { type: ${type}${extra} }\n    steps:\n      - run: echo {{v}}\n`,
      );
      if (!parsed.ok) throw new Error(parsed.errors.join());
      return parsed.value.p!;
    };
    const ok = (type: string, value: string) => renderPlaybook("p", pb(type), { v: value }).ok;
    expect([ok("git_ref", "release/1.2"), ok("git_ref", "-x"), ok("git_ref", "a..b")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([ok("semver", "v1.2.3"), ok("semver", "1.2")]).toEqual([true, false]);
    expect([ok("int", "42"), ok("int", "4x")]).toEqual([true, false]);
    expect([ok("port", "443"), ok("port", "70000"), ok("port", "0")]).toEqual([true, false, false]);
    expect([ok("bool", "true"), ok("bool", "yes")]).toEqual([true, false]);
    expect(renderPlaybook("p", pb("int"), {}).ok).toBe(false);
    expect(renderPlaybook("p", pb("int", ", required: false, default: '3'"), {})).toMatchObject({
      ok: true,
      value: { steps: ["echo 3"] },
    });
  });

  it("rejette un fichier invalide sans rien en garder", () => {
    expect(parsePlaybooks("playbooks: [").ok).toBe(false);
    expect(parsePlaybooks("[]")).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^\(racine\)/)],
    });
    const wrong = parsePlaybooks("playbooks:\n  Deploy:\n    steps: []\n");
    expect(!wrong.ok && wrong.errors.length).toBeGreaterThan(0);
    const badDefault = parsePlaybooks(
      "playbooks:\n  p:\n    params:\n      v: { type: int, default: 'x' }\n    steps:\n      - run: echo\n",
    );
    expect(!badDefault.ok && badDefault.errors).toEqual([
      "p.params.v : valeur par défaut invalide",
    ]);
  });

  it("classe un playbook par sa pire étape, redémarrage permis", () => {
    const render = (name: string) => {
      const r = renderPlaybook(
        name,
        playbooks[name]!,
        name === "deploy" ? { ref: "4f2a9c1" } : {},
        { previous_ref: "1a2b3c4" },
      );
      if (!r.ok) throw new Error(r.errors.join());
      return r.value;
    };
    expect(classifyPlaybook(render("deploy")).class).toBe("change");
    expect(render("restart").verify).toEqual([
      { kind: "http", url: "https://app.example.com/health", expectStatus: 200, withinMs: 60_000 },
    ]);
    expect(classifyPlaybook(render("wipe")).class).toBe("dangerous");
    const reboot: Playbook = { params: {}, steps: [{ run: "reboot" }], verify: [], rollback: [] };
    const rendered = renderPlaybook("reboot", reboot, {});
    expect(rendered.ok && classifyPlaybook(rendered.value).class).toBe("change");
    const reads: Playbook = { params: {}, steps: [{ run: "uptime" }], verify: [], rollback: [] };
    const r = renderPlaybook("reads", reads, {});
    expect(r.ok && classifyPlaybook(r.value).class).toBe("read");
  });
});

describe("plan de changement et gate GC1 (WORKFLOW.md §12.1)", () => {
  const plan = (overrides: Partial<ChangePlan> = {}): ChangePlan => ({
    goal: "Mettre à jour l'application",
    server: "web-1",
    environment: "staging",
    actions: [
      { kind: "command", command: "systemctl restart app", reason: "charger la config" },
      { kind: "playbook", name: "deploy", params: { ref: "4f2a9c1" } },
    ],
    impact: "quelques secondes d'indisponibilité",
    verify: ["systemctl is-active app", "https://staging.example.com/health"],
    rollback: ["systemctl restart app"],
    ...overrides,
  });
  const context = {
    serverEnvironment: "staging" as const,
    playbooks,
    builtins: { previous_ref: "1a2b3c4" },
  };

  it("déplie le plan dans l'ordre : actions, vérifications, retours arrière", () => {
    const result = expandPlan(plan(), context);
    expect(result.ok).toBe(true);
    const steps = result.ok ? result.steps : [];
    expect(steps.map((s) => s.phase)).toEqual([
      "action",
      "action",
      "action",
      "verify",
      "verify",
      "verify",
      "verify",
      "rollback",
      "rollback",
    ]);
    expect(steps[1]).toMatchObject({ playbook: "deploy" });
    expect(steps[6]).toMatchObject({
      check: { kind: "http", url: "https://staging.example.com/health" },
    });
  });

  it("refuse une action dangereuse, un playbook inconnu ou invalide, un environnement faux", () => {
    const result = expandPlan(
      plan({
        environment: "production",
        actions: [
          { kind: "command", command: "rm -rf /", reason: "x" },
          { kind: "playbook", name: "inconnu", params: {} },
          { kind: "playbook", name: "deploy", params: { ref: "pas-un-sha" } },
          { kind: "playbook", name: "wipe", params: {} },
        ],
        verify: ["systemctl restart app"],
        rollback: ["mkfs.ext4 /dev/sda"],
      }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toEqual([
      "environnement production déclaré, mais le serveur est en staging",
      expect.stringMatching(/^action 1 dangereuse/),
      "action 2 : playbook inconnu « inconnu »",
      expect.stringMatching(/^action 3 \(deploy\)/),
      expect.stringMatching(/^playbook wipe dangereux/),
      "vérification 1 : seules les commandes en lecture sont permises",
      "retour arrière 1 dangereux",
    ]);
  });

  it("n'admet que les actions exactes du plan, sans variante", () => {
    const result = expandPlan(plan(), context);
    const steps = result.ok ? result.steps : [];
    expect(inPlan(steps, "systemctl restart app")).toBe(true);
    expect(inPlan(steps, "systemctl restart app ")).toBe(false);
    expect(inPlan(steps, "systemctl stop app")).toBe(false);
    expect(inPlan(steps, "systemctl is-active app")).toBe(false);
  });
});
