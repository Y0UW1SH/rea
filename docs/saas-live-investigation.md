# Live SaaS investigation

`run-saas-investigation` (CLI) and `run_saas_investigation` (MCP) execute a bounded
investigation against a live application. Given competing explanations and explicit
browser workflows, REA selects a distinguishing experiment, observes its initial
state, performs its actions, reads back saved state, updates the surviving
hypotheses, and selects the next experiment without manual capture-file transfers.

This first loop uses caller-supplied hypotheses, predictions and browser scenarios.
It does not discover selectors, invent experiments with an AI model, or log into a
vendor for you. Supply an authorized session and application-specific workflows.
Synthetic tests establish controller behavior, not Lightspeed or QuickBooks behavior.

## Run and resume

```sh
rea run-saas-investigation investigation.json --json
# In a source checkout:
node scripts/rea.mjs run-saas-investigation investigation.json --json
```

The MCP tool takes the same request object. The request contains `plan` and an
absolute `journal_path`. The CLI also resolves a relative journal path against the
current directory. Its parent directory must already exist on a stable local
filesystem with working file and directory synchronization. This first journal
implementation supports POSIX hosts and refuses Windows execution before any
browser actions. Browser executable
paths are absolute, as in the browser-scenario contract.

Run the identical request again to resume. The journal binds the complete parsed
plan, including actor, workspace, predictions, browser configuration and limits.
A changed plan requires a new journal. A completed run returns retained results
without new browser actions; it is not a fresh drift check.

See [the runtime example](examples/saas-live-investigation.json). Its domains,
selectors, browser path, actor/workspace IDs and hypothetical predictions must be
replaced with those for your authorized test application. Do not run the example
against a production tenant by merely changing its origin.

## Plan fields

| Field                                 | Meaning                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `version`                             | `1` for this executable-plan format.                                                                                  |
| `investigation_id`, `question`        | Identity and the question being investigated.                                                                         |
| `study.study_id`, `study.scenario_id` | Caller-declared references to a study and workflow; the live tool does not load or validate PR #3's offline manifest. |
| `actor_id`, `workspace_id`            | Exact string values the before and after probes must observe.                                                         |
| `allowed_origins`                     | Origins permitted in explicit scenario navigation, response selection and supplied storage.                           |
| `allow_mutations`                     | Explicit consent for experiments declared `mutates: true`.                                                            |
| `hypotheses`                          | Unique IDs and descriptions of competing explanations.                                                                |
| `experiments`                         | Unique IDs, descriptions, declared effects, before/action/after scenarios and one prediction for every hypothesis.    |
| `limits`                              | Caller-selected cumulative experiment/action limits, per-invocation duration and maximum retained journal bytes.      |

An experiment's `before` and `after` probes each contain a complete
[browser scenario](browser-scenario-contract.md), `response_url`,
`actor_pointer`, `workspace_pointer`, and nonempty `assertions` of
`{ "pointer": "/path", "equals": VALUE }`. Pointers follow JSON Pointer syntax;
missing values differ from JSON `null`. Probes permit navigation and waits only.
Their network response-body selection must be enabled.

The before assertions must establish the relevant starting conditions. The after
assertions must identify **this experiment's saved result**, for example a unique
test-record ID. Use isolated records and a new correlation ID for each new study;
there is no automatic tenant reset. The controller does not generate these IDs or
prove a caller-chosen completion assertion is sufficiently discriminating.

`action` is a complete browser scenario for the experiment. `outcome_pointer`
selects the measured value from the after probe's JSON document. `predictions`
contains `{ "hypothesis_id": "...", "value": VALUE }` for each hypothesis.
Comparison is exact JSON-value equality, independent of object-key order.
Before, action and after must share identical browser, storage, secrets and
environment configuration. Experiments declared non-mutating permit only
navigation and waits; interactive actions require a mutating declaration.

The planner chooses the untried experiment separating the most pairs of surviving
hypotheses; ties use plan order. It eliminates a hypothesis only after a complete,
attributed readback supplies an outcome. This is a finite distinguishing-experiment
planner, with no statistical confidence score or claim of exhaustive discovery.

## Results and retained evidence

