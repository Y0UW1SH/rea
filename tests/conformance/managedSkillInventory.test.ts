import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { MANAGED_SKILL_FILES } from "../../src/application/SetupSkill.js";

it("installs every authored skill file through the managed inventory", async () => {
  const root = resolve(".agents/skills/reverse-engineer-anything");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
  expect([...MANAGED_SKILL_FILES].sort()).toEqual(files.sort());
});
