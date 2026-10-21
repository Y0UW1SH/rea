# SaaS fork validation

## Evidence correctness repairs — 2026-10-21

Validated on Linux with pinned Node **24.18.0** and npm **11.16.0**, starting
from feature commit `6ace48d0679399f92ab04a2f6ddd7e02a3261fc2`.

- `npm run test:saas`: **148 passed**. Regressions cover foreign-origin and
  ambiguous GraphQL candidates, same-name documents, operation-specific variables
  and responses, sparse required coverage, APQ-only identities, numeric conversion
  loss, unidentified reference requests and redacted reference responses.
- Environment application/source/server suites, scenario-capture record suite,
  and HTTP server/bridge suites via `npm run test:local`: **183 passed, 1 skipped**
  across 17 files. The existing directory-permission test skips when run as root.
  Strict replay cases exercise complete path/query/body matching, conflicting
  outcomes, body bounds, request omissions, scenario evidence and real MCP clients.
  Raw HTTP cases reject rounded numbers and preserve session usability; strict
  parsing also passes oversized-upload, session-termination and shutdown cases.
- `npm run test:focused` for the SaaS contract/surface CLI, environment serve/export
  CLI, environment MCP and surface filesystem boundaries: **27 passed** across
  6 files, with runtime/skill artifacts built for the selected tests.
- `npm run check`: passed typecheck, build, lint (**0 errors**, repository-wide
  warnings remain), formatting, knip, metadata and architecture guards.
- `npm run docs:check`: passed, including **5 README consistency tests**.
  Final formatting and `git diff --check` also passed.
- One fresh independent review found four issues in the first implementation:
  APQ numeric representation, raw MCP number rounding, batch/scalar discovery
  schemas and lost reference-response uncertainty. Each received a regression
  and correction; targeted failures were observed before the fixes passed.

No live QuickBooks, Lightspeed or other SaaS account was accessed. Hosted CI,
the complete repository test suite, cross-platform behavior and performance
comparisons were not run for this repair. The tests establish synthetic evidence
handling and local CLI/MCP behavior. Static GraphQL transport linkage, GET GraphQL
operation verification, actor/header matching and mutable replay state remain
unimplemented and explicitly uncertain. Strict mode adds bounded request parsing
and candidate matching; no CPU, memory, latency or token-efficiency claim is made.

## Surface coverage increment

