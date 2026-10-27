import { mergeConfig } from "vitest/config";
import { sharedProject } from "../../vitest.shared.ts";

// Package pur et à haut risque (WORKFLOW.md §11) : la classification des commandes décide de ce qui touche un serveur. Couverture de 100 % exigée.
export default mergeConfig(sharedProject("devops"), {
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
