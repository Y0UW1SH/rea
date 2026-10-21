# Cloud-software behavior compatibility

This fork specializes REA for evidence-driven study of cloud applications and
independent implementations. The proprietary application is the behavioral
reference; its server source and an open-source original are **not required**.
Use authorized accounts and synthetic records. Preserve REA's upstream credit,
license, evidence model, and explicit target authority.

The [SaaS change ledger](saas-change-ledger.md) records feature checkpoints,
regression gates and the safe upstream-sync procedure.

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
- Infer an OpenAPI 3.1 contract with evidence-cited, sample-counted JSON Schemas
  from scenario captures that retained network bodies, and verify a replacement's
  captured bodies against it.

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

From a checkout of this fork, using its supported Node.js version and locked
dependencies:

```bash
npm ci
node scripts/saas-compatibility.mjs scripts/fixtures/saas-compatibility/accounting.json
node scripts/saas-compatibility.mjs scripts/fixtures/saas-compatibility/retail.json
npm run test:saas
```

The first two commands emit JSON reports. `accounting-incorrect.json` and
`retail-incorrect.json` deliberately change saved business values and must fail.
The command exits 0 for pass, 1 for an observed failed obligation, and 2 for
unknown, invalid input, or an input/read error. Reports go to stdout; redirect
stdout to a caller-selected report file if you want to retain it.

This source-checkout companion uses the existing locked `lossless-json`
dependency to validate numeric tokens. It is not a new MCP tool and is not shipped
in the upstream npm package. For core browser
comparison changes, build this checkout with the repository's pinned toolchain;
running `npx rea-agents@latest` would run upstream instead.

Workflow-case and product-profile files must contain valid UTF-8. Their CLIs
reject malformed byte sequences with exit code 2 before JSON parsing, rather than
silently replacing different corrupted bytes with the same U+FFFD character.
The synthetic lab's persisted readers apply the same rule. Valid Unicode,
including literal U+FFFD and embedded U+FEFF, remains unchanged; these JSON inputs
continue to reject a leading BOM. Strings are not Unicode-normalized.

Reports retain numeric negative zero as the JSON token `-0`, including nested
observation values and context. This preserves the existing distinction between
negative and positive zero in comparisons without turning numbers into strings.
Literal strings such as `"-0"` are unchanged. Export report-size accounting uses
the same serialized representation, including the sign and final newline.

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

Numeric context and observation values must be finite, and integer values must
stay within the JavaScript safe integer range (±9,007,199,254,740,991). The CLI
checks original JSON number tokens and rejects precision loss, underflow and
overflow before comparison. Ordinary decimals and exponent spellings that
round-trip without information loss remain supported. Encode larger integers or
high-precision decimals as JSON strings on both sides; strings are compared
literally. Library callers should use `parseCompatibilityJson` for JSON text:
`evaluateCompatibility` cannot recover precision already lost by another parser.

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

## Compare locally exported CSV and JSON records

```bash
node scripts/saas-export-compare.mjs scripts/fixtures/saas-exports/manifest.json
```

The supplied synthetic example compares CSV against reordered JSON records. Copy
its manifest and replace the local file paths, selected fields and compound record
keys for your case. Each field explicitly names its reference and replacement
column and declares `string`, `integer` or `decimal`. JSON selected values must be
strings; the importer refuses numeric coercion that could hide already-rounded
amounts. Decimal comparison normalizes leading/trailing zeros, with no tolerance,
rounding or currency conversion. Relationship IDs remain literal in this slice.

Rows are aligned by the selected keys. Reordering alone is ignored; changed
selected fields, missing/extra records and duplicate keys remain visible. Reports
retain the extraction policy, raw file digests and excluded column names. They
establish equality only for selected exported contents, not that a vendor exported
all records or that a result agrees with the live UI, API or database.

