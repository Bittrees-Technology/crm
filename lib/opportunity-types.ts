export const opportunityTypes = [
  "Partnership",
  "Customer",
  "Research",
  "Contributor",
  "Grant",
  "Investment",
  "Sponsorship",
  "Integration",
  "Consulting",
  "Licensing",
  "Community",
  "Event",
] as const;
export const normalizeType = (label: string) =>
  label.trim().replace(/\s+/g, " ");
export const typeKey = (label: string) => normalizeType(label).toLowerCase();
export function defaultType(label: string): string | undefined {
  return opportunityTypes.find((option) => typeKey(option) === typeKey(label));
}
export function typeOptions(saved: string[], current = ""): string[] {
  const options: string[] = [...opportunityTypes];
  for (const label of [...saved, current]) {
    const normalized = normalizeType(label);
    if (
      normalized &&
      !options.some((option) => typeKey(option) === typeKey(normalized))
    )
      options.push(normalized);
  }
  // Keep the exact current value selectable on old/shared records, including noncanonical casing.
  if (current && !options.includes(current)) options.push(current);
  return options;
}
