// Keep original upstream job predicates explicit in workflow assertions. Step
// predicates are unchanged; only inherited jobs acquire this fork exclusion.
export const inheritedJobCondition = (condition?: string): string => {
  const guard = "github.repository != 'Y0UW1SH/rea'";
  if (condition === undefined) return guard;
  const original = condition.startsWith("${{")
    ? condition.slice(3, -2).trim()
    : condition;
  return `\${{ ${guard} && (${original}) }}`;
};