The surface-coverage companion (`scripts/saas-surface-coverage.mjs`, see the
[guide](saas-compatibility.md#reconcile-the-declared-bundle-surface-with-observed-traffic))
was built on the contract increment head with Node **24.21.0** and npm
**11.19.0** on Windows 11 Pro 10.0.26100:

- `npm run test:saas`: **139 passed** (110 existing plus 10 matching, 11
  coverage, 5 comparison and 3 planning cases). The matching cases pin the 3591
  status, basis and reason vocabulary and port the owner's target, method,
  WebSocket, route-shape, pairing and classification cases. The coverage cases
  reconcile the synthetic bundle declarations against the api-surface view and
  the capture (every family; evidence ordinals, transactions and steps;
  undeclared traffic; experiment ids, priorities and texts; two-run
  determinism; query strings never echoed), fail closed on malformed inputs
  while tolerating envelope extras, turn absence into unknown under incomplete
  coverage, fold replacement origins through origin pairs, and, written after
  the independent review and watched failing first, claim GraphQL absence only
  when every input retained untruncated bodies on an exercised declared origin,
  read persisted-query bodies by `operationName` while ignoring names outside
  the GraphQL grammar, treat an api-surface page beyond the first or short of
  its total as incomplete, and never echo a route literal with a query. The
  comparison cases adopt a complete 3591 comparison result, list its unmatched
  groups as undeclared, reject partial pages, merge several results by rank in
  any flag order, turn a comparison absence into unknown beside an incomplete
  input, validate verdict methods and targets strictly and reject foreign
  digests for every collection. The planning cases merge experiments into the
  generic profile without overwriting existing ones, map the CLI exit codes,
  byte-check the committed fixtures and prove that the real analysis of the
  committed bundle reaches the same statuses as the synthetic declarations (17
  endpoint nodes, seven gaps).
- `node scripts/run-exact-tests.mjs run tests/boundary/cli/saasSurfaceCoverage.test.ts tests/boundary/filesystem/saasSurfaceFixtures.test.ts`:
  **8 passed**. Route-shape keys equal `compositeKey` over `segmentRule` tuples;
  the CLI plans seven experiments that Ajv validates against
  `profile.schema.json`; the committed static analysis parses with
  `javascriptApplicationAnalysisResultSchema` and reports exactly the committed
  bundle's bytes, the api-surface groups parse with the view schema, the
  capture with `browserScenarioCaptureSchema`, the origins through
  `commitBrowserScenarioNormalization`, and the profile against the schema.
- `tests/boundary/filesystem/saasUpstreamIntegration.test.ts`: **25 passed, 4
  skipped** (Windows signal cases), including the workflow/CI command mirror
  case with both new wrappers.
- `npx tsc --noEmit`, `npm run knip`, `npm run lint` (0 errors; the new files
  add no warnings), `npm run format:check`, `node scripts/check-doc-facts.mjs`
  and `git diff --check`: passed.
- Not run here: the fork's hosted workflows (Actions remain disabled), the real
  CLI on the bundle (this host lacks the packaged Windows native controls, so
  the committed analysis came from the same application-layer analysis run
  in-process, as the ledger records) and any real capture. All fixtures are
  synthetic and prove the companion, not any vendor product.

## API contract inference increment

The contract companion (`scripts/saas-api-contract.mjs`, see the
[guide](saas-compatibility.md#infer-and-verify-api-contracts-from-captures))
was built on the integrated feature head with Node **24.21.0** and npm
**11.19.0** on Windows 11 Pro 10.0.26100:

- `npm run test:saas`: **110 passed** (84 existing plus 15 helper, 6 contract and
  5 review-pass cases). The contract cases cover deterministic fixtures equal to
  their builder, fail-closed manifest validation, the inferred OpenAPI document
  and coverage report (including that a sentinel header value never appears in
  any output byte and that `enum` is never emitted), missing-content,
  tampered-digest, over-budget and traversal inputs, `verify`
  pass/fail/unknown/invalid outcomes with every finding kind, and the CLI exit
  codes. The review-pass cases, written after an independent whole-branch review
  and watched failing first, cover HTML or other media types answering a matched
  operation, replacements without response bodies or with an incomplete capture,
  failed and unfinished requests on both sides, every reference capture verifying
  against its own contract (including fourteen-level nesting, empty strings and
  impossible dates), empty `204` bodies, declared origins that admit nothing,
  duplicate captures and evidence truncation.
- `node scripts/run-exact-tests.mjs run tests/boundary/cli/saasApiContract.test.ts`:
  **6 passed**, including parity of the companion mirrors with
  `segmentRule`/`scanRouteTemplate` (uppercase hex, leap days), `mediaTypeEssence`
  (tab and non-breaking-space padding), `parseRecordedTransportUrl` (IPv6,
  bare `@`, backslashes, non-special schemes), `commitBrowserScenarioNormalization`
  and `projectScenarioOrigins`, and `browserScenarioCaptureSchema` acceptance of
  all four committed fixtures.
- The workflow/CI command mirror case of
  `tests/boundary/filesystem/saasUpstreamIntegration.test.ts`: **1 passed**.
- `npx tsc --noEmit`, `npm run knip`, `npm run lint` (0 errors),
  `node scripts/check-doc-facts.mjs`, `npm run format:check` and
  `git diff --check`: passed. `oxlint` reports only max-params,
  max-lines-per-function and one complexity warning on the fixture builder, the
  GraphQL recorder, the verify loop, the transaction assembler and the inference
  test, within the repository's warning-only policy.
- Not run here: the fork's hosted workflows (Actions remain disabled) and any
  real capture. The committed captures are synthetic and prove the companion,
  not a vendor API; the Playwright response-body provenance caveat is quoted in
  every produced report.

## Latest upstream integration check

A local integration on branch `integration/saas-upstream-2026-10-20` merged the
portable companion-suite feature head
`5cf82999e904ed8039be9ea2057bf14b702780f6` with upstream `morluto/rea` main
`8716b5241125d81f1a16808eb5178fdfdea1ecdb`, 144 commits and 1,104 changed
paths after the starting point. The merge commit is
`00830ddf6c105ecb5bd4a73963cd8ac433044a4d`, tree
`b25cadbc34339795c61310934a9e74faccc6af59`; the commit adding this record
follows it. Only `package.json` conflicted: upstream's extended `test:python`
next to the fork's `test:saas`, both kept. The README banner, all 20 translated
fork notices, the fork's SKILL.md section, all 39 fork-only files and both SaaS
workflows were verified after the merge. These are local verification commits;
publication and the feature-branch fast-forward are separate steps verified
against the remote, not by this file.

Using Node **24.21.0** and npm **11.19.0** (newer patch releases than the pinned
24.18.0 and 11.16.0) on Windows 11 Pro 10.0.26100, with a fresh locked
`npm ci`, `turbo run compile --force`, `artifacts:skills`,
`artifacts:managed-evidence --force` and a generated product catalog:

- SaaS suite: **84 passed**.
- Origin policy, authored skill inventory and README consistency: **35 passed**
  across three files.
- Workflow action pinning: **5 passed**.
- Focused CLI/MCP/installer lane (nine files): **45 passed, 7 failed, 4
  skipped**. Six failures are the documented Windows-only test-side failures
  (three Qwen `stale` registrations; two `selectedSkillSetup` JSON
  path-containment assertions and one 30 s timeout), already fixed on the
  fork's `fix/windows-setup-test-portability` and
  `fix/windows-client-configuration-paths` branches. The seventh is upstream's
  browser CLI parity case: since upstream `9aca543f4`, `analyze_web_bundle`
  runs in an owned worker process, which on a Windows source checkout without
  `native/windows/build/` reports `capability_unavailable` ("REA Windows
  native controls are unavailable"). It failed identically when its file ran
  alone (**13 passed, 1 failed**) and is environmental. The four SaaS CLI
  files (**5 passed**), the fork's browser comparison cases and
  `browserScenarioMcp` (**2 passed**, 20.5 s) passed.
- Browser scenario capture, cancellation and cleanup lane (six files): **98
  passed, 1 failed, 2 skipped**. The failing upstream cleanup-retry case passed
  **8 of 8** when its file ran alone (6 s), so it is a load-timing flake; the
  skips are the `win32` skips of the CLI cancellation test.
- Fork integration helper regressions: **25 passed, 4 skipped** (`win32`
  signal cases).
- `npm run check:fast`: passed.
- `npm run docs:check`: the `run-exclusive` wrapper exits 1 on this host
  because it requires the packaged Windows native controls; run directly,
  `turbo run docs:check:built` (**6 tasks**) and README consistency
  (**5 passed**) passed.
- `npm run format:check`, `npm run knip` (on the built tree) and
  `git diff --check`: passed.

No full-suite, real-provider or vendor behavior was verified. Linux and macOS
results for this integration come from the fork's SaaS workflows once the
feature branch is fast-forwarded; a push to the integration branch alone does
not trigger them. The [change ledger](saas-change-ledger.md) records the
conflict resolution and command list.

## Previous upstream integration check (2026-10-19)

An isolated local integration combined feature checkpoint
`2a1fff7bc57951ed0857349ad8d9a18ca56c133d` with upstream `morluto/rea` main
`255d906e15a141b0f4acee60dc73976f03adc94c`. Fork main remained
`e4c3d72396bf925a45724ce8b18b238b0d23d787`. Upstream had 27 new commits changing
234 files. The merge was clean: all 68 feature-only paths and 233 upstream-only
paths were preserved exactly; the shared `package.json` retained both upstream's
new worker import and the SaaS test command.

The initial local merge was `628e9e845fcf449026bb9276b1fc4bd10aeeb274`.
Documentation verification then caught a regression in the feature checkpoint:
the English-only README ledger link violated translated README link parity.
Moving that link to the existing SaaS guide fixed the gate without weakening its
checks. The repaired local integration is
`4050ffc5b6d6e14d3737a85f4d6c9bfc067ba342`, tree
`a978921841c5e02049a5dff5c10d3d4a90e380dc`. These are local verification commits,
not a claim that either main branch was updated or the integration was published.

Using Node **24.18.0**, npm **11.16.0**, and a fresh locked `npm ci`:

- SaaS suite: **84 passed**.
- Every surviving upstream-changed test plus the feature boundary/installer
  selection: **1,508 passed, 5 failed, 9 skipped across 124 files**.
- Six additional browser scenario capture, cancellation and cleanup files:
  **85 passed**, including CLI SIGINT/SIGTERM cleanup.
- All five failures were in `ghidraOomRetention.test.ts`. The identical five
  test failures reproduced on pristine upstream `255d906e1`; both runs show
  `listen EPERM` for the fixture's Unix socket. This is fresh baseline evidence,
  separate from the older full-suite failure inventory below.
- Fresh runtime/skill build, `npm run check` (typecheck, lint, formatting, knip,
  metadata and architecture guards), and **81 Python tests** passed.
- `npm run docs:check` failed before the README-link repair and passed afterward,
  including five README consistency tests. It also passed on pristine upstream.
- `git diff --check` passed. No current full-suite or live-provider result is
  inferred from this changed-surface selection.

The independent review found no merge-specific runtime defect and identified the
additional browser lifecycle lane above. Real Chromium, Lightspeed, QuickBooks,
and other installed-provider behavior remain unverified. GitHub Actions activation
and remote CI are separate from these local results; see the
[change ledger](saas-change-ledger.md) for trigger and upstream-sync limits.

## Current hardening follow-up

The follow-up preserves the complete feature branch and tightens its numeric and
export evidence boundaries:

- The workflow evaluator rejects unsafe integer values and original JSON numeric
  tokens that would lose precision, underflow or overflow. Safe ordinary numbers
  remain supported; exact larger values can be supplied as strings.
- Export policies are privately snapshotted before asynchronous reads and capped
  at 1 MiB of compact JSON. Reports are capped at 16 MiB including UTF-8 escaping,
  indentation and the final newline, before full serialization. Over-budget
  reports are explicitly invalid and retain the admitted policy and provenance.
- Invalid UTF-8 preserves the successfully read file's byte count and SHA-256.
  Oversized diagnostic text is explicitly omitted without dropping that evidence.

New numeric and export regressions failed before their fixes. Independent review
found a caller-mutation bypass in the first report-budget implementation; the
private policy snapshot fixes it, with a regression. Final independent review
found no remaining new actionable defect. Additional review probes checked
30,000 numeric tokens and 20,000 exact serialized-byte boundaries.

Final targeted verification used Node **24.18.0** and npm **11.16.0**:

- `npm run test:saas`: **84 passed** (27 evaluator, 19 lab, 11 profile, 27 export).
- SaaS CLI boundary checks: **5 passed across four files**.
- Browser comparison domain/CLI/MCP coverage: **45 passed across three files**.
- `npm run build:cached`: passed (all three build tasks cached).
- `npm run check:fast`, `npm run format:check`, `npm run knip`: passed.
- `npm run docs:check`: passed, including **5** README consistency tests.
- `git diff --check`: passed.

The complete repository suite was not rerun for this small follow-up. The earlier
full-suite outcome and baseline reproduction below remain historical evidence,
not a claim that the current full suite is green. No real vendor behavior was
validated. The evaluator's existing `-0` versus `0` mismatch is also unchanged:
JSON report serialization renders both values as `0`, although comparison still
distinguishes them.

## Initial full-suite result and limits

The shared SaaS additions passed their focused tests and independent code review.
The repository-wide `npm run check:pr` **did not pass** in this cloud workspace.
Its completed pre-fix run reported **19,478 passed, 211 failed, 170 skipped** tests
across **1,622 files** (1,561 passed, 42 failed, 19 skipped), in 45m38s.

Two failures exposed an introduced skill packaging omission. Both are fixed:

- The installer now includes `references/cloud-compatibility.md` in its managed
  inventory, so setup actually installs the new instruction reference.
- The portable skill-commitment test includes the new file in its sorted digest.
- A new recursive authored-file inventory regression prevents another omission.

After rebuilding, all **36** selected skill install, rerun, repair, filesystem and
inventory tests passed. The full 45-minute suite has not been repeated after this
fix; do not interpret focused success as a green full-suite result.

The other **209** failures were reproduced on the original baseline
`e4c3d7239` in a separate worktree, using the same pinned runtime. No unrelated
provider/process behavior was changed to suppress them. The file-level inventory
below records matching baseline counts, rather than claiming one explanation for
all failures.

## Commands and successful gates

Runtime: Node **24.18.0**, npm **11.16.0**, Linux cloud workspace.

- `npm run test:saas`: **75 tests passed** (24 evaluator, 19 executable lab,
  11 profile, 21 export).
- Export and lab CLI boundary tests: **3 passed**.
- Post-fix `npm run build` and `npm run docs:check`: passed, including five
  README consistency tests.
- Post-fix skill scope: **36 passed**, using
  `vitest run tests/acceptance/setup/selectedSkillSetup.test.ts
  tests/boundary/filesystem/setupSkill.test.ts
  tests/conformance/managedSkillInventory.test.ts
  tests/boundary/filesystem/qwenClientConfiguration.test.ts`.
- `npm run check:fast`, `npm run format:check`, `npm run knip`: passed.
- `npm run test:python`: **81 passed**.
- `npm run jscpd` and `npm run scan:todos`: passed.
- Earlier origin policy/domain, compiled CLI and MCP focused tests passed;
  their full-suite lanes also passed. Tests include undeclared/deceptive origins,
  non-URL values, evidence gaps and input immutability.

Because `check:pr` short-circuits after its failing test lane, downstream Python,
documentation, duplicate-code and TODO gates were also run separately. Independent
review covered exact comparisons, missing evidence, typed identity, parsing
budgets, file mutation checks, fault injection and the skill packaging repairs.

## Baseline failure evidence

Observed categories include:

- Unix-domain socket creation refused with `listen EPERM`, affecting many
  Hopper/Ghidra bridge and lease fixtures and the special-filesystem fixture.
- Named-user home creation refused with `EROFS`.
- Chromium exits with `SIGABRT` and crashpad filesystem diagnostics.
- Snapshot/cancellation/replay assertion differences also present on baseline.
  Baseline reproduction establishes these predate this fork; their underlying
  cause was not fully diagnosed in this task.
- The release-canary test's nested `npm pack` inherited an unwritable home cache
  in the Turbo run. Baseline reproduced its identical cache-path failure when
  given that cache setting. Direct runs with the writable temporary npm cache
  pass; this is a runner configuration distinction, not a source-code repair.

The following current-run failure counts were reproduced at baseline:

| Test file                                                                | Failures on each revision |
| ------------------------------------------------------------------------ | ------------------------: |
| `src/hopper/HopperTargetLease.test.ts`                                   |                        12 |
| `src/process/capture/ProcessCaptureObservation.test.ts`                  |                         1 |
| `tests/acceptance/applications/artifactComparisonCoverage.test.ts`       |                         1 |
| `tests/acceptance/applications/hopperPublisherRejectionCli.test.ts`      |                         1 |
| `tests/acceptance/setup/hermesClientSetup.test.ts`                       |                         1 |
| `tests/boundary/browser/cdpSvgXlinkHref.test.ts`                         |                         3 |
| `tests/boundary/filesystem/directAnalysisSnapshotReplay.test.ts`         |                         1 |
| `tests/boundary/filesystem/flutterBuildProvider.test.ts`                 |                         1 |
| `tests/boundary/mcp/ghidraInventoryMcp.test.ts`                          |                         1 |
| `tests/boundary/mcp/ghidraReopen.test.ts`                                |                         3 |
| `tests/boundary/mcp/ghidraStartupCancellationMcp.test.ts`                |                         2 |
| `tests/boundary/mcp/processSnapshotCleanupMcp.test.ts`                   |                         1 |
| `tests/boundary/process/binarySessionCleanupRetry.test.ts`               |                         2 |
| `tests/boundary/process/processCaptureLifecycle.test.ts`                 |                         1 |
| `tests/boundary/process/processCaptureProgress.test.ts`                  |                         1 |
| `tests/boundary/process/releaseArtifactCanary.test.ts`                   |                         1 |
| `tests/boundary/providers/ghidra/ghidraClient.test.ts`                   |                        66 |
| `tests/boundary/providers/hopper/bridgeLauncher.test.ts`                 |                         3 |
| `tests/boundary/providers/hopper/hopperArguments.test.ts`                |                         1 |
| `tests/boundary/providers/hopper/hopperBridgeReconnect.test.ts`          |                         1 |
| `tests/boundary/providers/hopper/hopperClient.cleanup.test.ts`           |                         5 |
| `tests/boundary/providers/hopper/hopperClient.deadlines.test.ts`         |                         4 |
| `tests/boundary/providers/hopper/hopperClient.diagnostics.test.ts`       |                         1 |
| `tests/boundary/providers/hopper/hopperClient.externalExit.test.ts`      |                         2 |
| `tests/boundary/providers/hopper/hopperClient.handshakeRecovery.test.ts` |                         7 |
| `tests/boundary/providers/hopper/hopperClient.health.test.ts`            |                         5 |
| `tests/boundary/providers/hopper/hopperClient.helperFailure.test.ts`     |                         5 |
| `tests/boundary/providers/hopper/hopperClient.progress.test.ts`          |                         5 |
| `tests/boundary/providers/hopper/hopperClient.protocol.test.ts`          |                        18 |
| `tests/boundary/providers/hopper/hopperClient.restart.test.ts`           |                         2 |
| `tests/boundary/providers/hopper/hopperClient.startupFailures.test.ts`   |                         3 |
| `tests/boundary/providers/hopper/hopperClient.startupWaiters.test.ts`    |                         8 |
| `tests/boundary/providers/hopper/hopperRegexFailure.test.ts`             |                         6 |
| `tests/boundary/providers/hopper/hopperVerificationCleanup.test.ts`      |                         2 |
| `tests/boundary/providers/startupCloseWaiters.test.ts`                   |                         2 |
| `tests/boundary/setup/linuxHopperPublisherVerification.test.ts`          |                        17 |
| `tests/process-global/filesystemSnapshotFallbackCancellation.test.ts`    |                         2 |
| `tests/process-global/filesystemSnapshotRaces.test.ts`                   |                         4 |
| `tests/process-global/hopperLeaseDescriptorPermissions.test.ts`          |                         1 |
| `tests/process-global/hopperRegexFailureCli.test.ts`                     |                         6 |

## Product coverage boundary

All committed data is synthetic. No Lightspeed or QuickBooks account was accessed
or live vendor behavior verified. The lab demonstrates independent local state
implementations and seeded defect detection, not vendor compatibility. Browser
download cancellation remains unchanged; offline export comparison does not
claim a browser transfer limit or a hostile-filesystem sandbox.

See [the usage and scope guide](saas-compatibility.md) for supported commands,
implemented features, evidence semantics and remaining edition/access-dependent
work. Remote GitHub checks are not claimed to have run successfully merely
because these local checks ran.