| Status          | Interpretation                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distinguished` | One supplied hypothesis remains consistent with these experiments and conditions.                                                                  |
| `contradicted`  | The observed outcome contradicts every supplied hypothesis; revise the explanations.                                                               |
| `exhausted`     | No untried supplied experiment separates the remaining hypotheses.                                                                                 |
| `paused`        | Identity/state checks, incomplete observations, execution, cancellation or budgets prevented further progress. Read `reason` and pending attempts. |

The result is REA Evidence with the report under `normalized_result`. It includes
attempts, surviving hypotheses, reserved actions and linked browser Evidence IDs.
Provider failure diagnostics are retained in `failures`, including on resume.
The journal retains the complete Evidence bundle under `evidence`, using REA's
existing record owner and integrity checks. MCP also retains these captures in its
session for subsequent evidence tools. Treat the journal as sensitive local data;
selected response bodies can contain business information. Browser credentials and
explicitly declared secrets follow the existing browser redaction rules.

Missing, ambiguous, redacted, incomplete, invalid UTF-8, duplicate-key or numerically
inexact selected JSON observations cannot establish a result. A complete selected
response can support a narrow observation when aggregate event coverage is
incomplete, for example an unavailable GET request body or unobserved traffic in
an attached context. The report preserves the original capture limitations;
dropped events or transaction omissions still block evaluation. A probe currently requires
exactly one successful GET response at `response_url`. Repeated matching responses,
POST-only GraphQL readbacks, UI-only outcomes, asynchronous polling and cross-view
reconciliation need additional probe adapters. No schema-conformance result is
promoted to business compatibility by this loop.

## Interruption and limits

The controller commits the action's budget reservation and then its intent before
execution, so a pending attempt always means the action may have reached the
target. If cancellation or a journal failure stops the run before dispatch, the
intent is withdrawn and resuming runs that experiment again from its initial-state
probe. If execution or its reply is interrupted, resuming performs only the after
probe. It never repeats that action automatically. If readback cannot establish
completion, the attempt stays pending, even if the initial state seems unchanged:
a delayed write might still complete. Investigate that pending operation before
starting a new journal.

Journal updates synchronize file contents, publish atomically, and synchronize
the parent directory before admitting the next action. A synchronization failure
blocks execution; support is conditional on the filesystem and storage honoring
these operations. Host power-loss recovery has not been fault-tested. An exclusive lock
prevents cooperating CLI/MCP processes from driving the same journal concurrently.
The lock is not stolen using PID heuristics. After a process crash, remove
`JOURNAL_PATH.lock` only after confirming the previous process has stopped. An
unexpected lock, corrupted journal, altered plan or missing Evidence blocks
execution. This is local single-host coordination, not a distributed lease or a
hostile-filesystem sandbox.

`max_actions` counts each supplied action plus each scenario's automatic initial
navigation. Reservations are committed before capture and remain consumed if a
capture fails or is cancelled. A new experiment must fit its full before/action/
after cost before it begins. Recovery probes also consume the remaining budget.
`max_experiments` counts attempts, including pending attempts. These counters do
not reset on resume. `max_run_ms` restarts for each invocation, uses cancellation
at the browser boundary, and does not impose a hard deadline on final cleanup.
`max_journal_bytes` bounds the serialized checkpoint; browser capture limits still
govern individual capture retention. A disk failure that also prevents withdrawing
an undispatched intent can leave it pending; resume then reads back rather than
repeating the action.

The origin list constrains **explicit navigation and storage**, not every
background request, redirect or WebSocket made by an authorized page. Page code
and even GET navigation can have server effects. Guards observe the application
before and after an action; they cannot provide atomic workspace isolation while
another user changes the session. A separate readback may be affected by caching
or Playwright's response-body retrieval behavior. Supply appropriate fresh-read
workflows and preserve those limitations when interpreting evidence.

## Validation and next increments

The service tests exercise adaptive selection, evidence persistence, interrupted
writes, uncertain readbacks, identity mismatch, plan binding, locks and budgets.
Fault-injection regressions cover directory-sync failures before actions and
transient/persistent lock cleanup, including retained partial results and retry
authority. Ambiguous matching requests remain visible even when their responses
cannot be attributed.
The public MCP boundary validates its advertised schema and Evidence delivery.
The real-browser acceptance test runs a local HTTP application through the
installed CLI, executes two state-changing experiments, selects the second based
on the first observation, and verifies that completed resume adds no writes:

```sh
REA_TEST_CHROMIUM=/absolute/path/to/chromium npm run test:focused -- tests/acceptance/browser/saasInvestigationLiveCli.test.ts
```

Without that environment variable, the browser acceptance test is explicitly
skipped. A vendor pilot still needs an authorized test workspace, its settings,
selectors and observable state endpoint. Multi-actor coordination, model-generated
hypotheses, broader probe families, automatic counterexample minimization, drift
monitoring and replacement generation are later increments.