Inputs must be local regular files beneath the manifest directory. The importer
rejects traversal, detected outside symlinks, invalid UTF-8, malformed CSV/JSON,
ambiguous headers/JSON members, missing selected columns and detected file changes
during reading. Configure positive `maxBytes`, `maxRecords` and `maxFields` limits;
optional `maxValues` bounds aggregate JSON values/member names or CSV cells
(default 100,000; maximum 1,000,000). A JSON depth limit of 32 also bounds
expanded structures. Do not
use an input directory concurrently modified by untrusted actors: this is local
file validation, not an operating-system filesystem sandbox. UTF-8 BOMs are
explicitly rejected. An empty JSON array cannot establish selected-field coverage;
CSV headers can establish the schema of an empty export.

The CLI caps the manifest at 1 MiB; the effective comparison policy is also
limited to 1 MiB of compact JSON before exports are read. Complete reports are
limited to 16 MiB of UTF-8 JSON, including escaping, two-space indentation and
the final newline. Expansion is checked before serialization. A comparison
whose report would exceed that limit returns `invalid`, retaining its full
admitted policy and raw input provenance rather than a partial verdict. Invalid
UTF-8 also retains the successfully read file's byte count and digest. If an
invalid-input diagnostic itself exceeds the report limit, its oversized detail
is explicitly omitted while the admitted policy and provenance remain available.

The command exits 0 for selected-content agreement, 1 for observed record
differences, and 2 when input or evidence cannot be compared. It neither downloads
files nor executes exports, scripts, formulas, URLs or external integrations.
Use synthetic data in committed fixtures and retain originals privately for audit.

## Infer and verify API contracts from captures

```bash
node scripts/saas-api-contract.mjs infer scripts/fixtures/saas-api-contract/manifest.json --out ./contract
node scripts/saas-api-contract.mjs verify ./contract scripts/fixtures/saas-api-contract/replacement.json --origin-map https://app.example.test=http://localhost:4300
```

`infer` reads one or more `capture_browser_scenario` `normalized_result` files that
were recorded with `capture.network.request_body` or `response_body` enabled and
writes `openapi.json` (OpenAPI 3.1, JSON Schema 2020-12) and `contract-report.json`
into a new directory that must not exist yet. Copy the fixture manifest: it names
the captures, optional `origins` (exactly one declared primary origin; otherwise
the origin with the most JSON transactions is selected), `resource_types`
(default `fetch` and `xhr`), the inference `options` and the `limits` (`maxBytes`,
`maxTransactions`, `maxBodyBytes`, `maxSchemaNodes`, `maxEvidencePerOperation`).
Unknown fields, traversal paths and over-ceiling limits are rejected. Retained
body digests are re-verified; a mismatch makes the whole run `invalid`.

What the contract states, and how each statement is marked:

- Operations are keyed by method and path template using the api-surface segment
  rules (`numeric`, `uuid`, `hex`, `iso-date`). Path parameters get positional
  names such as `{numeric_2}`; the plain api-surface template is kept in
  `x-rea-api-surface-template`. Query parameter names and request/response header
  names are listed; header values are never read.
- Request schemas per media type and response schemas per observed status merge
  every JSON sample. `type` follows the original number lexeme (`integer` only
  when every sample is an integer token); `required` appears only at complete
  presence with at least `required_min_samples` samples, always with
  `x-rea-basis: inferred` and `x-rea-presence` counts; `format` (`uuid`,
  `date-time`, `date`, checked against real calendar dates) and the
  decimal-string `pattern` need every sample, including empty strings, to agree,
  so inferred formats do not reject their own samples; enum
  candidates are observed literal values offered only as
  `x-rea-enum-candidates`, never as `enum`.
