import { describe, expect, it } from "vitest";
import { authorize, hasRole, parseCommand, prose, requiredRole } from "./commands.js";

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
