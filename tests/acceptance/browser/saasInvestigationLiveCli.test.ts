import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { investigationPlan } from "../../fixtures/saasInvestigation.js";

const executable = process.env.REA_TEST_CHROMIUM;

test.skipIf(executable === undefined || process.platform === "win32")(
  "real browser CLI investigates two HTTP experiments and resumes without new writes",
  async () => {
    const records = new Map<string, { record: string; value: number }>();
    let writes = 0;
    const app = createServer((request, response) => {
      const path = new URL(request.url!, "http://fixture.test").pathname;
      const id = path.split("/")[2]!;
      response.setHeader("cache-control", "no-store");
      if (path.startsWith("/state/")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            actor: "operator",
            workspace: "test-workspace",
            record: null,
            ...records.get(id),
          }),
        );
      } else if (path.startsWith("/save/") && request.method === "POST") {
        writes += 1;
        records.set(id, {
          record: `run-1-${id}`,
          value: id === "first" ? 1 : 0,
        });
        response.setHeader("content-type", "application/json");
        response.end('{"saved":true}');
      } else if (path.startsWith("/act/")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<!doctype html><button id="save">Save</button><script>document.querySelector('#save').onclick=async()=>{await fetch('/save/${id}',{method:'POST'});document.body.insertAdjacentHTML('beforeend','<div id="done">Saved</div>')};</script>`,
        );
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (address === null || typeof address === "string")
      throw new Error("No HTTP fixture address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const directory = await mkdtemp(join(tmpdir(), "rea-saas-live-browser-"));
    try {
      const plan = investigationPlan();
      plan.allowed_origins = [origin];
      plan.limits.max_run_ms = 60000;
      for (const experiment of plan.experiments) {
        for (const scenario of [
          experiment.before.scenario,
          experiment.action,
          experiment.after.scenario,
        ]) {
          scenario.browser = {
            mode: "launch",
            executable_path: executable!,
            headless: true,
          };
          scenario.start_url.url =
            origin + new URL(scenario.start_url.url).pathname;
        }
        experiment.before.response_url = `${origin}/state/${experiment.id}`;
        experiment.after.response_url = experiment.before.response_url;
        experiment.action.actions = [
          {
            step_id: "save",
            action: "click",
            locator: { kind: "css", selector: "#save" },
            button: "left",
            click_count: 1,
            timeout_ms: 5000,
          },
          {
            step_id: "saved",
            action: "wait_for",
            locator: { kind: "css", selector: "#done" },
            state: "visible",
            timeout_ms: 5000,
          },
        ];
      }
      const path = join(directory, "request.json");
      const journal = join(directory, "journal.json");
      await writeFile(path, JSON.stringify({ plan, journal_path: journal }));
      const invoke = async () => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ["scripts/rea.mjs", "run-saas-investigation", path, "--json"],
          { timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      };
      const result = await invoke();
      const retained = JSON.parse(await readFile(journal, "utf8"));
      const diagnostics = {
        report: result.normalized_result,
        captures: retained.evidence.records.map(
          (record: { normalized_result: unknown }) => record.normalized_result,
        ),
      };
      expect(
        result.normalized_result,
        JSON.stringify(diagnostics),
      ).toMatchObject({
        status: "distinguished",
        surviving_hypotheses: ["a"],
        actions_reserved: 14,
      });
      expect(
        result.normalized_result.attempts.map(
          (attempt: { experiment_id: string }) => attempt.experiment_id,
        ),
      ).toEqual(["first", "second"]);
      expect(writes).toBe(2);
      expect(retained.evidence.records).toHaveLength(6);
      expect((await invoke()).normalized_result.status).toBe("distinguished");
      expect(writes).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        app.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  180000,
);
