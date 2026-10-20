# Cloud-software compatibility

This fork supports evidence-driven comparison of an authorized cloud application
and an independent replacement. No open-source original is required. Use REA's
existing browser scenarios/network evidence; use the local offline companion for
explicit workflow outcomes. See the fork's `docs/saas-compatibility.md` for usage,
synthetic fixtures and current limitations.

1. Scope one workflow, exact product/edition, workspace, actor/role, business
   settings and synthetic starting data. Separate observed, caller-declared and
   unknown context. Ask only for missing choices that materially affect the test.
2. Preserve complete reference Evidence and collection dates. Observe before,
   action, visible result and a fresh saved-state read. A successful action or
   complete capture does not establish persistence or business completion.
3. Compare separate deployments only with explicit directional origin pairs.
   Do not erase arbitrary URLs or normalize wrong-service redirects away.
4. Map entity IDs only by explicit run/workspace/type correspondence. Preserve
   relationships and duplicate detection; never globally replace identifier
   substrings in business values.
5. Evaluate named expected outcomes with cited observations and declared deadlines.
   Missing, stale, truncated or ambiguous evidence remains unknown. Distinguish
   an observed deadline violation from stopping before completion was known.
6. Include negative controls: incorrect amount, wrong relationship, duplicate
   retry effect, visible success without persistence, denied-role behavior and
   missing evidence. Do not claim a case is tested merely because its schema parses.
7. Report the exact passed/failed/unknown checks, settings and revision. Keep
   simulated external effects and untested workflows explicit. Synthetic retail
   and accounting cases validate the checker, not Lightspeed or QuickBooks.
8. Infer the reference API contract from captures that retained network bodies
   (`scripts/saas-api-contract.mjs infer`) and check replacement captures with
   `verify` through directional origin pairs. Required properties, formats and
   enum candidates are sample-bounded inferences, never vendor facts; a passing
   verify shows body conformance, not business equivalence.

The product-specific adapter owns observation extraction and setup. The operator
retains authority over account access, target mutation and external effects.
No unattended login, live payment, tenant reset or credential transmission follows
from a request to compare local evidence. Never publish secrets or real customer
records in a reproducible fixture. Independent application generation, multi-user
coordination, exports, migration and uncertainty-driven exploration remain separate
work unless actually implemented and verified.
