# SaaS study foundation

This source-checkout companion validates an offline investigation manifest and
optionally checks retained evidence. It does not execute scenarios, provision
actors, read credentials, or grant permission for live effects.

```bash
node scripts/saas-study.mjs validate scripts/fixtures/saas-study/invoice-study.json
node scripts/saas-study.mjs validate /path/to/study.json --check-evidence
```

The [synthetic example](../scripts/fixtures/saas-study/invoice-study.json) records
two actors, an invoice workflow, unknown starting state and revision, and an
unsupported delete operation. It is a plan, not a verified vendor workflow.

## Manifest v1

The authoritative JSON Schema is
`scripts/fixtures/saas-study/study.schema.json` (draft 2020-12). The validator
registers `saas-origin` (canonical HTTP(S) origin) and `saas-relative-file`
(relative local path without traversal) formats and checks cross references.
Unknown fields are rejected throughout. A new incompatible contract requires a
new version. No password, cookie, token or environment field is accepted.

| Field                | Meaning                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `studyId`, `version` | Stable study label and schema version                                                                                       |
| `target`             | Product, edition, region and allowed target origins; null edition/region means unknown                                      |
| `revision`           | Observed version with observation IDs, or an explicit unknown reason                                                        |
| `workspace`          | Opaque workspace label and organization/tenant/company/store/synthetic kind                                                 |
| `actors`             | Actor ID, role label and unique session label, with no authentication material                                              |
| `scenarios`          | Workflow and actor identities, initial-state evidence, existing scenario step references and expected observation kinds     |
| `authority`          | Declared origins, mutation operation IDs and external-effect IDs; never proof of authorization                              |
| `limits`             | Declared deadline, concurrency, requests, rate and evidence byte budget                                                     |
| `evidence`           | Existing normalized scenario capture files, byte counts, SHA-256, actor/context/scenario bindings and step/event references |
| `coveragePolicy`     | Required operation, role, state and workflow IDs, plus explicitly unsupported operations                                    |

Actor/session, scenario, capture, observation, step and expectation identities
must be unique in their owning scope. A context cannot belong to two actors.
Capture path spellings are unique, and authority origins must be contained in target
origins. Coverage obligations may refer to work not yet exercised. They remain
requirements, not derived claims of success. IDs are labels, not secret values.

Actions name step IDs of the existing scenario capture format; this is not a
second browser action language. Manifest validation alone cannot see captures, so
`--check-evidence` requires every capture bound to a scenario to contain each
action step ID that scenario declares. `initialState.evidenceIds` must refer to
observations in that scenario.
Capture and revision attribution are caller-declared. Hashes and coordinates
alone cannot authenticate actors, establish a version, or prove business rules.
Resolved filesystem aliases are not deduplicated: separate paths may name the
same physical file. Neither entry establishes an independent actor observation.

## Evidence and bounds

Without `--check-evidence`, exit 0 means the manifest is valid. With that flag,
exit 0 additionally means the selected retained captures and observation
coordinates verified, exit 1 means an integrity/reference contradiction, and
exit 2 means invalid input or unknown evidence. Missing files and incomplete
captures stay unknown, as does a capture lacking a declared action step; it
lists the absent manifest labels in `missingActionStepIds`. `coverageStatus`
stays unknown even when byte checks succeed; role, state and workflow
verification belong to later increments.

The reader uses REA's existing bounded local-file and scenario-capture readers.
Manifests are limited to 1 MiB, individual captures to 16 MiB, and the declared
aggregate evidence budget to 64 MiB. Actual reads cannot exceed each declared
capture size. Invalid UTF-8, duplicate JSON members, changed files, escaping
paths, dangling network-content provenance and mismatched retained body digests
fail closed. Missing declared action steps prevent verification. Files are processed
sequentially. These checks are not a hostile-filesystem sandbox or live browser
disk quota. Live deadline, concurrency and rate limits are declarations only.

`validateStudyManifest` snapshots inputs before asynchronous reads.
`serializeStudyManifest` sorts object keys, preserves array order and validates
before emitting compact JSON. It writes no files; callers choose storage.

## Validation and remaining scope

Run `npm run test:saas` and the focused
`tests/boundary/cli/saasStudy.test.ts` wrapper. Tests exercise round trips, two
actors, input mutation during checking, corrupted/missing/incomplete evidence,
input bounds and ambiguous identities.

This implements the study manifest from roadmap PR 1. GraphQL and contract
coverage corrections from roadmap PR 2 are already in the base branch. Multi-page
execution, actor coordination, retained downloads, advanced protocols, stateful
emulation and drift remain separate increments. Expanded target execution needs
the scope review described in `CONTRIBUTING.md` before integration.
