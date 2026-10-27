import { describe, expect, it } from "vitest";
import {
  authorize,
  commandSchema,
  effectiveRole,
  hasRole,
  parseCommand,
  prose,
  requiredRole,
} from "./commands.js";

describe("parseCommand", () => {
  it.each([
    ["/jules approve", { name: "approve" }],
    ["Merci !\n/jules revise ajoute le cas 404", { name: "revise", feedback: "ajoute le cas 404" }],
    ["/JULES retry", { name: "retry" }],
    ["/jules pause", { name: "pause" }],
    ["/jules resume", { name: "resume" }],
    ["/jules cancel", { name: "cancel" }],
    ["/jules stop-all", { name: "stop_all" }],
    ["/jules fix renomme la variable", { name: "fix", instructions: "renomme la variable" }],
    ["/jules budget +10", { name: "budget", addUsd: 10 }],
    ["/jules budget +2.5$", { name: "budget", addUsd: 2.5 }],
    [
      "/jules lesson approve 1f3a9c0d",
      { name: "lesson", decision: "approve", lessonId: "1f3a9c0d" },
    ],
    [
      "/jules lesson REJECT 1f3a9c0d-1111-4222-8333-444455556666",
      { name: "lesson", decision: "reject", lessonId: "1f3a9c0d-1111-4222-8333-444455556666" },
    ],
  ])("%j", (body, command) => {
    expect(parseCommand(body)).toEqual({ command });
  });

  it.each([
    "/jules",
    "/jules danse",
    "/jules revise",
    "/jules fix",
    "/jules budget 10",
    "/jules budget +0",
    "/jules budget +5000",
    "/jules lesson approve",
    "/jules lesson keep 1f3a9c0d",
  ])("signale une commande invalide : %j", (body) => {
    expect(parseCommand(body)).toHaveProperty("error");
  });

  it.each([
    "merci",
    "> /jules approve",
    "`/jules approve`",
    "```\n/jules approve\n```",
    "voir /julesbot",
    "<!-- /jules approve -->",
  ])("ignore %j", (body) => {
    expect(parseCommand(body)).toBeUndefined();
  });

  it("borne la longueur du retour", () => {
    const parsed = parseCommand(`/jules revise ${"x".repeat(5000)}`);
    expect(
      parsed &&
        "command" in parsed &&
        parsed.command.name === "revise" &&
        parsed.command.feedback.length,
    ).toBe(4000);
  });

  it("retire le texte non adressé à Jules", () => {
    expect(prose("a\n> b\n`c` d")).toBe("a\n d");
  });
});

describe("droits (WORKFLOW.md §7)", () => {
  it.each([
    [{ name: "approve" }, "low", "write"],
    [{ name: "approve" }, "high", "maintain"],
    [{ name: "budget", addUsd: 5 }, undefined, "maintain"],
    [{ name: "stop_all" }, undefined, "admin"],
    [{ name: "lesson", decision: "approve", lessonId: "1f3a9c0d" }, undefined, "maintain"],
    [{ name: "cancel" }, "high", "write"],
  ] as const)("%j en risque %s demande %s", (command, risk, role) => {
    expect(requiredRole(command, risk)).toBe(role);
  });

  it("refuse une personne sans le droit requis, avec la raison", () => {
    expect(authorize({ name: "approve" }, "read", "medium")).toEqual({
      ok: false,
      reason: "`/jules approve` demande le droit write (tu as read)",
    });
    expect(authorize({ name: "stop_all" }, "maintain", undefined)).toMatchObject({ ok: false });
    expect(authorize({ name: "approve" }, "maintain", "high")).toEqual({ ok: true });
  });

  it("ordonne les rôles", () => {
    expect(hasRole("admin", "write")).toBe(true);
    expect(hasRole("triage", "write")).toBe(false);
  });
});

describe("droits effectifs (ARCHITECTURE.md §4.2)", () => {
  it.each([
    ["admin", "write", "write"],
    ["member", "admin", "write"],
    ["viewer", "admin", "read"],
    ["maintainer", "maintain", "maintain"],
    ["admin", "none", "none"],
  ] as const)("Jules %s et GitHub %s donnent %s", (jules, github, expected) => {
    expect(effectiveRole(jules, github)).toBe(expected);
  });

  it("valide les commandes reçues en JSON", () => {
    expect(commandSchema.safeParse({ name: "approve" }).success).toBe(true);
    expect(commandSchema.safeParse({ name: "revise", feedback: "" }).success).toBe(false);
    expect(commandSchema.safeParse({ name: "rm" }).success).toBe(false);
  });
});