- GraphQL POST objects and ordered batches are grouped under
  `x-rea-graphql-operations` by a SHA-256 key covering the literal endpoint path,
  `operationName` and exact document or APQ document digest. Each entry retains
  `identity`, `samples`, a `request` schema (including variables), and `responses`
  schemas by status (including data/errors). An observed status with no retained
  unredacted JSON response has a null schema. `unverified_response_samples`
  counts incomplete reference responses per status, including mixed complete and
  redacted samples; those statuses remain unknown during verification.
  `x-rea-graphql-unidentified-samples` preserves recognized envelopes whose identity
  is absent, redacted or inconsistent, plus missing, truncated, unparseable or
  opaque redacted requests on an HTTP operation with GraphQL evidence. These gaps
  remain unknown regardless of capture order or request success. Different
  documents sharing a name stay separate.
  GraphQL over GET and equivalence of differently spelled documents remain unverified.
- Every operation carries `x-rea-evidence` (the capture files and digests its
  samples came from, transaction entries whose `capture` index refers to
  `x-rea-contract.captures`, step ids, statuses, sample count) and
  `x-rea-unknowns`: the fixed `authorization-model`, `response-semantics` and
  `state-transition` unknowns the environment manifest also states, plus
  `error-responses-unobserved` when no 4xx or 5xx response was seen.
- The report records the primary origin, per-input digests, coverage (admitted
  transactions; exclusions by reason such as `other-origin`, `non-json-body`,
  `resource-type` or `url-redacted`; truncated and unparseable bodies), the
  operation list and the `openapi_sha256` that `verify` checks.

Failed and unfinished requests are never modeled as responses: they are counted
per operation under `x-rea-failures` with their reasons. Empty bodies (for
example a `204`) are admitted without a schema and counted as
`x-rea-empty-bodies`. Each input's `completeness` status and dropped-event count
are recorded in the report and in `x-rea-contract.captures`, and an incomplete
capture adds a limitation line. A declared origin that admits no transaction, a
duplicate capture (same file or same digest) or a run with no admitted transaction
at all is `invalid`, never an empty contract.

`verify` reads a replacement capture, folds its origins onto the contract origin
through directional `--origin-map CONTRACT=REPLACEMENT` pairs (the same rule as
`origin_pairs`; undeclared origins are excluded, never guessed), matches each
admitted transaction to an operation by method and template, and validates the
captured JSON bodies with Ajv against the inferred schemas with the `x-rea-*`
markers removed. Findings are `structural` (type, format, pattern, items, and a
`mediaType` keyword when a matched operation answers with a media type the
contract never recorded, such as an HTML fallback page), `presence` (required),
`unobserved_status`, `failed_request` (the replacement request failed or never
finished) and `unmatched_operation` (a request line the contract lacks, reported
only when it carries a JSON body; without body evidence it is counted under
`excluded.unmatched-without-body`). Each finding carries the instance path,
keyword, transaction id and step id, never body values. The report also lists
`unexercised_operations`, the contract operations the replacement never reached,
and the replacement's completeness. For GraphQL it also reports
`unexercised_graphql_operations` and `unverified_graphql_transactions`, and
validates the selected request/response schemas. Unknown documents and statuses
are findings; absent/redacted identity or response evidence stays unknown. Legacy
name-only GraphQL extensions cannot establish operation conformance; regenerate
those contracts to obtain document identities.

Verification decodes each retained body once for both HTTP and GraphQL checks.
Valid JSON numbers that cannot be represented without conversion loss count under
`unverified_numeric_bodies` and keep conformance `unknown` unless other findings
establish a failure. They are never validated as rounded values or reported as
schema drift solely because conversion overflowed or underflowed.

Three conclusions are separate: `conclusions.conformance` is the existing narrow
`status` for captured samples; `conclusions.required_coverage` measures the explicit
required set; `conclusions.business_compatibility` stays `unknown` because this
command does not check business outcomes. Without a policy, required coverage is
`not-requested`. Define a policy file, for example:

```json
{
  "required_operations": [
    { "method": "GET", "path": "/api/invoices" },
    { "method": "POST", "path": "/graphql" }
  ]
}
```

