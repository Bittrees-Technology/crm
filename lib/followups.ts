import type { DigestOptions } from "./digest-options";
export function calendarDay(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function matchesFollowup(
  r: { kind: string; data: any; archived_at?: string | null },
  user: string,
  day: string,
  options: DigestOptions,
) {
  const end = new Date(day + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + options.daysAhead);
  return (
    !r.archived_at &&
    options.kinds.includes(r.kind as "tasks" | "opportunities") &&
    !!r.data.dueDate &&
    r.data.dueDate <= end.toISOString().slice(0, 10) &&
    (options.includeOverdue || r.data.dueDate >= day) &&
    (options.assignment === "all" || r.data.ownerId === user) &&
    (r.kind === "tasks"
      ? r.data.status !== "Done"
      : !["Won", "Lost"].includes(r.data.stage))
  );
}
