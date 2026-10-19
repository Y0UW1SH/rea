# SaaS fork validation — 2026-10-19

## Result and limits

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