Pass it with `verify CONTRACT_DIR CAPTURE.json --coverage-policy policy.json` and
any needed `--origin-map`. A selector may also include `graphql_operation` with
an exact key from `x-rea-graphql-operations` to require that document/operation,
instead of any traffic to the HTTP endpoint. Empty, duplicate or nonexistent
selectors are invalid. Coverage measures exercise, independently of conformance.
Exit 0 requires passing conformance and, when requested, complete required
coverage; 1 means conformance findings; 2 means invalid input, unknown conformance
or incomplete required coverage. An unexercised operation never becomes a
conformance success for that operation. Use the workflow evaluator for business outcomes.

Limits: bodies above the capture's retained size limit (64 KiB by default) or the
manifest `maxBodyBytes` contribute no schema and are counted as truncated;
non-JSON bodies (protobuf, gRPC-web, binary tRPC) exclude their transaction;
pagination envelopes are not modeled; one primary origin per contract; the
Playwright response-body provenance caveat applies to every response schema; and
redaction covers declared secrets and credential header families only, so keep
contracts inferred from real captures private. Regenerate the synthetic fixtures
with `node scripts/saas-api-contract-fixtures.mjs` and check them with `--check`;
they prove the companion, not any vendor API.

## Reconcile the declared bundle surface with observed traffic

```bash
node scripts/saas-surface-coverage.mjs --static scripts/fixtures/saas-surface/static-analysis.json --observed scripts/fixtures/saas-surface/api-surface.json --observed scripts/fixtures/saas-surface/scenario-capture.json --origins scripts/fixtures/saas-surface/origins.json --profile scripts/fixtures/saas-surface/profile.json --workflow-id first-workflow
```

`--static` is an `analyze_javascript_application` result: the `normalized_result`
of the Evidence that `rea analyze-javascript-application <bundle> --artifact-format
directory --format json` prints, or that Evidence itself. Its `endpoint` nodes are
the declared surface, split into families by mechanism: `network` (`call:fetch`,
`call:axios.post`, `call:EventSource`, `call:WebSocket`,
`call:navigator.sendBeacon` and other request callees), `graphql`
(`graphql:query`, `graphql:mutation`, `graphql:subscription` operation names),
`trpc` (`trpc:procedure:<method>` paths served under `trpc:link:<factory>`
bases) and `route` (`property:path` and `property:route` client routes). Each
`--observed` file is dispatched by shape: an `api-surface` view result, a
`capture_browser_scenario` `normalized_result` (its request events become
api-surface-style groups, its retained JSON request bodies name GraphQL
operations, and its `before_url`, `after_url` and captured history entries are
the navigations), or a `compare_static_and_observed_endpoints` result from the
unmerged 3591 branch, accepted only when `page.total` equals `items.length` and
its `static.root_artifact_sha256` equals the static input. `--origins` declares
the reference origins that origin-relative static paths are joined against and
the directional `origin_pairs` that fold replacement origins onto them before
joining, the same rule `compare-web-captures` applies. `--profile` with
`--workflow-id` appends the planned experiments to a product profile.

What the report states, and how each statement is marked:

- `surface[]` holds one item per declared node: `family`, `key`, `status`
  (`exact`, `templated`, `ambiguous`, `unmatched`, or `unknown` with a `reason`),
  `confidence` (`high` only for an exact pairing that needed no inference,
  `medium` when an inference listed under `inferences` was needed:
  `origin-declared`, `method-callee-name`, `template-compatible`,
  `route-pattern`; `low` otherwise) and `evidence`: the static node id, its
  artifact digest, mechanisms and source locations, and every observed group
  with record ordinals (api-surface), transaction and step ids (captures) or
  navigation steps (routes).
