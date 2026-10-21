/** Deterministic synthetic capture variants for the API contract companion. */
export const CONTRACT_FIXTURE_VARIANTS: readonly [
  "reference-a",
  "reference-b",
  "replacement",
  "replacement-drifted",
];
export type ContractFixtureVariant = (typeof CONTRACT_FIXTURE_VARIANTS)[number];

/** One deterministic capture_browser_scenario normalized_result per variant. */
export function buildContractFixture(variant: ContractFixtureVariant): unknown;
/** The committed manifest that infers a contract from both reference captures. */
export function contractFixtureManifest(): unknown;
/** Serialized exactly as the committed fixture files are stored. */
export function serializeFixture(value: unknown): string;
