import type { RecordData } from "./model";
export function sameImportIdentity(
  a: RecordData,
  b: RecordData,
  kind: string = "organizations",
) {
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase())
    return true;
  const host = (value: string) => {
    try {
      return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  if (
    kind === "organizations" &&
    a.website &&
    b.website &&
    host(a.website) === host(b.website)
  )
    return true;
  return (
    !a.email &&
    !b.email &&
    !a.website &&
    !b.website &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}
