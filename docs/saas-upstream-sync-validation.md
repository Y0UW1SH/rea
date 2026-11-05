# Upstream integration receipt — 2026-10-21

This is a locally tested draft integration, not an applied update to the fork's
shared branches or a completely passing integration gate. Use the
[future-sync prompt](saas-upstream-sync.md) for later updates.

## Frozen sources and recovery

| Source                                                                | Commit                                     |
| --------------------------------------------------------------------- | ------------------------------------------ |
| Customized default branch, `feat/saas-behavior-compatibility` / PR #2 | `87a3ee21748bde3a9cdae7e595b0a5540a7e8416` |
| Fork `main`                                                           | `1c2c2f1e78a74cdf5e4909ab8e775b090998a51f` |
| Upstream `morluto/rea` `main`                                         | `01788bac863ac786bfbb648cad69b11e23b40a89` |
| Sync-hardening PR #4, intended PR base                                | `34408dcf858b93658ece2471ca34a45c5bc0a602` |
| Tested local integration source                                       | `07e838d57ec220a2531a5a6a921023bc80b452ef` |
| Tested integration tree                                               | `da9d7930000baaa56b9ab743a848f2ec9f3762ac` |

Published source commit `f26278d36ecfa1ab7be5c8037edb3b7bd45870f9` has the exact
tested tree above. Publication through the GitHub API preserves the frozen
source ancestors; no runtime or test files differ from the tested local tree.

The isolated branch is `integration/saas-upstream-20261021`. Its source commit
contains the customized branch, PR #4 and the frozen upstream commit as ancestors.
It is stacked on PR #4 so that the existing hardening change remains separately
reviewable. PRs #2, #3, #4 and #5, fork `main`, and the customized default branch
were not updated by this integration. Later commits on this integration branch
add validation documentation only.

These source SHAs are the recovery checkpoints. Discarding this unmerged draft
requires no shared-branch rollback. If an approved integration is later merged,
retain its merge commit and source checkpoints; prepare a tested revert of that
merge rather than resetting or force-pushing a shared branch. Recheck source heads
and the intended base before applying or retargeting this draft.

## Integration changes

The first upstream merge had no textual conflicts. All 93 fork-only added paths
retained identical blobs at that point. This is a source preservation check, not
a behavioral equivalence claim.

Combining PR #4 required resolving `.github/workflows/ci.yml` and
`tests/boundary/filesystem/ciRequiredLanes.test.ts`. The resolution retains both
the fork's job guards and upstream's new cache inputs, secret forwarding, deep
static lane and assertions. The inherited-workflow inventory regression then
failed on two newly added jobs: `ci.yml:static-deep` and
`cache-retention.yml:retain`. Adding the guards made the 57 selected guard,
required-lane and cache-retention tests pass.

A parsed YAML comparison against the frozen upstream verified all **32 inherited
workflow files and 71 jobs** unchanged except for the fork's dominating job
guards. This does not establish safe repository-wide Actions activation: guards
only protect revisions containing them, and unguarded tracking branches remain
outside that protection. No workflows or repository settings were activated.

An independent read-only review verified ancestry, the workflow comparison and
preservation of all 130 non-overlapping fork paths from PR #4. It found no
integration-specific source defect. This limited review does not audit every
imported upstream feature or establish unexecuted behavior.

The reusable sync guide and its change-ledger link are new. Fork runtime and
companion behavior were not rewritten to accommodate the merge. Upstream's own
changes and dependency updates are imported, including its compact MCP schema
advertisement default; this is not a promise that every inherited upstream
interface is unchanged.

## Executed validation

Linux, Node **24.18.0**, npm **11.16.0**, locked dependencies installed with
`npm ci`. No vendor account or live provider was used.

| Check                                           | Observed result                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Starting customized branch: `npm run test:saas` | 156 passed                                                                                              |
| Integration: `npm run test:saas`                | 164 passed, no failures or skips                                                                        |
| Integration: focused command below              | 674 passed, 6 failed, 4 skipped across 37 files                                                         |
| Integration: `npm run check`                    | All six Turbo tasks passed, followed by architecture guards; lint had zero errors and existing warnings |
| Integration: `npm run docs:check`               | Passed, including five README tests                                                                     |
| Runtime and packaged skill build                | Passed as prerequisites of the focused command                                                          |
| Workflow preservation comparison                | 32 files / 71 jobs retained upstream structure and conditions beneath fork guards                       |
| Diff whitespace check                           | Passed                                                                                                  |

These counts overlap and must not be summed as unique coverage. Before the
PR #4 merge, a broader upstream-only combination also passed the SaaS, static and
documentation checks; the table above qualifies the final combined source.

The six failures are the browser CLI capture-parity case and five
`selectedSkillSetup` cases. Running those two files on unchanged starting commit
`87a3ee2` reproduced the **same six failures**, with 14 tests passing. Each reports
that Node-launched `ps -axo pid=,ppid=,pgid=,uid=,stat=,command=` fails with
`fatal library error, lookup self`. A standalone nested Node/`ps` probe also
failed, while direct shell and Python invocations succeeded. This establishes a
host prerequisite problem in both trees; it does not turn failed tests into
passes. No ownership check was bypassed. The four setup permission tests are
skipped under this root account.

