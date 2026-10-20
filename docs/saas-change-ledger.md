# SaaS fork change ledger

This is the durable inventory of this fork's SaaS additions and the review checklist
for preserving them during upstream updates. Keep it with the feature branch,
`feat/saas-behavior-compatibility`. See the [usage and scope guide](saas-compatibility.md)
for contracts and examples, and the [validation report](saas-validation.md) for
executed checks and known limits.

## Exact checkpoints

These immutable commit IDs identify the code even if a branch later moves:

- Upstream-derived starting point: [`e4c3d72396bf925a45724ce8b18b238b0d23d787`](https://github.com/Y0UW1SH/rea/commit/e4c3d72396bf925a45724ce8b18b238b0d23d787).
- Initial complete feature checkpoint: [`9f0f4f1537e093eaeae242c68c9fce28340faf11`](https://github.com/Y0UW1SH/rea/commit/9f0f4f1537e093eaeae242c68c9fce28340faf11).
- Tested numeric/export hardening checkpoint: [`bbb9e40f8f314f240839099bcebefd2410116c7c`](https://github.com/Y0UW1SH/rea/commit/bbb9e40f8f314f240839099bcebefd2410116c7c).
  Its parent is the initial feature checkpoint above.
- Portable companion-suite feature head before the 2026-10-20 integration:
  [`5cf82999e904ed8039be9ea2057bf14b702780f6`](https://github.com/Y0UW1SH/rea/commit/5cf82999e904ed8039be9ea2057bf14b702780f6).
- Upstream integration merge of 2026-10-20:
  [`00830ddf6c105ecb5bd4a73963cd8ac433044a4d`](https://github.com/Y0UW1SH/rea/commit/00830ddf6c105ecb5bd4a73963cd8ac433044a4d)
  (tree `b25cadbc34339795c61310934a9e74faccc6af59`), whose parents are the
  feature head above and upstream `morluto/rea` main
  `8716b5241125d81f1a16808eb5178fdfdea1ecdb`. See the
  [integration record](#upstream-integration-record-2026-10-20).

A Git tag is a named pointer, not an offsite backup. Preserve the commits in a
verified remote branch or tag and, when separate backup is needed, a repository
backup outside the working machine. Do not assume a local checkpoint was pushed;
verify the remote reference and resolved commit. This ledger does not assert that
any tag has been published or that the feature branch has been merged into `main`.

## Feature inventory

### Explicit deployment-origin correspondence

Commit: `da4ad848633a1a541e3ad446a85281041860db5b`.

- Adds directional, one-to-one `origin_pairs` to the existing browser scenario
  comparison policy, exposed through the existing CLI and MCP contracts.
- Applies only to structured URL fields; retains paths, queries, fragments,
  undeclared origins, unrelated mismatches and unchanged original captures.
- Main ownership: `src/domain/browserScenarioOriginCorrespondence.ts`, scenario
  normalization/diff modules, `src/cli/browserAdvancedCommands.ts`, and
  `src/contracts/browserToolContracts.ts`.
- Regression owners: `src/domain/browserScenarioDiff.test.ts`,
  `tests/boundary/cli/browserCli.test.ts`, and
  `tests/boundary/mcp/browserScenarioMcp.test.ts`.
- Limit: explicitly allowing deployment differences is not proof of business
  equivalence. Strings in arbitrary DOM text, bodies and storage stay literal.

### Evidence-based workflow evaluator

Commit: `517c0e58922c71dc3313255d221eb884a1af67bd`.

- Adds source-checkout companion `scripts/saas-compatibility.mjs` and its shared
  evaluator, synthetic accounting/retail cases, usage guidance, and authored
  `references/cloud-compatibility.md` skill instructions.
- Compares selected provenance-tagged context, typed entity correspondence,
  outcome values, fresh-read declarations and bounded completion observations.
  Missing evidence remains unknown; explicit mismatches fail.
- Regression owners: `scripts/saas-compatibility.test.mjs` and
  `tests/boundary/cli/saasCompatibility.test.ts`.
- Limit: the checker validates supplied observations. It does not authenticate
  evidence references, perform live actions or independently verify fresh reads.

### Persisted workflow lab and product-planning profiles

Commit: `129712825b0a3ea6448ce97319df41ef12e4c540`.

- Adds `scripts/saas-compatibility-lab.mjs`: independently written local journal
  and table implementations, unseen synthetic inputs, file-reopen observations,
  and seeded wrong amounts, relationships, persistence and retry effects.
- Adds `scripts/saas-product-profile.mjs`, JSON Schema and generic, Lightspeed
  and QuickBooks planning templates with explicit coverage, unknowns and
  observed/simulated/untested external-service boundaries.
- Regression owners: the corresponding `scripts/*.test.mjs` files and
  `tests/boundary/cli/saasCompatibilityLab.test.ts` and
  `tests/boundary/cli/saasProductProfile.test.ts`.
- Limits: templates are not vendor adapters. The lab covers sequential
  same-process retries and file-reopen persistence, not crash durability,
  concurrent actors or real vendor behavior.

### Installed skill completeness

Commit: `1b4cb4030d3780de078b1fe21bffea4ca087d7f6`.

- Adds the cloud-compatibility reference to `src/application/SetupSkill.ts`'s
  managed inventory and the portable skill commitment.
- Adds `tests/conformance/managedSkillInventory.test.ts` to compare the managed
  inventory with every authored skill file recursively.
- Keep source skill files under `.agents/skills/reverse-engineer-anything/`.
  Regenerate ignored packaged `skills/` output rather than editing it directly.
- Relevant integration checks cover selected-skill setup, installation/repair and
  Qwen client configuration in addition to the inventory regression.

### Bounded offline CSV/JSON export comparison

Commit: `9f0f4f1537e093eaeae242c68c9fce28340faf11`.

- Adds `scripts/saas-export-compare.mjs`, comparison helpers and synthetic
  CSV/JSON fixtures, retaining policy, raw digests and excluded column names.
- Aligns records by explicit compound keys and compares selected string/integer/
  decimal fields exactly. Duplicate keys, missing/extra records and meaningful
  differences remain visible; row ordering alone is ignored.
- Rejects malformed/ambiguous inputs, invalid UTF-8, detected path escapes and
  mutation, unsafe coercion, and configured size/record/field/value/depth limits.
- Regression owners: `scripts/saas-export-compare.test.mjs` and
  `tests/boundary/cli/saasExportCompare.test.ts`.
- Limits: reads existing local regular files, not live downloads. It does not
  establish complete vendor export coverage or provide a hostile-filesystem
  sandbox. Browser download cancellation behavior is unchanged.

### Numeric fidelity and report-boundary hardening

Commit: `bbb9e40f8f314f240839099bcebefd2410116c7c`.

- Rejects unsafe integers and original JSON numeric tokens that lose precision,
  underflow or overflow before workflow comparison; exact larger values can be
  represented as strings. Adds shared lossless JSON parsing for library callers.
- Adds the shared `scripts/lib/saas-export-budget.mjs` admission owner.
- Privately snapshots export policy before asynchronous reads, bounds compact
  policy JSON to 1 MiB and complete UTF-8 reports to 16 MiB before serialization,
  including escaping, indentation and the final newline, using shared
  `scripts/lib/saas-export-budget.mjs` accounting.
- Retains admitted policy and available raw input provenance on report overflow
  or invalid UTF-8, with explicit omission of oversized diagnostic details.
- Limits: numeric information already rounded by a caller's parser cannot be
  recovered. Existing `-0` versus `0` comparison/report-rendering behavior is
  unchanged; see the validation report.

### API contract inference and verification

Commits: `e1ebc5ace36acae356919df9ced869714d43c9b0` (shared companion helpers) and
`9ecb9632339f19fd02f2911ae02fa129be606c1c` (contract companion); the wiring and
documentation commit follows them.

- Adds `scripts/saas-api-contract.mjs` (`infer`, `verify`) with
  `scripts/lib/saas-api-contract.mjs` (model building and writing),
  `saas-api-contract-admission.mjs` (manifest validation and the transaction
  admission shared by both commands), `saas-api-contract-render.mjs` (OpenAPI 3.1
  rendering with `x-rea-*` evidence markers) and `saas-api-contract-verify.mjs`
  (Ajv validation of replacement bodies with directional origin pairs).
- Adds the shared companion helpers `scripts/lib/saas-route-templates.mjs`,
  `saas-origin-pairs.mjs`, `saas-scenario-capture.mjs` and
  `saas-json-schema-inference.mjs`, which later increments reuse; `parseExportJson`
  in `saas-export-comparison.mjs` gains an optional number decoder so inference
  sees exact lexemes.
- Mirrors `segmentRule`/`scanRouteTemplate`, raw path extraction and the
  origin-pair ordering and projection. `tests/boundary/cli/saasApiContract.test.ts`
  asserts parity with `src/domain/analysisView/webNetworkRouteTemplates.ts`,
  `src/domain/recordedTransportUrl.ts`,
  `src/domain/browserScenarioNormalization.ts` and
  `src/domain/browserScenarioOriginCorrespondence.ts`, and parses every committed
  fixture with `browserScenarioCaptureSchema`. The `.d.mts` declarations beside
  the helpers exist for that TypeScript test.
- Fixtures under `scripts/fixtures/saas-api-contract/` are generated by
  `scripts/saas-api-contract-fixtures.mjs` (`--check` compares committed bytes)
  from `scripts/lib/saas-api-contract-fixture.mjs`; they are synthetic.
- Regression owners: `scripts/saas-api-contract-helpers.test.mjs`,
  `scripts/saas-api-contract.test.mjs` and
  `scripts/saas-api-contract-verify.test.mjs` (all in `npm run test:saas`, sharing
  `scripts/saas-api-contract-test-support.mjs`) and the wrapper above.
- Limits: required properties, formats and enum candidates are sample-bounded
  inferences; non-JSON bodies exclude their transaction; one primary origin per
  contract; `verify` establishes body conformance, not business equivalence.
- Review fix pass (same increment, after an independent whole-branch review):
  `verify` now reports a `mediaType` finding when a matched operation answers
  with a media type the contract never recorded (an HTML fallback page used to
  pass), a `failed_request` finding for failed or unfinished replacement
  requests, `unexercised_operations`, and the replacement's completeness; it is
  `unknown` without a verified response body or on an incomplete capture, and an
  unmatched request line is a finding only with JSON evidence. `infer` counts
  failures under `x-rea-failures` instead of modeling them as `default`
  responses, admits empty bodies, records completeness per input, rejects
  duplicate captures and declared origins that admit nothing, and lists every
  sample's capture under `x-rea-evidence.captures`. Inference no longer emits a
  `format` or decimal `pattern` when any sample is empty or an impossible date,
  so a contract always accepts its own captures; `__proto__` members render as
  data; keys sort by code point. Contracts are read back with `JSON.parse` after
  the digest check, so deep schemas round-trip. The capture reader accepts REA's
  fully redacted empty URL spelling and validates `events.dropped`.

### Surface coverage, code versus observed

Commits: `dcce47743` (3591 pairing port), `bdb1ada14` (coverage library and
CLI), `128b1a1c9` (fixtures) and `f41990b26` (wrappers and fixture schema
checks); the wiring and documentation commit follows them.

- Adds `scripts/saas-surface-coverage.mjs` (`--static`, repeatable `--observed`,
  `--origins`, optional `--profile` with `--workflow-id`; exit 0 all declared
  exercised, 1 gaps, 2 invalid) with `scripts/lib/saas-surface-coverage.mjs`
  (reconciliation and report), `saas-surface-matching.mjs` (verbatim port of the
  target parsing, method inference, ws(s) origins, route-shape keys, pairing basis
  and classify rules of the unmerged branch `feat/3591-endpoint-traffic-comparison`,
  on the increment-1 `saas-route-templates` and `saas-ordering` mirrors),
  `saas-surface-families.mjs` (GraphQL, tRPC and route families plus undeclared
  aggregation), `saas-surface-inputs.mjs` and `saas-surface-observed.mjs` (strict
  readers for analysis results, api-surface views, scenario captures through
  `saas-scenario-capture`, and 3591 comparison results) and
  `saas-surface-report.mjs` (profile-schema experiments with deterministic
  priorities, limitation lines, profile merging through `saas-product-profile`,
  bounded file reading). The library is split into more files than the plan
  names so every module stays under the 500-line ceiling.
- Vocabulary: `scripts/saas-surface-matching.test.mjs` pins the owner's statuses
  (`matched`, `ambiguous`, `not-observed-in-capture`, `unknown`), bases and ten
  unknown reasons, so the port can be deleted once 3591 merges; the companion
  adds `target-unresolved`, `rpc-bodies-not-retained`,
  `rpc-link-base-undeclared` and `route-pattern-unsupported` for the families
  the owner never compares, and `operation-type-disagrees` as a GraphQL
  ambiguity. Target-less items are keyed by the full node id so no two share an
  experiment.
- Fixtures under `scripts/fixtures/saas-surface/`: the hand-authored
  `bundle/main.js`; `api-surface.json`, `scenario-capture.json`, `origins.json`
  and `profile.json` from `scripts/lib/saas-surface-fixture.mjs` through
  `scripts/saas-surface-fixtures.mjs` (`--check` compares committed bytes); and
  `static-analysis.json`, the bare `normalized_result` of
  `analyze_javascript_application` for the bundle with a repository-relative
  `input_path`, imported with `--import`. The committed analysis was produced on
  this Windows checkout, where the owned analysis worker needs the absent
  packaged native controls, by running the same application-layer analysis
  (`analyzeJavaScriptApplication` with the worker factory replaced by an
  in-process port over the worker's own domain steps); the guide documents the
  CLI command for regeneration. The analyzer reads `axios.get` as a candidate
  endpoint, so the bundle's customers call uses `fetch`.
- Regression owners: `scripts/saas-surface-matching.test.mjs`,
  `scripts/saas-surface-coverage.test.mjs`,
  `scripts/saas-surface-comparison.test.mjs` and
  `scripts/saas-surface-planning.test.mjs` (all in `npm run test:saas`, sharing
  `scripts/saas-surface-test-support.mjs`), `tests/boundary/cli/saasSurfaceCoverage.test.ts`
  (runs the suites, pins the route-shape keys to `compositeKey` and `segmentRule`,
  validates the planned experiments with Ajv against `profile.schema.json`) and
  `tests/boundary/filesystem/saasSurfaceFixtures.test.ts` (parses the committed
  fixtures with `javascriptApplicationAnalysisResultSchema`, the api-surface group
  schema, `browserScenarioCaptureSchema` and `commitBrowserScenarioNormalization`).
  The `.d.mts` beside `saas-surface-matching.mjs` exists for that TypeScript test.
- Limits: exact literal declarations only; GraphQL and tRPC need retained bodies
  or declared link bases; routes compare patterns with navigation pathnames; any
  incomplete observation turns absence into `unknown`; undeclared observed
  traffic is never a missing-code claim; on the committed fixtures the CLI exits
  1 by design (seven gaps).
- Review fix pass (same increment, after an independent whole-branch review):
  comparison verdicts are merged by rank whatever the `--observed` order, a
  better verdict replaces the displaced verdict's evidence instead of appending
  to it, and a complete comparison's not-observed verdict becomes `unknown` when
  any other input is incomplete; the `root_artifact_sha256` check covers every
  comparison collection, and verdict `method` and `target` fields are validated
  strictly (a target path with a query or fragment is rejected, nothing is
  copied unvalidated). GraphQL absence is claimed only when every input
  retained request bodies without truncation (truncated request bodies are
  counted under `body_incompleteness`) and a declared origin was exercised;
  persisted-query bodies match by `operationName` alone; names outside the
  GraphQL grammar are ignored instead of reaching a pattern or an error
  message. An api-surface page beyond the first or short of its group total is
  incomplete. Route literals with a query or fragment are
  `route-pattern-unsupported` and keyed by node, never echoed.

## Focused regression gates

Use the exact Node version in `.nvmrc` and npm version in
`package.json#packageManager` (at the hardening checkpoint: Node 24.18.0 and npm
11.16.0), then install the locked dependencies with `npm ci`.

The [SaaS compatibility workflow](../.github/workflows/saas-compatibility.yml)
runs on pushes to `main` and `feat/saas-behavior-compatibility`, and pull requests
targeting either branch. This covers upstream-integration PRs into the feature
branch and future direct `main` updates once the workflow is merged there. A push
tests the branch head; a PR tests GitHub's proposed merge result. These are
distinct integration checks, so both are retained, while superseded runs of each
kind are cancelled. The workflow has read-only contents permission, uses existing
pinned official actions, and has no secrets, deployment or repository-setting
changes. It intentionally does not invoke the complete repository test suite.

Run the same behavior checks locally:

```bash
npm run test:saas
npm run test:local -- \
  src/domain/browserScenarioDiff.test.ts \
  tests/conformance/managedSkillInventory.test.ts \
  tests/conformance/readmeConsistency.test.ts
node scripts/run-exact-tests.mjs run tests/boundary/filesystem/workflowActionPinning.test.ts
npm run test:focused -- \
  tests/boundary/cli/browserCli.test.ts \
  tests/boundary/mcp/browserScenarioMcp.test.ts \
  tests/boundary/cli/saasCompatibility.test.ts \
  tests/boundary/cli/saasCompatibilityLab.test.ts \
  tests/boundary/cli/saasProductProfile.test.ts \
  tests/boundary/cli/saasExportCompare.test.ts \
  tests/boundary/cli/saasApiContract.test.ts \
  tests/boundary/cli/saasSurfaceCoverage.test.ts \
  tests/boundary/filesystem/saasSurfaceFixtures.test.ts \
  tests/acceptance/setup/selectedSkillSetup.test.ts \
  tests/boundary/filesystem/setupSkill.test.ts \
  tests/boundary/filesystem/qwenClientConfiguration.test.ts
```

`test:focused` prepares the compiled runtime, packaged skill and the selected
tests' declared artifacts. It selects exact files and fails if they are missing;
do not replace it with a changed-file filter that could silently omit coverage.
Also run `npm run check:fast`, `npm run docs:check`, `npm run format:check`,
`npm run knip` and `git diff --check` before accepting an upstream integration.
Use the repository's broader CI and relevant real-provider lanes when the
upstream change requires them; the focused workflow is an additional gate.

### Combined upstream integration check

The supplemental [upstream integration workflow](../.github/workflows/saas-upstream-integration.yml)
checks one disposable candidate: the feature branch, then fork `main`, then
`morluto/rea` upstream `main`, using ordinary sequential merges. It never updates
those branches. Its controller runs outside the candidate and snapshots all
three source SHAs before fetching and merging them. For a push, the pushed
branch uses that event's exact SHA even if its remote ref has already advanced.
Other source refs are observed when the job starts; a result does not qualify
later changes.

The run summary records the clean controller commit/tree and source SHAs, observed remote heads,
merge bases, each merge's parents, final candidate commit/tree, toolchain and
executed checks. Missing refs, fetch errors, unrelated histories, merge conflicts,
changed candidate files and failing checks fail closed. `prepared` or `checking`
is incomplete evidence; only `passed` means every supplemental check finished.
Synthetic commits exist only in the disposable candidate repository.
The executing helper must be the tracked controller file. Reports stay outside
both checkouts; preparation does not replace an existing caller-owned report,
and a summary-rendering failure does not erase provenance. Cancellation forwards
SIGINT/SIGTERM to the active gate command, escalates after one second, and waits
for that command to settle before recording cancellation. GitHub's disposable
runner remains responsible for process-tree cleanup beyond that direct child.

The controller-owned command inventory preserves every existing SaaS workflow
check, adds capture/cancellation/cleanup regressions and its own Git-fixture
regressions, then runs `check:fast`, `docs:check`, `format:check` and `knip`.
Focused boundary tests prepare the compiled runtime and packaged skill. Exact
files must exist; changed-file selection and zero-test success are not used.
This gate does not replace the unchanged full CI/provider lanes or qualify a
real integration PR through their source-identity contracts. Review that PR and
its own CI before accepting the integration.

Triggers are fork pushes to `main` or `feat/saas-behavior-compatibility` and
manual dispatch. A push only to upstream does not trigger a workflow in this
fork. No polling schedule is installed. The workflow must be present on fork
`main` for main-push/manual activation, and GitHub Actions must be enabled;
adding this file on the feature branch alone does not establish that coverage.
No settings are changed by this addition. Before enabling repository Actions,
review inherited workflows too: `release.yml` can update release proposals on
main pushes, and general CI includes scheduled runs.

The new workflow has only read-only contents permission, pinned official actions,
no persisted checkout credentials, restored/shared dependency or build caches, secrets, artifact
downloads, publication or privileged PR triggers. It fetches only the fixed fork
and upstream repositories and offers no arbitrary URL/ref inputs. Candidate
installation and tests still execute repository code on the disposable runner;
the provenance report is diagnostic evidence, not a security attestation.

At the hardening checkpoint, 84 SaaS tests, five SaaS CLI tests and 45 browser
domain/CLI/MCP tests passed, alongside build/static/documentation checks. The
earlier full-suite run failed: 211 failures, of which two introduced skill
packaging failures were fixed and 209 were reproduced at the starting point.
The full suite was not rerun after those fixes or hardening. These are historical
local results, not a promise of current remote CI success or bug-free features.
All committed cases are synthetic; no Lightspeed or QuickBooks account was
accessed and no real vendor behavior was verified.

## Upstream integration record (2026-10-20)

Tested upstream: `morluto/rea` main `8716b5241125d81f1a16808eb5178fdfdea1ecdb`,
144 commits and 1,104 changed paths after the starting point `e4c3d7239`.
Integration: branch `integration/saas-upstream-2026-10-20`, created from the
feature head `5cf82999e` with `git merge --no-ff upstream/main`; merge commit
`00830ddf6c105ecb5bd4a73963cd8ac433044a4d`, tree
`b25cadbc34339795c61310934a9e74faccc6af59`. The commit adding this record
follows the merge on the same branch. Fork `main` was not merged separately: it
mirrors upstream main and was already contained in the tested upstream commit.

Conflicts: only `package.json` (`scripts`). Upstream extended `test:python` with
`bridge/pwndbg/test_core_context.py`, and the fork's adjacent `test:saas` entry
conflicted textually; the resolution keeps upstream's `test:python` and the
unchanged `test:saas`. `README.md`, the 20 translated READMEs and
`.agents/skills/reverse-engineer-anything/SKILL.md` merged automatically. After
the merge, the fork banner, every English fork notice, the fork's SKILL.md
section (next to upstream's version 44 bump), all 39 fork-only files and both
SaaS workflows were verified present; upstream's new files were taken unchanged.

Local gates on the merged tree (Windows 11 Pro 10.0.26100, Node 24.21.0,
npm 11.19.0; fresh `npm ci`, `turbo run compile --force`, `artifacts:skills`,
`artifacts:managed-evidence --force` and a generated product catalog):

- `oxfmt --check README.md docs/saas-change-ledger.md .github/workflows/saas-compatibility.yml`: passed.
- `npm run test:saas`: 84 passed.
- `npm run test:local -- src/domain/browserScenarioDiff.test.ts tests/conformance/managedSkillInventory.test.ts tests/conformance/readmeConsistency.test.ts`: 35 passed (29, 1 and 5).
- `node scripts/run-exact-tests.mjs run tests/boundary/filesystem/workflowActionPinning.test.ts`: 5 passed.
- Focused boundary lane, the nine `test:focused` files run through
  `node scripts/run-exact-tests.mjs run` because `test:focused` runs no tests
  on this host: 45 passed, 7 failed, 4 skipped. Six failures are the documented
  Windows-only test-side failures (three `qwenClientConfiguration` `stale`
  registrations; two `selectedSkillSetup` JSON path-containment assertions and
  one 30 s timeout), fixed on the fork branches
  `fix/windows-setup-test-portability` and
  `fix/windows-client-configuration-paths`. The seventh is upstream's
  `browserCli` parity case "runs analysis, session, WebMCP, screenshot, and
  comparison from explicit request scope": since upstream `9aca543f4`,
  `analyze_web_bundle` runs in an owned worker process, which on a Windows
  source checkout without `native/windows/build/` reports
  `capability_unavailable` ("REA Windows native controls are unavailable"). It
  failed identically when the file ran alone (13 passed, 1 failed), so it is
  environmental rather than a SaaS contract change. The four SaaS CLI files
  (5 passed), the fork's comparison cases in `browserCli` and
  `browserScenarioMcp` (2 passed, 20.5 s) passed.
- Browser lifecycle lane (six files): 98 passed, 1 failed, 2 skipped. The
  failure, upstream's `browserScenarioCleanup` case "retries a late Playwright
  open after cancellation before accepting another capture", passed 8/8 when
  its file ran alone (6 s); it is a timing flake under lane load in a file the
  fork does not modify. The skips are the `win32` skips of
  `browserScenarioCancellationCli`.
- `node scripts/run-exact-tests.mjs run tests/boundary/filesystem/saasUpstreamIntegration.test.ts`: 25 passed, 4 skipped (`win32` signal cases), 261 s.
- `npm run check:fast`: passed.
- `npm run docs:check`: exits 1 on this host before any check runs because
  `scripts/run-exclusive.mjs` requires the packaged Windows native controls
  (`native/windows/build/manifest.json`, absent in a source checkout). The
  wrapped pieces passed when run directly: `npx turbo run docs:check:built`
  (6 tasks) and `npm run test:local -- tests/conformance/readmeConsistency.test.ts`
  (5 passed).
- `npm run format:check` (4,536 files), `npm run knip` and `git diff --check`:
  passed. A `knip` run started while `compile --force` was rewriting `dist/`
  reported the `#javascript-analysis-worker` import as unresolved; it passed
  once the build had finished.

Remaining limitations: Node and npm were newer patch releases than the pinned
`24.18.0` and `npm@11.16.0`, so the combined CI candidate check was not
reproduced locally. Linux and macOS results come from the fork's SaaS workflows
after the feature branch is fast-forwarded; a push to the integration branch
alone triggers neither workflow. No full-suite, real-provider or vendor
behavior was verified.

## Safe upstream-sync procedure

1. Start with a clean working tree. Commit or otherwise preserve local work
   before integrating. Verify the feature head and a recoverable checkpoint on
   the intended remote; do not rely only on this file or a local tag. Do not
   reset, delete or force-push the feature branch to match upstream.
2. Inspect `git remote -v`. Confirm that `origin` is the intended fork and
   `upstream` is the intended upstream repository. If needed, add `upstream` only
   after verifying its URL (`https://github.com/morluto/rea.git` for this lineage).
   Fetch `upstream` and record the exact `upstream/main` SHA being integrated.
3. Create a new integration branch **from the current feature head**, not from
   upstream or the fork's `main`. Merge `upstream/main` there:

   ```bash
   git switch feat/saas-behavior-compatibility
   git rev-parse HEAD
   git fetch upstream
   git rev-parse upstream/main
   git switch -c integration/saas-upstream-YYYY-MM-DD
   git merge upstream/main
   ```

   Choose a new branch name for each attempt. A normal fork sync updates the
   selected fork branch; it does not verify these additions against upstream.

4. Resolve conflicts by retaining both upstream fixes and this inventory's
   behavior. Do not accept all of either side blindly. Inspect the origin-policy
   contract, CLI/MCP parity, evaluator semantics, export budgets, package scripts,
   skill inventory and focused workflow even when Git reports no conflict.
5. Run the focused commands above and applicable broader gates against the
   merged tree. Investigate failures; do not weaken assertions or hide unknown
   coverage to obtain a green check. Record the tested upstream SHA, integration
   SHA, commands, results and remaining limitations in the validation report.
6. Review the integration diff against the original base, the hardening
   checkpoint and the pre-sync feature head. For example:

   ```bash
   git diff --stat e4c3d72396bf925a45724ce8b18b238b0d23d787..HEAD
   git diff bbb9e40f8f314f240839099bcebefd2410116c7c..HEAD -- \
     'scripts/saas-*.mjs' 'scripts/lib/saas-*.mjs' 'scripts/lib/saas-*.d.mts' scripts/fixtures/ \
     'src/domain/browserScenario*' src/cli/browserAdvancedCommands.ts \
     src/contracts/browserToolContracts.ts src/application/SetupSkill.ts \
     .agents/skills/reverse-engineer-anything package.json \
     'tests/boundary/cli/saas*.test.ts' tests/boundary/cli/browserCli.test.ts \
     tests/boundary/mcp/browserScenarioMcp.test.ts \
     tests/conformance/managedSkillInventory.test.ts \
     .github/workflows/saas-compatibility.yml
   git diff feat/saas-behavior-compatibility..HEAD
   ```

   Review upstream-driven changes deliberately; checkpoint differences are not
   automatically regressions. Confirm this feature inventory still holds.

7. Bring only reviewed integration changes back through the normal PR/merge
   process into the feature branch. Keep `main` unchanged unless its separate
   PR is reviewed and merging is explicitly approved. Update this ledger with
   the accepted integration SHA and preserve the previous checkpoints.

Passing tests reduce regression risk; they do not guarantee that an arbitrary
future fork sync is safe. Preserve history, review conflicts and verify behavior
at every integration.
