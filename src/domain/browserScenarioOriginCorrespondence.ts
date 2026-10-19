import type { BrowserScenarioCapture } from "./browserScenarioCapture.js";
import type { SanitizedBrowserUrl } from "./browserObservation.js";
import type { BrowserScenarioNormalization } from "./browserScenarioDiffValues.js";

/** Comparison-only projection: never modify retained captures or arbitrary text. */
export const projectScenarioOrigins = (
  capture: BrowserScenarioCapture,
  pairs: NonNullable<BrowserScenarioNormalization["origin_pairs"]>,
  side: "before" | "after",
): BrowserScenarioCapture => {
  if (pairs.length === 0) return capture;
  const origins = new Map(
    pairs.map((pair, index) => [
      side === "before" ? pair.before_origin : pair.after_origin,
      `origin-correspondence:${index}`,
    ]),
  );
  const projectUrl = (value: SanitizedBrowserUrl): SanitizedBrowserUrl => {
    const literal = {
      ...value,
      url: `literal:${value.url}`,
      origin: value.origin === null ? null : `literal:${value.origin}`,
    };
    if (value.origin === null) return literal;
    const mapped = origins.get(value.origin);
    if (mapped === undefined) return literal;
    // Check the URL and retained origin agree. Preserve malformed or unknown
    // observations literally rather than letting a declaration repair them.
    try {
      const parsed = new URL(value.url);
      if (parsed.origin !== value.origin || !value.url.startsWith(value.origin))
        return literal;
    } catch {
      return literal;
    }
    return {
      ...value,
      origin: mapped,
      url: mapped + value.url.slice(value.origin.length),
    };
  };
  return {
    ...capture,
    scenario: {
      ...capture.scenario,
      start_origin:
        origins.get(capture.scenario.start_origin) ??
        `literal:${capture.scenario.start_origin}`,
    },
    steps: capture.steps.map((step) => ({
      ...step,
      before_url: projectUrl(step.before_url),
      after_url: projectUrl(step.after_url),
      artifacts: {
        ...step.artifacts,
        url:
          step.artifacts.url.state === "captured"
            ? { state: "captured", value: projectUrl(step.artifacts.url.value) }
            : step.artifacts.url,
        history:
          step.artifacts.history.state === "captured"
            ? {
                state: "captured",
                value: {
                  ...step.artifacts.history.value,
                  current_url: projectUrl(
                    step.artifacts.history.value.current_url,
                  ),
                  navigation_entries:
                    step.artifacts.history.value.navigation_entries.map(
                      (entry) => ({ ...entry, name: projectUrl(entry.name) }),
                    ),
                },
              }
            : step.artifacts.history,
      },
    })),
    events: {
      ...capture.events,
      items: capture.events.items.map((event) =>
        "url" in event && event.url !== null
          ? { ...event, url: projectUrl(event.url) }
          : event,
      ),
    },
  };
};
