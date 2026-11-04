// The complete-capture integrity owner is src/domain/browserScenarioCapture.ts.
// This offline companion checks consumed invariants without requiring a build;
// tests/boundary/cli/saasStudy.test.ts pins parity with that owner's schema.
export function assertStudyCaptureProvenance(capture) {
  const bySequence = new Map(
    capture.events.items.map((event) => [event.sequence, event]),
  );
  for (const event of capture.events.items) {
    if (event.kind !== "network-content") continue;
    const source = bySequence.get(event.source_event_sequence);
    if (
      source?.kind !== event.phase ||
      source.transaction_id !== event.transaction_id ||
      source.sequence >= event.sequence
    )
      throw new Error(
        "Network content must reference an earlier matching transaction phase",
      );
  }
}

export function captureIsComplete(capture) {
  const complete = (value) =>
    value?.status === "complete" &&
    value.equality_eligible === true &&
    Array.isArray(value.missing_sections) &&
    value.missing_sections.length === 0 &&
    Array.isArray(value.truncated_sections) &&
    value.truncated_sections.length === 0;
  const omissions = capture.events.omissions;
  return (
    complete(capture.completeness) &&
    Number.isSafeInteger(capture.scenario.action_count) &&
    capture.scenario.action_count >= 1 &&
    capture.steps.length === capture.scenario.action_count + 1 &&
    capture.events.dropped === 0 &&
    capture.events.retained === capture.events.items.length &&
    omissions !== undefined &&
    omissions !== null &&
    Array.isArray(omissions.by_kind) &&
    omissions.by_kind.length === 0 &&
    Array.isArray(omissions.network_transactions) &&
    omissions.network_transactions.length === 0 &&
    omissions.network_transaction_range === null &&
    capture.steps.every(
      (step) => step.status === "completed" && complete(step.completeness),
    ) &&
    capture.events.items.every((event) => event.kind !== "request-unfinished")
  );
}
