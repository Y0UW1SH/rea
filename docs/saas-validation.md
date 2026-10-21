# SaaS fork validation

## Fork guard placement — 2026-10-21

The earlier guards edited every inherited job, including the CI provider
callers whose `if:` lines sit next to upstream's new `secrets:` mappings. A
local `git merge-tree --write-tree` of the guarded head with upstream
`01788bac863ac786bfbb648cad69b11e23b40a89` conflicted in
`.github/workflows/ci.yml` and `tests/boundary/filesystem/ciRequiredLanes.test.ts`,
while the feature base alone merged cleanly, so the conflict came from the
guard edits rather than from upstream's CI redesign.

Guards now sit only on entry jobs and status-function jobs (41 jobs in 31
files); the 28 dependents that GitHub already skips with their fork-skipped
dependencies are restored to their upstream text. The inventory regression
first failed on exactly those 28 redundant guards, then passed after the
restoration. The same `merge-tree` probe of the change now exits 0. Applied
to the merged workflows, the regression accepts upstream's new `static-deep`
job unchanged and reports only upstream's new `cache-retention.yml` entry
job, which needs a guard when that merge is resolved.

## Cancellation, study inventory and signed-zero repairs — 2026-10-21, 15:45 UTC

These repairs start from published PR #4 head
`a80bf7fe8126e27d32086236827e1c76850bbf61`. The final tested source is
`871d3e85bd0e05dfda0b69d5f147116de300edd8`, tree
`df0fea133ca1b9092e01a4479bd4dfb382ff4dd2`. The production repair is
`f0378fb3395545d85c5a7ebb5e71ac30b5316458`; subsequent test-only fixes make
isolated study fixtures independent of the surrounding checkout and bind the
real workflow mirror to the explicit candidate root. This receipt is a subsequent
validation-document-only change.

### Source validation

Linux checks used Node **24.18.0**, npm **11.16.0**, the previously locked install
with unchanged package-lock/dependencies, and writable caches.

- **451 selected tests passed**: 164 SaaS, 35 domain/inventory/README,
  27 guard/action-pinning, 70 CLI/MCP/setup, 101 browser/lifecycle and
  54 combined-helper tests. The signed-zero regression is explicitly included
  in `test:saas`, which both SaaS workflows execute. Production code is unchanged
  since that selection; all 54 helper cases and the full static inventory were
  rerun after the final test-only correction.
- The full static inventory passed with the serial command below: six Turbo
  tasks, followed by architecture guards. Generated docs also passed, including
  five README tests. Lint warnings remain; no checks or diagnostics were
  suppressed. These are source-tree results, not a successful current-upstream
  combined run.
- The existing owned-runner cancellation suite separately passed **6 tests**
  with **5 platform/condition skips**. Real-npx SIGINT/SIGTERM regression tests
  failed before the fix when bounded descendants wrote after helper exit.
  Independent probes now pass for both signals, a TERM-ignoring descendant and
  a nested owned-command supervisor. The tested cleanup retained ownership for
  approximately one second before forced group termination. Arbitrary hostile
  detached-process containment and Windows/macOS execution were not established.
- All three signed-zero regressions failed on the original PR head and pass on
  the repair. Independent checks passed eight adversarial CLI cases, 300 JSON
  round-trips, and exact 16 MiB/+1-byte report-boundary probes. Numeric types,
  literal strings and comparison verdicts remain unchanged.
- Final review reproduced a CI-only mirror-test failure when GitHub's outer
  `GITHUB_WORKSPACE` differed from the candidate checkout. The regression now
  supplies an empty outer workspace and resolves the real-source command list
  from the explicit repository root. All 54 helper tests pass with the actual
  environment also pointing outside the checkout; fixture authority defaults
  remain unchanged. Independent recheck confirms the repair.
- Independent review found no remaining actionable repair issue. An initial fixture setup
  used a directory-only Git ignore for a dependency symlink; that fixture was
  corrected, then all 54 helper cases passed. No production check was weakened.

```bash
GOMAXPROCS=1 GOMEMLIMIT=768MiB UV_THREADPOOL_SIZE=1 HUSKY=0 \
  node scripts/run-exclusive.mjs artifacts node_modules/.bin/turbo run \
  typecheck lint:built format:check knip metadata:check --concurrency=1
npm run verify:architecture-guards
npm run docs:check
```

### Separate study-PR combination

