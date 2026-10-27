import { defineProject } from "vitest/config";

// Les packages du workspace exposent leurs sources sous la condition "@jules/source" :
// les tests et le typecheck n'ont pas besoin d'un build préalable.
export const sharedProject = (name: string) =>
  defineProject({
    resolve: { conditions: ["@jules/source"] },
    ssr: { resolve: { conditions: ["@jules/source"] } },
    test: {
      name,
      environment: "node",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      hookTimeout: 120_000,
      testTimeout: 60_000,
    },
  });
