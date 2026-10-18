import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RecordDescription,
  RecordProfile,
  RelatedRecords,
} from "../app/components/record-profile";
import { recordSchema, type CrmRecord, type Kind } from "../lib/model";
const record = (kind: Kind, name: string, extra = {}) =>
  ({
    id: randomUUID(),
    kind,
    data: recordSchema.parse({ name, ...extra }),
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }) satisfies CrmRecord;

test("research prose escapes markup and only links explicit HTTP(S) sources", () => {
  const html = renderToStaticMarkup(
    createElement(RecordDescription, {
      text: "Keep <script>text</script> as text. javascript:alert(1)\n\nEvidence: https://example.com/proof. (https://example.com/a_(b)) https://user:password@example.com/private",
    }),
  );
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes('href="https://example.com/proof"'));
  assert(html.includes('href="https://example.com/a_(b)"'));
  assert(!html.includes('href="javascript:'));
  assert(!html.includes('href="https://user:password@'));
});
test("stored organization emails and task organization relationships appear in profiles", () => {
  const org = record("organizations", "Synthetic firm", {
      email: "public@example.com",
    }),
    task = record("tasks", "Synthetic task", { organizationId: org.id });
  const html = renderToStaticMarkup(
    createElement(RecordProfile, {
      record: org,
      records: [org, task],
      members: [],
    }),
  );
  assert(html.includes("mailto:public@example.com"));
  const taskHtml = renderToStaticMarkup(
    createElement(RecordProfile, {
      record: task,
      records: [org, task],
      members: [],
    }),
  );
  assert(taskHtml.includes("Synthetic firm"));
  assert(taskHtml.includes("Relationships"));
});
test("related record groups retain every visible linked record and exclude unrelated records", () => {
  const project = record("projects", "Portfolio"),
    people = Array.from({ length: 650 }, (_, i) =>
      record("people", `Synthetic linked ${i}`, { projectId: project.id }),
    ),
    unrelated = record("people", "Unrelated");
  const html = renderToStaticMarkup(
    createElement(RelatedRecords, {
      record: project,
      records: [project, ...people, unrelated],
      busy: false,
      onOpen: () => {},
    }),
  );
  assert.equal((html.match(/class="related-record-link"/g) || []).length, 650);
  assert(!html.includes("Unrelated"));
  assert(!html.includes("<details open"));
});