- Network endpoints are paired by the rules of the unmerged branch
  `feat/3591-endpoint-traffic-comparison` (`javascriptEndpointTrafficTargets.ts`
  and `javascriptEndpointTrafficComparison.ts`), ported verbatim in
  `scripts/lib/saas-surface-matching.mjs` on top of the increment-1 route-template
  and ordering mirrors, with the owner's status, basis and reason vocabulary
  pinned by `scripts/saas-surface-matching.test.mjs`: exact literal targets only,
  route shapes from the api-surface segment rules, methods only from HTTP-verb
  callees (`callee-name`) or API definitions (`EventSource`, `sendBeacon`),
  WebSocket origins mapped to `ws(s)`, and nothing paired by similarity, prefix,
  case folding or cross-origin guesses. Candidate readings
  (`interpretation: candidate`) and string-built targets (`resolution: partial`)
  stay `unknown` (`candidate-endpoint`, `target-unresolved`).
- GraphQL names in retained JSON request bodies identify candidates on declared
  origins. The static analyzer does not establish a document-to-transport link,
  so a single candidate is `unknown` (`graphql-transport-unresolved`), and
  multiple origin, endpoint, type or document identities are `ambiguous`
  (`graphql-operation-ambiguous`). An operation name alone never establishes
  coverage. Observed operations retain endpoint paths and document/persisted-query
  digests, and remain visible in `undeclared_observed` until linkage is proven.
  tRPC procedures match only the comma-split segments after a declared link base
  on the base's origin. Client routes match
  only navigation pathnames on the declared origins: literal equality is `exact`;
  `:id`, `[id]`, `{id}` and `*` segments and `**` or `[...rest]` tails give
  `templated`; regex or optional segments, and literals carrying a query or
  fragment, are `route-pattern-unsupported` and keyed by their node so the
  literal is never echoed.
- `unmatched` is reported only when every supplied observation was complete and
  the relevant origin was exercised. Any incompleteness (`records.excluded`,
  `examined < total`, a groups page beyond the first or short of its total,
  dropped events, omissions, an incomplete capture or step) turns absence into
  `unknown` (`observed-coverage-incomplete`), including a comparison result's
  own not-observed verdict when any other input is incomplete; a declared origin
  nothing reached is `origin-not-exercised`; tRPC without a link base is
  `rpc-link-base-undeclared`; origin-relative paths without declared origins are
  `origin-undeclared`. GraphQL absence remains unknown without transport linkage; missing or
  truncated request bodies are reported as `rpc-bodies-not-retained`. With several comparison results the better-ranked
  verdict wins whatever the flag order, its paired groups replace the evidence
  of the verdict it displaces, and verdict `method` and `target` fields are
  validated like every other consumed field (a target path with a query or
  fragment is rejected).
- `undeclared_observed[]` lists observed groups, tRPC procedures, GraphQL
  operations and navigations no static item explains, aggregated across inputs
  with their evidence. This never states missing code: string-built,
  wrapper-passed and server-supplied URLs are absent from static analysis by
  construction, so the entries are places to look, not findings about the bundle.
- `experiments[]` are profile-schema entries (`id` is
  `surface-<family>-<first 12 hex of sha256(family, NUL, key)>`, `status:
  planned`, `evidence: []`) for every `unmatched`, `ambiguous` and `unknown`
  item, one per family and key, in the deterministic order recorded in
  `experimentPriorities[]` (family `network` before `trpc`, `graphql`, `route`;
  status `unmatched` before `ambiguous` before `unknown`; mutating methods first;
  then key order). With `--profile`, `profileUpdate` carries the merged profile
  re-validated against `scripts/fixtures/saas-profiles/profile.schema.json` and
  the ids it added; existing experiment ids are never overwritten.
- `summary` counts statuses per family (the sums equal `declared`) and unknown
  reasons; `status` is `complete` only when the static graph coverage and every
  observed input are complete, otherwise `partial`; `limitations` quotes the
  3591 limitations and names every incomplete input and every family bound.

