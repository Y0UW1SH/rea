# Cloud-software behavior compatibility

This fork specializes REA for evidence-driven study of cloud applications and
independent implementations. The proprietary application is the behavioral
reference; its server source and an open-source original are **not required**.
Use authorized accounts and synthetic records. Preserve REA's upstream credit,
license, evidence model, and explicit target authority.

## What this increment establishes

- Compare existing browser scenario captures across explicitly paired deployment
  origins, retaining strict defaults, original capture evidence, and unrelated
  browser/context mismatches.
- Evaluate a local, versioned workflow case with explicit business context,
  entity correspondence, outcome observations, persistence and completion evidence.
- Exercise the evaluator with synthetic accounting partial-payment and retail
  partial-return cases, including deliberately incorrect replacements.
- Execute independently implemented local journal/table applications and reopen
  saved state, including unseen inputs and retry/failure controls.
- Validate reusable product planning profiles with context provenance, explicit
  workflow coverage, unresolved questions, and external-service boundaries.

This is an offline evaluation foundation. It does not log into a vendor, discover
hidden server rules, generate a replacement application, reset a SaaS tenant, or
assert that Lightspeed/QuickBooks has been reproduced. The synthetic fixtures test
our checker; they do not establish either vendor's actual behavior.

## Start with one workflow

Write down the product/edition and region, company/workspace, role, currency,
locale, timezone, relevant business settings, synthetic initial records, and how
another run can obtain equivalent starting data. Label each setting observed,
caller-declared, or unknown. A declaration is not proof that the setting was
active. Account for different permissions and settings before claiming behavior
matches.

Select the compatibility obligations explicitly:

1. User workflow and resulting business outcomes.
2. Persisted data, relationships, balances, statuses, and history.
3. External API/import/export contracts, only where required.
4. Visual appearance, only where required.

Record intentional differences with their rationale and keep unsupported behavior
visible. Do not interpret an omitted check as a passing check. Prefer integer
minor currency units in fixtures so amounts can be compared without accidental
binary floating-point rounding; select the actual target's currency and rounding
rules separately.

### Capture through existing REA tools

Use [browser scenarios](browser-scenario-contract.md) and
[network captures](web-network-captures.md), rather than building a second browser
recorder. Both existing CLI and MCP routes remain available. Retain complete REA
Evidence with collection dates and immutable references next to the case.

For each action retain before state, action and inputs, visible result, relevant
requests/responses where accessible, and a fresh read of the saved result. Run
the reference twice from equivalent starting data to identify natural volatility.
Do not strip all IDs, amounts or timestamps simply to make comparisons pass.
A screenshot, success toast, HTTP 200, or successful click does not establish that
the operation was saved. Reopen/reload or use a fresh authorized API read and
record the resulting values and relationships.

Capture can execute ordinary target behavior and create records. Choose the
workspace and actions deliberately; keep payment processing, email, banking,
identity-provider effects and hardware effects simulated unless separately
approved for live use. Mark simulated, observed and untested boundaries in reports.
Never publish credentials, session tokens or real customer records in fixtures.

### Cross-deployment browser comparison

Use the existing `compare_web_captures` MCP operation or
`compare-web-captures` CLI, selecting scenario comparison and declaring origin
pairs in its normalization policy. Pair only known deployments. Origin matching
is exact and directional; it is not a global ignore-URLs switch. Keep paths,
queries, fragments, unpaired services and unexpected redirects meaningful.

For example, save this policy as `origin-pairs.json`:

```json
{
  "origin_pairs": [
    {
      "before_origin": "https://reference.example.test",
      "after_origin": "http://localhost:3000"
    }
  ]
}
```

Use canonical origins without trailing slashes, paths, credentials, queries or
fragments. Multiple pairs must be one-to-one on each side. Declare secondary API
or WebSocket origins separately where needed. This does not rewrite URLs embedded
in DOM text, response bodies or arbitrary storage values; any such normalization
requires separately reviewed literal rules and may conceal meaningful changes.

Run `rea compare-web-captures reference-result.json replacement-result.json
--normalization-json origin-pairs.json --json` (on one shell line). Supply each
capture's `normalized_result`, not its outer Evidence envelope.

The policy is committed alongside the comparison so a reader can distinguish
explicitly allowed deployment differences from observed changes. Raw input
captures remain unchanged. This policy does not establish business equivalence;
use selected outcome checks as well.

