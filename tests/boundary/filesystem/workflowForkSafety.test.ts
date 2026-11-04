import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflows = fileURLToPath(
  new URL("../../../.github/workflows/", import.meta.url),
);
const forkGuard = "github.repository != 'Y0UW1SH/rea'";
const allowedJobs: Readonly<Record<string, readonly string[]>> = {
  "saas-compatibility.yml": ["saas-compatibility"],
  "saas-upstream-integration.yml": ["combined-candidate"],
};
const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({ if: z.unknown().optional() })),
});

// Require the fork exclusion to dominate the entire job expression. Merely
// searching for the repository name would accept `guard && a || always()`.
// This is a deliberately narrow shape check, not a GitHub expression evaluator.
const guarded = (condition: unknown): boolean => {
  if (typeof condition !== "string") return false;
  const trimmed = condition.trim();
  const expression =
    trimmed.startsWith("${{") && trimmed.endsWith("}}")
      ? trimmed.slice(3, -2).trim()
      : trimmed;
  if (expression === forkGuard) return true;
  const prefix = `${forkGuard} && (`;
  if (!expression.startsWith(prefix) || !expression.endsWith(")")) return false;
  const inner = expression.slice(prefix.length, -1);
  if (!inner.trim()) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === "'") {
      if (quoted && inner[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (character === "(") depth += 1;
      if (character === ")" && --depth < 0) return false;
      if (character === "{" || character === "}") return false;
    }
  }
  return !quoted && depth === 0;
};

const unsafeJobs = (name: string, source: string): readonly string[] => {
  const { jobs } = workflowSchema.parse(parse(source));
  return Object.entries(jobs).flatMap(([job, definition]) => {
    if (allowedJobs[name]?.includes(job)) {
      return definition.if === undefined
        ? []
        : [`${name}:${job}: SaaS job must remain enabled`];
    }
    return guarded(definition.if)
      ? []
      : [`${name}:${job}: missing dominating fork guard`];
  });
};

describe("fork-only inherited workflow guards", () => {
  it.each([
    forkGuard,
    `\${{ ${forkGuard} }}`,
    `\${{ ${forkGuard} && (always() && !cancelled() && (needs.build.result == 'success' || inputs.publish)) }}`,
    `\${{ ${forkGuard} && (startsWith(github.ref, 'release-(candidate)') && inputs.note == 'it''s ready') }}`,
  ])("accepts a dominating guard: %s", (condition) => {
    expect(guarded(condition)).toBe(true);
  });

  it.each([
    undefined,
    true,
    "always()",
    "github.repository_owner != 'Y0UW1SH'",
    "github.repository == 'morluto/rea'",
    `${forkGuard} || always()`,
    `${forkGuard} && needs.build.result == 'success' || always()`,
    `${forkGuard} && (false) || (always())`,
    `\${{ ${forkGuard}`,
    `${forkGuard} }}`,
    `${forkGuard} && ()`,
    `${forkGuard} && (always()`,
    `${forkGuard} && ('unterminated)`,
    `${forkGuard} && (\${{ always() }})`,
  ])("rejects a missing or escapable guard: %s", (condition) => {
    expect(guarded(condition)).toBe(false);
  });

  it("checks runner, reusable, always and newly introduced jobs rather than step guards", () => {
    expect(
      unsafeJobs(
        "new-upstream.yml",
        `
jobs:
  runner:
    runs-on: ubuntu-latest
    steps:
      - if: ${forkGuard}
        run: echo guarded-step-only
  reusable:
    uses: ./.github/workflows/ci.yml
  aggregate:
    if: always()
    needs: [runner, reusable]
    runs-on: ubuntu-latest
  added: { runs-on: ubuntu-latest }
`,
      ),
    ).toEqual([
      "new-upstream.yml:runner: missing dominating fork guard",
      "new-upstream.yml:reusable: missing dominating fork guard",
      "new-upstream.yml:aggregate: missing dominating fork guard",
      "new-upstream.yml:added: missing dominating fork guard",
    ]);
  });

  it("limits exceptions to the two exact SaaS job identities", () => {
    expect(
      unsafeJobs(
        "saas-compatibility.yml",
        `jobs: { saas-compatibility: {}, added: {} }`,
      ),
    ).toEqual(["saas-compatibility.yml:added: missing dominating fork guard"]);
    expect(
      unsafeJobs("copied-saas.yml", `jobs: { saas-compatibility: {} }`),
    ).toEqual([
      "copied-saas.yml:saas-compatibility: missing dominating fork guard",
    ]);
    expect(
      unsafeJobs(
        "saas-upstream-integration.yml",
        `jobs: { combined-candidate: { if: false } }`,
      ),
    ).toEqual([
      "saas-upstream-integration.yml:combined-candidate: SaaS job must remain enabled",
    ]);
  });

  it("fails closed for malformed YAML or jobs", () => {
    expect(() => unsafeJobs("broken.yml", "jobs: [")).toThrow();
    expect(() => unsafeJobs("broken.yml", "jobs: null")).toThrow();
    expect(() => unsafeJobs("broken.yml", "jobs: { test: null }")).toThrow();
  });

  it("guards every inherited job, including future workflow files, while retaining both SaaS jobs", async () => {
    const files = (await readdir(workflows))
      .filter((name) => /\.ya?ml$/u.test(name))
      .sort();
    const unsafe: string[] = [];
    for (const file of files)
      unsafe.push(
        ...unsafeJobs(file, await readFile(join(workflows, file), "utf8")),
      );
    expect(unsafe).toEqual([]);
    for (const [file, jobs] of Object.entries(allowedJobs)) {
      expect(files).toContain(file);
      const document = workflowSchema.parse(
        parse(await readFile(join(workflows, file), "utf8")),
      );
      for (const job of jobs) expect(document.jobs).toHaveProperty(job);
    }
  });
});
