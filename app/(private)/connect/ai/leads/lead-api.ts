export async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "Request failed. Try again.");
  return value;
}

export async function readDraft(id: string) {
  const first = await api("leads/draft?id=" + id + "&pageSize=100&offset=0");
  const entries = [...first.entries];
  let offset = first.pagination.nextOffset;
  while (offset !== null) {
    const page = await api(
      `leads/draft?id=${id}&pageSize=100&offset=${offset}&version=${first.version}`,
    );
    if (
      page.id !== first.id ||
      page.version !== first.version ||
      page.pagination.totalEntries !== first.pagination.totalEntries ||
      (page.pagination.nextOffset !== null &&
        page.pagination.nextOffset <= offset)
    )
      throw Error("The list changed while loading. Read it again.");
    entries.push(...page.entries);
    offset = page.pagination.nextOffset;
  }
  if (
    entries.length !== first.pagination.totalEntries ||
    new Set(entries.map((e) => e.id)).size !== entries.length
  )
    throw Error("The list did not load completely. Read it again.");
  return { ...first, entries };
}
