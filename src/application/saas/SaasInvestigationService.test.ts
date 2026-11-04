import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserScenarioCapturePort } from "../BrowserScenarioCapturePort.js";
import type { BrowserScenario } from "../../domain/browserScenario.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import { saasInvestigationReportSchema } from "../../domain/saasInvestigation.js";
import {
  investigationCapture,
  investigationPlan,
} from "../../../tests/fixtures/saasInvestigation.js";
import { runSaasInvestigation } from "./SaasInvestigationService.js";

class StatefulProvider implements BrowserScenarioCapturePort {
  readonly records = new Map<string, { record: string; value: number }>();
  writes = 0;
  captures = 0;
  loseResponse = false;
  actor = "operator";
  identity() {
    return { id: "fixture", name: "Stateful synthetic fixture", version: "1" };
  }
  captureScenario(scenario: BrowserScenario) {
    this.captures += 1;
    const path = new URL(scenario.start_url.url).pathname;
    const id = path.split("/")[2]!;
    if (path.startsWith("/act/")) {
      this.writes += 1;
      this.records.set(id, {
        record: `run-1-${id}`,
        value: id === "first" ? 1 : 0,
      });
      if (this.loseResponse) {
        this.loseResponse = false;
        return Promise.resolve(
          err(
            new AnalysisOutputError(
              "capture_browser_scenario",
              "Simulated connection lost after commit",
            ),
          ),
        );
      }
    }
    return Promise.resolve(
      ok(
        investigationCapture(scenario, {
          actor: this.actor,
          workspace: "test-workspace",
          record: null,
          ...this.records.get(id),
        }),
      ),
    );
  }
}

describe.skipIf(process.platform === "win32")(
  "durable live SaaS controller",
  () => {
    const directories: string[] = [];
    afterEach(async () => {
      await Promise.all(
        directories
          .splice(0)
          .map((path) => rm(path, { recursive: true, force: true })),
      );
    });
    const request = async () => {
      const directory = await mkdtemp(join(tmpdir(), "rea-saas-loop-"));
      directories.push(directory);
      return {
        plan: investigationPlan(),
        journal_path: join(directory, "journal.json"),
      };
    };
    const report = (
      result: Awaited<ReturnType<typeof runSaasInvestigation>>,
    ) => {
      if (!result.ok) throw result.error;
      return saasInvestigationReportSchema.parse(
        result.value.normalized_result,
      );
    };

    test("runs two adaptive experiments and retains evidence across an idempotent completed resume", async () => {
      const input = await request();
      const provider = new StatefulProvider();
      const result = report(await runSaasInvestigation(provider, input));
      expect(result).toMatchObject({
        status: "distinguished",
        surviving_hypotheses: ["a"],
        actions_reserved: 12,
      });
      expect(result.attempts.map(({ experiment_id: id }) => id)).toEqual([
        "first",
        "second",
      ]);
      expect(provider.writes).toBe(2);
      const saved = JSON.parse(await readFile(input.journal_path, "utf8"));
      expect(saved.evidence.records.length).toBe(6);
      expect(report(await runSaasInvestigation(provider, input)).status).toBe(
        "distinguished",
      );
      expect(provider.captures).toBe(6);
    });

    test("reads back an interrupted write on resume without repeating it", async () => {
      const input = await request();
      const provider = new StatefulProvider();
      provider.loseResponse = true;
      expect(report(await runSaasInvestigation(provider, input))).toMatchObject(
        {
          status: "paused",
          attempts: [{ experiment_id: "first", status: "pending" }],
        },
      );
      const interrupted = JSON.parse(
        await readFile(input.journal_path, "utf8"),
      );
      expect(interrupted.failures).toMatchObject([
        { diagnostic: { code: "unreadable_output" } },
      ]);
      const resumed = report(await runSaasInvestigation(provider, input));
      expect(resumed.status).toBe("distinguished");
      expect(resumed.attempts[0]!.recovered).toBe(true);
      expect(provider.writes).toBe(2);
    });

    test("does not retry an uncertain write whose readback cannot establish completion", async () => {
      const input = await request();
      const provider = new StatefulProvider();
      provider.loseResponse = true;
      await runSaasInvestigation(provider, input);
      provider.records.clear();
      const result = report(await runSaasInvestigation(provider, input));
      expect(result).toMatchObject({
        status: "paused",
        surviving_hypotheses: ["a", "b", "c", "d"],
      });
      expect(provider.writes).toBe(1);
    });

    test("wrong observed identity blocks the first write", async () => {
      const input = await request();
      const provider = new StatefulProvider();
      provider.actor = "someone-else";
      expect(report(await runSaasInvestigation(provider, input)).status).toBe(
        "paused",
      );
      expect(provider.writes).toBe(0);
    });

    test("action budget is cumulative and admits a full experiment before any of its actions", async () => {
      const input = await request();
      input.plan.limits.max_actions = 6;
      const provider = new StatefulProvider();
      expect(report(await runSaasInvestigation(provider, input))).toMatchObject(
        {
          status: "paused",
          actions_reserved: 6,
        },
      );
      expect(report(await runSaasInvestigation(provider, input))).toMatchObject(
        {
          status: "paused",
          actions_reserved: 6,
        },
      );
      expect(provider.writes).toBe(1);
    });

    test("changed plan, a held journal lock, and corrupt progress refuse target execution", async () => {
      const input = await request();
      const provider = new StatefulProvider();
      await writeFile(`${input.journal_path}.lock`, "held");
      expect((await runSaasInvestigation(provider, input)).ok).toBe(false);
      expect(provider.captures).toBe(0);
      await rm(`${input.journal_path}.lock`);
      await runSaasInvestigation(provider, input);
      input.plan.actor_id = "changed";
      expect((await runSaasInvestigation(provider, input)).ok).toBe(false);
      input.plan.actor_id = "operator";
      await writeFile(input.journal_path, "{broken");
      expect((await runSaasInvestigation(provider, input)).ok).toBe(false);
      expect(provider.captures).toBe(6);
    });

    test("journal capacity and pre-cancellation prevent all browser calls", async () => {
      const input = await request();
      input.plan.limits.max_journal_bytes = 10;
      const provider = new StatefulProvider();
      expect((await runSaasInvestigation(provider, input)).ok).toBe(false);
      expect(provider.captures).toBe(0);
      // A valid request, so only the caller's cancellation can refuse it.
      const runnable = await request();
      const cancelled = new AbortController();
      cancelled.abort();
      const refused = await runSaasInvestigation(provider, runnable, {
        signal: cancelled.signal,
      });
      expect(!refused.ok && refused.error._tag).toBe("AnalysisCancelledError");
      expect(provider.captures).toBe(0);
      await expect(readFile(runnable.journal_path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);