An initial static run encountered seven untracked old source files left behind
after upstream removals/renames. Their blobs exactly matched the old source and
were absent from the merged index. They were preserved outside the source tree
in the ignored task cache; the clean-source static run then passed. No tracked
files, tests or assertions were removed to obtain that result.

The complete repository suite, hosted CI, other operating systems, live vendor
behavior and performance comparisons were not run. The full integration gate
remains incomplete until the failed checks pass in an appropriate environment
and the human owner reviews the final result.

Both SaaS workflows currently restrict pull-request triggers to `main` and
`feat/saas-behavior-compatibility`. The proposed stacked base
`fix/saas-sync-hardening-stage1-20261021` is outside those filters. Publishing this
draft therefore does not itself run those SaaS gates. Review the intended
workflow/event policy and obtain a run against the exact intended merge before
claiming hosted qualification; absent or skipped checks are not a pass.

### Focused command

```sh
npm run test:focused -- \
  src/domain/browserScenarioDiff.test.ts \
  src/domain/browserScenarioCapture.test.ts \
  src/application/environment/environmentReplay.test.ts \
  src/application/environment/environmentReplayCapacity.test.ts \
  src/application/environment/environmentReplayNumbers.test.ts \
  src/application/environment/environmentReplayStrict.test.ts \
  src/browser/PlaywrightBrowserScenarioProvider.test.ts \
  src/browser/PlaywrightScenarioBrowser.test.ts \
  src/browser/PlaywrightScenarioSession.test.ts \
  tests/process-global/browserScenarioCleanup.test.ts \
  tests/acceptance/browser/browserScenarioCancellationCli.test.ts \
  tests/boundary/process/browserScenarioProbeLifecycle.test.ts \
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
  tests/boundary/filesystem/qwenClientConfiguration.test.ts \
  tests/conformance/managedSkillInventory.test.ts \
  tests/conformance/readmeConsistency.test.ts \
  tests/boundary/filesystem/workflowActionPinning.test.ts \
  tests/boundary/filesystem/saasUpstreamIntegration.test.ts \
  tests/boundary/filesystem/ciRequiredLanes.test.ts \
  tests/boundary/filesystem/workflowForkSafety.test.ts \
  tests/boundary/filesystem/ciCacheRetention.test.ts \
  tests/boundary/filesystem/ciChangeScope.test.ts \
  tests/boundary/filesystem/ciFeedback.test.ts \
  tests/boundary/filesystem/ciPrEvents.test.ts \
  tests/boundary/filesystem/mutationWorkflow.test.ts \
  tests/boundary/filesystem/releaseRecovery.test.ts \
  tests/boundary/filesystem/releaseWorkflow.test.ts
```

## Pending PR rehearsals

These were separate disposable combinations with the tested integration source.
Neither pending feature is imported into this integration branch.

### PR #3: offline study manifests

Head `94beecf6f4b001006a24a59e7b12c6ba6891da75`; temporary combined tree
`7310e3d076103f76a78d235426ab0c9350caf8ed`.

Conflicts occurred in `package.json` and `docs/saas-compatibility.md`. The temporary
resolution preserves both the `saas-report-json` and `saas-study` test entries,
the current capture/replay explanation and the added study-guide section.

- `npm run test:saas`: **175 passed**.
- `npm run test:focused -- tests/boundary/cli/saasStudy.test.ts`: **2 passed**,
  with runtime and skill artifacts built.
- The exact workflow-command mirror test: **1 passed**, 53 tests unselected.

This is bounded interaction evidence, not full qualification of a later PR #3
merge. The actual branch still needs the documented conflict resolution.

### PR #5: live investigation

Head `9312aac38283561692ed6da7b8b80f1fcfa84895`; temporary combined tree
`f83bafc3b577892af9c95f977c2ee78dbe177eb5`.

Git merged this combination without textual conflicts. The workflow-command
mirror test **failed**: PR #5 expands the SaaS workflow's commands, but the
PR #4 integration helper does not include the live-investigation inventory.
Keep this fail-closed check; reconcile the helper and its complete inventory as
part of the dependent PR before combining it. The combination is not qualified.

Eight affected test files were selected with `npm run test:focused --`:
`src/application/saas/SaasInvestigationService.test.ts`,
`src/contracts/toolEffects.test.ts`,
`src/domain/analysisView/scenarioCaptureRecords.test.ts`,
`src/domain/saasInvestigation.test.ts`,
`tests/acceptance/browser/saasInvestigationLiveCli.test.ts`,
`tests/boundary/cli/saasInvestigationCli.test.ts`,
`tests/boundary/mcp/saasInvestigationMcp.test.ts` and
`tests/process-global/saasInvestigationLifecycle.test.ts`.
Result: **49 passed, 1 skipped**; runtime and skill artifacts built. The real
browser case was skipped because `REA_TEST_CHROMIUM` was not configured, so this
rehearsal does not establish real-browser execution. Maintainer scope approval
for that draft's expanded execution and mutation capability remains separate.