Exit 0 means every declared item is `exact` or `templated`; 1 means gaps were
found (`gaps` counts them); 2 means an input is invalid, unreadable or of an
unrecognized shape. On the committed fixtures the exit code is 1 by design: the
synthetic observations leave eight gaps (`navigator.sendBeacon("/api/metrics")`,
`new WebSocket("/live")` on an origin never observed over `wss`, the string-built
`fetch(API_PREFIX + "/orders")`, the candidate `translate.get(...)`, the
`ListCustomers` query and `RenameCustomer` mutation, the `user.rename` procedure and the `/settings`
route), and `undeclared_observed` names `/assets/logo.png`, the CDN request, the
`user.list` procedure, the observed `ListCustomers` operation and the `/` and `/help` navigations.

Limits: static declarations are exact literals, so string-built and
wrapper-passed URLs, server-driven and file-system routes (#4772) and
feature-flag-gated code are declared or absent without any reachability claim;
minified bundles without source maps cite generated-code locations only;
GraphQL and tRPC need retained request bodies or declared link bases; HAR files
are not decoded (use the `api-surface` view), no request is issued and no secret
is read: only origins, paths, templates, operation and procedure names are
copied, never query strings, fragments or bodies. Static coverage other than
`complete` and every incomplete observation are stated in `limitations`.

Fixtures under `scripts/fixtures/saas-surface/` are synthetic. `bundle/main.js`
is a hand-authored client; `api-surface.json`, `scenario-capture.json`,
`origins.json` and `profile.json` (a copy of `saas-profiles/generic.json`) are
regenerated with `node scripts/saas-surface-fixtures.mjs` and checked with
`--check`. `static-analysis.json` is produced by the real analyzer: run
`node scripts/rea.mjs analyze-javascript-application scripts/fixtures/saas-surface/bundle --artifact-format directory --format json > analysis.json`
on a host with the JavaScript analysis available (Linux or macOS, or Windows with
the packaged native controls), then `node scripts/saas-surface-fixtures.mjs
--import analysis.json`, which keeps the `normalized_result`, replaces the
recorded absolute input path with the repository-relative bundle path and writes
the committed serialization; `--check` verifies both. The committed file was
produced on a Windows checkout without the native controls by running the same
application-layer analysis in-process (see the change ledger), which is why the
documented command is the way to regenerate it.

## Download retention boundary

Browser download cancellation remains unchanged. The installed Playwright
`Download.createReadStream` waits until the browser has completed its file before
exposing a stream. A cap applied while reading that stream limits retained
content, not prior browser disk or network consumption. CDP download progress and
cancellation are asynchronous and likewise cannot guarantee a hard transfer cap.
We therefore have not added an opt-in retention flag that would imply stronger
bounds than the provider can enforce. Reading an already exported local file is
separate from enabling live browser downloads.

Validation commands, full-suite results and reproduced baseline failures are
recorded in [the validation report](saas-validation.md).

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
- Browser-retained downloads and upload actions. Selected local CSV/JSON content
  comparisons are available now; live download retention remains deferred as explained above.
- Role enforcement, retries, interruption and mutation tests against live targets.
- Migration adapters preserving identities, relationships and history.
- An uncertainty-driven experiment planner beyond declared-versus-observed
  surface coverage, and cross-view reconciliation beyond endpoints, operations,
  procedures and routes. The surface-coverage companion above plans experiments
  for the gaps it can see; UI state coverage remains separate.
- Vendor drift collection and comparison over time.

Track precise verified cases, collection dates, tested settings, replacement
revision and unknown coverage. Avoid an unsupported “percentage replicated.”

Related upstream discussions provide extension points, not implemented guarantees:
[UI states and transitions #4069](https://github.com/morluto/rea/issues/4069),
[retained scenario views #4163](https://github.com/morluto/rea/pull/4163), and
[capture-derived environments #4933](https://github.com/morluto/rea/issues/4933).
The companion does not add an HTTP server, replay engine, autonomous SaaS executor,
or duplicate retained-view ownership.