## Run the offline workflow evaluator

From a checkout of this fork, using its supported Node.js version:

```bash
node scripts/saas-compatibility.mjs scripts/fixtures/saas-compatibility/accounting.json
node scripts/saas-compatibility.mjs scripts/fixtures/saas-compatibility/retail.json
npm run test:saas
```

The first two commands emit JSON reports. `accounting-incorrect.json` and
`retail-incorrect.json` deliberately change saved business values and must fail.
The command exits 0 for pass, 1 for an observed failed obligation, and 2 for
unknown, invalid input, or an input/read error. Reports go to stdout; redirect
stdout to a caller-selected report file if you want to retain it.

This source-checkout companion has no third-party dependencies. It is not a
new MCP tool and is not shipped in the upstream npm package. For core browser
comparison changes, build this checkout with the repository's pinned toolchain;
running `npx rea-agents@latest` would run upstream instead.

### Case contract, version 1

Copy a synthetic fixture to start a case. The validator rejects unknown envelope
fields and malformed values. The required top-level fields are `version`,
`caseId`, `scope`, `unsupported`, `contextKeys`, `reference`, `replacement`,
`entities`, and `checks`. Checks and selected context keys must be nonempty.
Keep product/edition, relevant settings and remaining coverage in the context and
scope. Each run requires `runId`, `workspace`, `collectedAt` (canonical UTC ISO timestamp
with milliseconds, such as `2026-10-19T00:00:00.000Z`), and `revision`. Use a
distinct run ID for each side. If a vendor revision is unavailable, record an
explicit value such as `unknown`; do not invent a server build version.

- `context` is a map of settings. Each entry has `provenance`: `observed`,
  `caller_declared`, or `unknown`. Known values require `value`; observed values
  also require `evidence` references. Unknown entries carry no asserted value.
  Only keys explicitly listed in `contextKeys` determine context applicability.
  Missing, unknown or differing selected context blocks a passing result.
- `observations` contain `name`, `kind` (`ui` or `persisted_read`), `elapsedMs`,
  JSON `value`, and nonempty `evidence` references. Times are milliseconds since
  the relevant action. An observation at zero is a starting-state observation,
  not evidence of completion. A `persisted_read` must actually come from a fresh
  read after the action; merely relabeling a toast cannot prove persistence.
- `windows` pair an `observation` name with `coverage` (`complete` or
  `incomplete`), `observedUntilMs`, and supporting `evidence`. Complete means the
  adapter can establish the relevant observation coverage through that time,
  not merely that a capture file was written. Observations outside their recorded
  window are invalid.
- `checks` name an observation, whether a persisted read is required (`persisted`),
  and a positive `deadlineMs`. The latest eligible observation at or before the
  deadline is compared. Missing/incomplete coverage stays unknown; an established
  exhausted deadline with no eligible result fails. A late result does not satisfy
  the deadline. The report preserves each side's observation and evidence.
- `entities` establish one-to-one, typed logical correspondence from explicit
  evidence. Each entry has `type`, `logicalId`, `reference` and `replacement`
  bindings (`runId`, `workspace`, `id`), and `evidence`. Bindings must match their
  exact run/workspace. Only values explicitly encoded as
  `{"$entity":{"type":"customer","id":"6732"}}` are translated. Other
  strings, numbers, and IDs remain literal. Unmapped entities remain unknown;
  a relationship pointing at another mapped entity fails. Duplicate/ambiguous
  mappings are invalid and duplicated records remain detectable in values.

Passing is conditional on the supplied observations and declared context. The
companion does not authenticate references, reopen captures, or independently
verify that an adapter used a fresh read. It does not execute actions or wait on
a live business operation. Keep full original Evidence and your extraction code
with a real case so another developer can audit or reproduce the observations.

## Execute the synthetic workflow lab

```bash
node scripts/saas-compatibility-lab.mjs
```

This runs real local state changes, then closes and reopens files to collect fresh
observations. The synthetic reference derives records from a journal; the
independently written replacement updates tables. Accounting and retail adapters
feed the same existing evaluator. Inputs include different customers, amounts,
products and quantities; outputs are not fixed recorded-response replays.

The report embeds observations/evidence snapshots and results for correct cases
and seeded wrong amounts, wrong mapped relationships, success without persistence,
and duplicated retry effects. A successful lab run means correct cases passed
and deliberately incorrect cases failed, not that every case reports pass.
Unique temporary directories are removed after success or failure.