A temporary combination with PR #3 head
`94beecf6f4b001006a24a59e7b12c6ba6891da75` was checked at tree
`79d969e961d7907ae7f183fb8b911ca281d88ccb`. Its sole merge conflict was the
`package.json` `test:saas` line: the temporary resolution retains both the new
report regression and the study suite. All **10 study-only** and **66 fix-branch-only**
paths preserve their source Git blob/mode entries exactly; the shared workflow,
docs and package script retain both additions.

The combination passed **83 helper/study/guard/pinning tests** and **175 SaaS
script tests**. These overlap source coverage and are not additional unique
source-test totals. The complete workflow-command mirror now passes with the
study CLI included. This is bounded interaction evidence, not a full validation
or import of PR #3; its branch and PR were not changed.

### Current-base and upstream qualification

During validation, the feature base advanced to
`87a3ee21748bde3a9cdae7e595b0a5540a7e8416`. That change only clarifies live
capture versus offline evaluation in `docs/saas-compatibility.md`; its merge with
the repaired source is clean. A fresh simulated PR controller
`1c981d23fdd894331ac804074ae4b9bbc9fecae3`, tree
`f1c56f058f41efb133774e184513ab8af117ce6b`, has ordered parents consisting of
that exact new base and tested source `871d3e85`.

Using fixed Git-object mirrors, the supplemental gate selected that event merge,
fork main `1c2c2f1e78a74cdf5e4909ab8e775b090998a51f`, and upstream
`f86206535f8ec71014781f9d432a84b01e183e5d`. It **failed closed at the upstream
merge**, with the same two conflict paths:

- `.github/workflows/ci.yml`
- `tests/boundary/filesystem/ciRequiredLanes.test.ts`

**Zero candidate check stages ran.** No conflict was suppressed or broadly
resolved in this three-fix change. Earlier successful combined runs below remain
bound to their historical snapshots. No hosted CI, full repository suite,
Windows/macOS runtime, live vendor behavior or globally safe Actions activation
is claimed. Publication, merging, activation and repository settings are separate
from these local results.

## Fork workflow guards — 2026-10-21, 14:48 UTC

This follow-up to draft PR #4 starts from published head
`a72d9c3e57100bb561313c5fb0de1729f702640d`. The tested implementation is
`c3cd49eeccc33a1963f1b8c9ab54bf3f99c89bac`, tree
`fb5cfade64b9630d5dbcdbb86dca6ab07110be49`; this receipt is a subsequent
validation-document-only change. The feature base remains
`90fb608273d8dac36d5c3c0cc6cf64081aabcc45`.

### Current source checks

Linux validation used locked `npm ci`, Node **24.18.0**, npm **11.16.0** and
writable caches. The full serial static command recorded below passed again,
followed by architecture guards, generated docs and test discovery (**1,834
files**, each discovered once). Static checking reported zero lint errors with
existing-style warnings; no warnings or checks were suppressed.

- The new inventory regression initially failed on the **69 inherited jobs**
  with **19 fixture cases passing**. The final **22 guard tests** passed, covering
  missing/step-only guards, reusable jobs, `always()`, OR escape, malformed
  expressions/YAML and the exact two SaaS job exceptions. Action pinning added
  **5 passing tests** in the same selected lane.
- All selected source lanes passed: **161 SaaS**, **35 domain/inventory/README**,
  **27 guard/pinning**, **70 CLI/MCP/setup**, **101 browser/lifecycle** and
  **47 combined-helper** tests (**441 total**). These ran against the source
  tree, not a successfully merged newer-upstream candidate. Docs separately
  reran **5 README tests**.
- The broader affected workflow selection passed **378 tests across 10 files**,
  including CI events, scope, required lanes, feedback, cache/report handling,
  mutation, release/recovery and the same 47 helper tests. This count overlaps
  the selected lanes and is not an additional unique-test total.
- An initial raw-Node workflow run lacked the npm CLI environment required by
  the existing static-context fixture (**377 passed, 1 failed**). The complete
  selection passed with `npm_execpath` pointing at the pinned npm CLI. An
  overlapping artifact command was refused before the boundary tests started;
  the affected selected lanes were rerun successfully after the lock released.
- Independent parsed-YAML review verified all **31 inherited workflow files**:
  each of **69 job conditions** retains its entire original predicate under the
  fork exclusion, including **15 reusable callers** and **7 status-function
  jobs** (4 with `always()`). Other inherited YAML structure is identical to the
  published parent. Both SaaS jobs remain unconditional. Independent code and
  documentation review found no actionable issue.