This demonstrates the framework against self-owned test applications. It covers
one document per run, sequential same-process retries and file-reopen persistence.
It does not establish crash durability, restart-safe retry behavior, concurrency,
UI interaction, or compatibility with any vendor. Both small implementations are
synthetic test applications, not production accounting or retail replacements.

## Product profiles, coverage and external-service boundaries

```bash
node scripts/saas-product-profile.mjs scripts/fixtures/saas-profiles/lightspeed.json
node scripts/saas-product-profile.mjs scripts/fixtures/saas-profiles/quickbooks.json
```

The generic and vendor-named files in `scripts/fixtures/saas-profiles/` are
**planning templates**, not working vendor adapters. Install this checkout's
locked dependencies with `npm ci` before using the profile inspector; it uses
REA's existing JSON Schema validator. The versioned `profile.schema.json` can
also be used by other JSON Schema 2020-12 clients.

A profile records provenance-tagged product/edition/region/version, workspace,
role, currency, locale and timezone; observation method availability; an explicit
workflow list and compatibility goals; experiments tied to unresolved questions;
and external dependencies marked observed, simulated or untested. All supplied
vendor workflows are planned, with zero verified cases and unknown account/setup.

`valid_plan` means the profile is structurally consistent, not that access exists
or behavior has been verified. The inspector reports unknown setup, caller-declared
workflow counts and planned experiments. Observed settings, recorded/verified
workflow declarations, resolved questions and observed/simulated dependency claims
require evidence references; a verified workflow also requires a case path. Those
references are retained but not opened or authenticated. A profile cannot grant
permission to execute a live payment, send email or change an external account.

Copy a template, choose the exact authorized target, and fill observations only
when collected. Keep unsupported workflow limitations. The experiment list is a
manual uncertainty inventory; automated selection or execution remains future work.

## Product adapter responsibilities

Keep product-specific interpretation outside core capture contracts. An adapter
should gather or extract the evidence needed by a case, not silently invent it.
Its responsibilities are initial-state setup, explicit entity identity, observation
extraction, fresh-read completion checks and coverage reporting. Keep extraction
provenance tied to an exact capture/evidence reference. Comparing caller-supplied
observations verifies their internal correspondence, not the truth or authenticity
of the source capture; retain and review the underlying evidence.

Choose the exact Lightspeed product, edition, region and authorized workspace
before writing real selectors or API mappings. A useful first retail case is a
sale followed by a partial return: check transaction relationships, stock changes,
totals, and fresh persisted reads. A possible accounting case is invoice 100,
payment 40, remaining balance 60, with customer/invoice/payment relationships.
These are experiment designs, not claims about all vendor editions.

A browser-only product remains usable. Optional APIs or OpenAPI descriptions can
provide additional observation routes, but are not prerequisites. State exactly
which views were checked and where UI, API, report or export results disagree.

## Roadmap and explicit gaps

The supplied local cases must pass for good observations and reject deliberately
broken results before claiming the evaluator is useful. Next, collect and review
one real authorized workflow, implement its independent counterpart, and repeat
with a second product. A recorded response replay is not an independently
functioning replacement.

Further work remains intentionally separate:

- Live verified target profiles and authenticated adapters for specific vendor editions.
  Planning templates and their validator are available now.
- A production independent replacement for the chosen SaaS. The runnable synthetic
  lab already tests unseen inputs against two small local implementations.
- Multi-actor/tab/session coordination and concurrency tests.
- Retained downloads, upload actions, meaningful export-content comparisons.
- Role enforcement, retries, interruption and mutation tests against live targets.
- Migration adapters preserving identities, relationships and history.
- An uncertainty-driven experiment planner and cross-view reconciliation.
- Vendor drift collection and comparison over time.

Track precise verified cases, collection dates, tested settings, replacement
revision and unknown coverage. Avoid an unsupported “percentage replicated.”

Related upstream discussions provide extension points, not implemented guarantees:
[UI states and transitions #4069](https://github.com/morluto/rea/issues/4069),
[retained scenario views #4163](https://github.com/morluto/rea/pull/4163), and
[capture-derived environments #4933](https://github.com/morluto/rea/issues/4933).
The companion does not add an HTTP server, replay engine, autonomous SaaS executor,
or duplicate retained-view ownership.