### New upstream snapshot is blocked, not qualified

A fresh local exact-object rehearsal used the same PR event validation with
feature base `90fb608273d8dac36d5c3c0cc6cf64081aabcc45`, implementation head
`c3cd49eeccc33a1963f1b8c9ab54bf3f99c89bac`, and simulated PR merge controller
`67e8fc122820d15093f2c2dac89f22e4766eab6e` (tree
`fb5cfade64b9630d5dbcdbb86dca6ab07110be49`). Frozen Git mirrors held fork main
`1c2c2f1e78a74cdf5e4909ab8e775b090998a51f` and newly fetched upstream main
`6d356b84344659085f2b912857b5e27fe0160c9b`.

Preparation **failed closed at `merge:upstreamMain`**, with conflicts in
`.github/workflows/ci.yml` and
`tests/boundary/filesystem/ciRequiredLanes.test.ts`. Upstream changed the same
provider-lane CI/test area, including new reusable-workflow secret mappings.
The report has **zero executed candidate check stages**; there is no qualified
combined candidate for this snapshot. This scoped follow-up does not integrate
that broader upstream CI redesign. The earlier 11-stage success below remains
historical evidence for its own exact snapshot only.

The code guards apply only to revisions carrying them; unguarded `main` and
concurrent newly added jobs remain activation risks as described in the
[change ledger](saas-change-ledger.md#fork-workflow-job-guards-2026-10-21).
No hosted Actions pass, full repository suite, Windows/macOS execution, live
vendor validation, repository-wide activation safety or merge is claimed.

## Stage 1 sync hardening — 2026-10-21

This draft increment starts from SaaS feature commit
`f9fcd4305d3a7bccebf822a68c0294cbf2d0afd5`. The tested implementation is
`8e8f30bc42a8b3f25f3f9bd818c33abd946ebce8`, tree
`17d4917d6c0533326f2a41349b6dde313043fb11`; this validation record follows
as a documentation-only change. Existing API-contract, surface-coverage,
GraphQL identity and strict-replay implementations remain unchanged.

### Source-branch checks

Validation used Linux, pinned Node **24.18.0** and npm **11.16.0**, locked
`npm ci`, a writable npm cache, and the repository's artifact locking. Static
tasks ran serially with `GOMAXPROCS=1`, `GOMEMLIMIT=768MiB` and
`UV_THREADPOOL_SIZE=1` to limit this runner's resource use. The exact command was
`node scripts/run-exclusive.mjs artifacts node_modules/.bin/turbo run typecheck lint:built format:check knip metadata:check --concurrency=1`,
followed by `npm run verify:architecture-guards`: **passed**. This preserves the
full `npm run check` task inventory while changing only scheduling; it is not a
claim that the literal parallel command was run. A local Turbo cache was shared
between rehearsals, and unchanged tasks could be restored from that cache.

- `npm run test:saas`: **153 passed**, including all newer API/surface cases and
  five added UTF-8/Unicode regressions.
- `npm run docs:check`: **passed**, including **5 README consistency tests**.
- Regression-first checks: the focused UTF-8 set initially had **59 passed,
  3 failed**, then **62 passed** after the fix. The gate set initially had
  **34 passed, 13 failed**, then **47 passed** after the fix. Failures exercised
  malformed-byte acceptance, unbound event/manual identities, missing helper
  identity checks and the absent PR trigger. A subsequent static check exposed
  a test-fixture TypeScript error; the invalid JSON payload was retained while
  keeping the valid fixture correctly typed, then static validation passed.
- Independent review found no actionable issue. Pinned gate and action-pinning
  checks passed **52 tests**; the corrected invalid-target fixture was rerun.
  An independent **20-case** UTF-8 probe checked both CLIs and both persisted
  readers, exit codes, valid Unicode, literal replacement characters and BOM
  handling. Existing leading JSON BOM rejection remains intentional.

### Initial exact combined-candidate rehearsal

The PR-aware helper was run against local Git mirrors containing exact fetched
objects. The rehearsal used a synthetic PR event, not a hosted GitHub run or a
claim about a published PR number. The selected snapshots were:

- SaaS base: `f9fcd4305d3a7bccebf822a68c0294cbf2d0afd5`.
- Hardening head: `8e8f30bc42a8b3f25f3f9bd818c33abd946ebce8`.
- Event/controller merge: `bb05be9e546dab07ac8ea9c6f7be4e7d087f1904`,
  with those ordered base/head parents and implementation tree above.
- Fork main: `1c2c2f1e78a74cdf5e4909ab8e775b090998a51f`.
- Upstream `morluto/rea` main: `7c6c25dda75e2d1d595a6cacc5cf9a82607f8502`.
- Combined candidate: `67675f0ca1776dac749e641a01aab0fbcd3fb604`, tree
  `db97fc221a72489bcf023bbc8afa2e7e0db2ab9b`.

Preparation and fresh candidate `npm ci` passed. The controller and candidate
helper both had regular-file mode `100644` and Git blob
`8d6604faaf34b088640df54f3bc300d7413ab9f3`. The report retained observed
branch tips separately from the selected event merge and checked identities
again before executing commands.

This initial combined gate **failed: 10 of 11 stages passed**. Its **412 selected
tests passed**: 153 SaaS, 35 domain/inventory/README, 5 action pinning,
70 CLI/MCP/installer, 102 browser lifecycle and 47 gate-helper tests. The docs
stage also passed its **5 README tests**. `check:fast`, build requirements,
docs and formatting passed. The separate full serial static inventory reached
the same final knip failure; architecture guards passed separately.

Additional checks on this exact candidate passed **185 replay/HTTP tests**
across 17 source files, **13 environment CLI/MCP boundary tests** and
**129 Python tests**. An independent tree audit verified all **114
feature-only** and **627 upstream-only** paths byte-for-byte with Git modes,
relative to common ancestor `8716b5241125d81f1a16808eb5178fdfdea1ecdb`.
All 25 shared changed paths retained both sides' additions/deletions; candidate
package metadata equals upstream plus the unchanged feature `test:saas` script.

### Initial upstream blocker

The failing command was `npm run knip`, exit 1:
`g++` is an unlisted binary in `src/windows/WindowsHandleClose.test.ts`.
The exact diagnostic was freshly reproduced at pristine upstream
`7c6c25dda75e2d1d595a6cacc5cf9a82607f8502` with the pinned toolchain and
matching lockfile, knip configuration and test-file blobs. That baseline lacked
generated runtime artifacts and also reported two unresolved worker imports;
its entire output is therefore not claimed identical to the built candidate.
No suppression or upstream repair was added to this scoped hardening change.

### Refreshed upstream snapshot

Upstream advanced during validation and fixed its own knip configuration in
`d36cb61210286e917bd673322c5415a4e8fdf24d`, five commits after the initial
snapshot. That exact revision was frozen for a fresh rehearsal; the historical
failed result above was retained rather than relabeled as a pass.

The new source head was documentation-only follow-up
`bfa9614d668c233c934b4eb7108be013f3adbb02`, tree
`ae40cfa0d4dc9c58cae9e35c6608b77afdd6e4ae`. SaaS base and fork main were
unchanged. The event/controller merge was
`50504f65321d18b01337558ffea385e65299c225`, with ordered parents
`f9fcd4305d3a7bccebf822a68c0294cbf2d0afd5` and
`bfa9614d668c233c934b4eb7108be013f3adbb02`. The rebuilt candidate was
`5a7a6025fe49224df73cdbf5c0d66e0bc187d7fe`, tree
`c96c095785ee438e17aad30a913863d0c722ff41`; controller/candidate helper
blob and mode remained exactly those recorded above.

On this new candidate, fresh locked `npm ci`, the complete serial static
inventory, architecture guards and **all 11 combined-gate stages passed**.
All **412 selected tests**, the **5 docs tests**, **185 replay/HTTP tests**,
**13 environment CLI/MCP tests** and **132 Python tests** passed in fresh runs.
The Python count increased with the newer upstream tests. Full static validation
took 208.836 seconds; the combined gate took 100.137 seconds on this runner.
These timings are run receipts, not comparative performance claims.

A fresh independent tree audit verified **114 feature-only** and **639
upstream-only** paths with exact blobs and modes, all **25 shared paths** with
both sides' additions/deletions, and unchanged package-script composition.
All 76 checked newer-feature implementation/test paths remained identical to the
SaaS base. This record is a further documentation-only follow-up; publication
identity and any subsequent snapshot require their own verification.

### Latest feature reconciliation

Before publication, the feature branch advanced to
`90fb608273d8dac36d5c3c0cc6cf64081aabcc45`. Its strict-transport and
contract-evidence fixes were preserved in local source
`eccaca17b3ef45cce8957b7e60f38dac6f4a8f10`, tree
`fbb76501bd816f8e2911f234a3d9691d6f8e8535`. Only the two independently
prepended validation sections conflicted; both were retained in full.
The hardening diff against this newer base still contains the same 12 scoped
files, with unchanged Stage 1 implementation/test blobs.

Fresh source checks passed **161 SaaS tests**, the full serial static inventory,
architecture guards and docs checks. Against the same frozen upstream
`d36cb61210286e917bd673322c5415a4e8fdf24d` and fork main above, the new
event/controller merge was `8ab7f26e8e2eef441b71ef4161ed354a964ea21b`,
with ordered parents `90fb608273d8dac36d5c3c0cc6cf64081aabcc45` and
`eccaca17b3ef45cce8957b7e60f38dac6f4a8f10`. Its combined candidate was
`2c35183fa82fd907079f3fdb65646deee40d1fd7`, tree
`eae66e8ff9790ac58c44d22370b6570c15e0daec`.

Fresh locked install, full serial static checks, architecture guards and
**all 11 combined-gate stages passed**. The new counts are **420 selected
tests**, **5 docs tests**, **190 replay/HTTP tests** across 18 files including
the new strict-transport suite, **13 environment CLI/MCP tests** and
**132 Python tests**. These results belong to this rebuilt candidate, not to
the earlier snapshots. Independent preservation review confirmed all **116
feature-only**, **639 upstream-only** and **25 shared** paths, with all **78
checked newer-feature implementation/test paths** identical to the latest
feature base. Helper blob/mode identity remained unchanged. This receipt is a
documentation-only follow-up; the PR records its final publication identity.

### Limits

These are local, synthetic checks. Hosted Actions, the full repository test
suite, Windows/macOS execution and live vendor/provider behavior were not run.
Earlier baseline failures elsewhere in this document are historical and do not
establish the state of this newly combined tree. Stage 1 does not activate
Actions or branch rules. The proposed-merge tree and the candidate containing
additional upstream commits have different coverage purposes, and a same-runner
helper identity check is not a sandbox against hostile code. See the
[sync guide](saas-compatibility.md) for event provenance and activation limits.

## Draft bug review follow-up: 2026-10-21

Reviewed feature head `f9fcd4305d3a7bccebf822a68c0294cbf2d0afd5` and
corrected six reproduced issues, using pinned Node **24.18.0** and npm
**11.16.0** on Linux:

- Strict MCP HTTP requests could bypass exact JSON admission through malformed
  `Accept` ranges. Invalid UTF-8 could also become a matching replacement character,
  and a rejected initialization request could evict the active session. A shared
  bounded UTF-8/number reader now owns strict dispatch and initialization probing;
  invalid headers receive a refusal rather than falling back to SDK parsing.
- Missing, truncated, unparseable and opaque redacted reference requests now retain
  uncertainty on observed GraphQL routes, including failed requests and either
  capture order. They no longer establish a false document-absence finding.
- Required-coverage selectors are copied before asynchronous reads. Caller changes
  cannot change the policy being evaluated or mutate the completed report.
- HTTP and GraphQL verification share loss-aware JSON decoding. Unsupported numbers
  stay unverified instead of producing false schema drift. The correction review
  caught an initial REST false-pass case; `unverified_numeric_bodies` now keeps
  conformance unknown when other responses validate, unless findings establish failure.

The new regressions were observed failing before their corrections. Final focused
verification:

- `npm run test:saas`: **156 passed**.
- `npm run test:local` for `strictReplayTransport.test.ts`,
  `serveEnvironment.test.ts` and `serveStreamableHttp.test.ts`: **85 passed**.
  These use real local HTTP/MCP clients and retain size, cancellation and session
  lifecycle coverage.
- `npm run test:focused` for the SaaS contract/surface CLI, environment serve/export
  CLI, environment MCP and surface filesystem boundaries: **27 passed**, 6 files.
- `npm run check`: passed build, typecheck, lint (**0 errors**, repository-wide
  warnings remain), formatting, knip, metadata and architecture guards.
- `npm run docs:check`: passed, including **5 README consistency tests**.

This was a focused review of the SaaS evidence and replay changes, with an
independent contract review. The complete repository suite, hosted CI, live SaaS
accounts, other operating systems and performance comparisons were not run.
No live QuickBooks or Lightspeed behavior is established by these synthetic tests.
The product limitations documented below still apply.

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
