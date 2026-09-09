import { accessIds, type Db } from "./access";
import { digestOptionsSchema, type DigestOptions } from "./digest-options";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./model";
export type DigestMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
};
export type DigestSender = (
  message: DigestMessage,
  key: string,
) => Promise<void>;
export async function saveDigestPreference(userId: string, input: unknown) {
  const body = z
    .object({
      enabled: z.boolean(),
      email: z.string().max(254).default(""),
      options: digestOptionsSchema.optional(),
    })
    .parse(input);
  const email = body.email.trim().toLowerCase();
  return transaction(async (db) => {
    const account = (
      await db.query(
        "SELECT id,merged_into FROM users WHERE id=$1 FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (!account || account.merged_into)
      throw new HttpError(
        401,
        "Your account changed. Sign in again to continue.",
      );
    if (
      body.enabled &&
      !(
        await db.query(
          "SELECT value FROM identities WHERE user_id=$1 AND kind='email' AND value=$2",
          [userId, email],
        )
      ).rowCount
    )
      throw new HttpError(
        400,
        "Link and verify this email before enabling reminders.",
      );
    await db.query(
      "UPDATE users SET digest_enabled=$2,digest_email=$3,digest_options=COALESCE($4::jsonb,digest_options) WHERE id=$1",
      [
        userId,
        body.enabled,
        email,
        body.options ? JSON.stringify(body.options) : null,
      ],
    );
    await db.query(
      "UPDATE digest_receipts SET status='cancelled' WHERE user_id=$1 AND status IN ('pending','failed')",
      [userId],
    );
    return { ok: true };
  });
}
export async function digestPreference(userId: string) {
  const user = (
    await pool().query(
      "SELECT digest_enabled AS enabled,digest_email AS email,digest_options AS options FROM users WHERE id=$1",
      [userId],
    )
  ).rows[0];
  const last = (
    await pool().query(
      "SELECT day,status,sent_at FROM digest_receipts WHERE user_id=$1 ORDER BY day DESC LIMIT 1",
      [userId],
    )
  ).rows[0];
  return {
    ...user,
    options: digestOptionsSchema.parse(user.options),
    last: last || null,
  };
}
export async function sendViaResend(message: DigestMessage, key: string) {
  if (!process.env.RESEND_API_KEY)
    throw new Error("Email service is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(message),
  });
  if (!response.ok)
    throw new Error(`Email provider returned ${response.status}`);
}
export async function sendDigest(
  userId: string,
  day: string,
  send: DigestSender = sendViaResend,
) {
  z.iso.date().parse(day);
  return transaction(async (db) => {
    const user = (
      await db.query("SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE", [
        userId,
      ])
    ).rows[0];
    if (!user?.digest_enabled || !user.digest_email) return "skipped";
    if (
      !(
        await db.query(
          "SELECT value FROM identities WHERE user_id=$1 AND kind='email' AND value=$2",
          [userId, user.digest_email],
        )
      ).rowCount
    )
      return "skipped";
    const options = digestOptionsSchema.parse(user.digest_options);
    if (
      options.weekdaysOnly &&
      [0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay())
    )
      return "skipped";
    const rows = await digestRows(db, userId, day, options);
    if (!rows.length) return "skipped";
    const message = digestMessage(user, day, rows, options);
    await db.query(
      "INSERT INTO digest_receipts(user_id,day,payload,record_ids) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [userId, day, message, rows.slice(0, 50).map((r) => r.id)],
    );
    const receipt = (
      await db.query(
        "SELECT * FROM digest_receipts WHERE user_id=$1 AND day=$2 FOR UPDATE",
        [userId, day],
      )
    ).rows[0];
    if (["sent", "cancelled"].includes(receipt.status)) return "skipped";
    // Keep retries byte-for-byte identical, but never resend work after access/ownership or the recipient changed.
    if (
      receipt.payload.to[0] !== user.digest_email ||
      receipt.record_ids.some((id: string) => !rows.some((r) => r.id === id)) ||
      receipt.payload.text !== message.text
    ) {
      await db.query(
        "UPDATE digest_receipts SET status='cancelled' WHERE user_id=$1 AND day=$2",
        [userId, day],
      );
      return "skipped";
    }
    try {
      await send(receipt.payload, `crm-digest/${userId}/${day}`);
      await db.query(
        "UPDATE digest_receipts SET status='sent',sent_at=now(),attempts=attempts+1,last_error=NULL WHERE user_id=$1 AND day=$2",
        [userId, day],
      );
      return "sent";
    } catch (e) {
      await db.query(
        "UPDATE digest_receipts SET status='failed',attempts=attempts+1,last_error=$3 WHERE user_id=$1 AND day=$2",
        [userId, day, (e as Error).message.slice(0, 200)],
      );
      return "failed";
    }
  });
}
export async function runDigests() {
  const day = new Date().toISOString().slice(0, 10),
    started = Date.now();
  const users = (
    await pool().query(
      "SELECT id FROM users WHERE digest_enabled=true ORDER BY id",
    )
  ).rows;
  const result = { sent: 0, skipped: 0, failed: 0, remaining: 0 };
  for (let i = 0; i < users.length; i++) {
    if (Date.now() - started > 240000) {
      result.remaining = users.length - i;
      break;
    }
    const status = await sendDigest(users[i].id, day);
    result[status]++;
    if (status !== "skipped") await new Promise((r) => setTimeout(r, 600));
  }
  return result;
}

type DigestRow = {
  id: string;
  workspace_id: string;
  workspace: string;
  kind: string;
  data: any;
  context: string;
  owner: string;
};
async function digestRows(
  db: Db,
  user: string,
  day: string,
  options: DigestOptions,
): Promise<DigestRow[]> {
  const workspaces = (
    await db.query(
      "SELECT w.id,w.name FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.id FOR SHARE OF w",
      [user],
    )
  ).rows;
  const rows: DigestRow[] = [];
  const end = new Date(day + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + options.daysAhead);
  for (const workspace of workspaces) {
    if (
      options.workspaceIds !== null &&
      !options.workspaceIds.includes(workspace.id)
    )
      continue;
    const ids = await accessIds(db, user, workspace.id);
    const visible = (
      await db.query(
        "SELECT id,kind,data FROM records WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2))",
        [workspace.id, ids],
      )
    ).rows;
    const members = (
      await db.query(
        "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=$1",
        [workspace.id],
      )
    ).rows;
    for (const r of visible) {
      if (
        !options.kinds.includes(r.kind) ||
        !r.data.dueDate ||
        r.data.dueDate > end.toISOString().slice(0, 10) ||
        (!options.includeOverdue && r.data.dueDate < day) ||
        (options.assignment === "mine" && r.data.ownerId !== user)
      )
        continue;
      if (
        (r.kind === "tasks" && r.data.status !== "Open") ||
        (r.kind === "opportunities" && ["Won", "Lost"].includes(r.data.stage))
      )
        continue;
      const context = [
        ...new Set(
          [r.data.projectId, r.data.organizationId]
            .map((id) => visible.find((p) => p.id === id)?.data.name)
            .filter(Boolean),
        ),
      ].join(" · ");
      rows.push({
        ...r,
        workspace_id: workspace.id,
        workspace: workspace.name,
        context,
        owner:
          members.find((m) => m.id === r.data.ownerId)?.name || "Unassigned",
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.data.dueDate.localeCompare(b.data.dueDate) ||
      a.workspace.localeCompare(b.workspace) ||
      a.id.localeCompare(b.id),
  );
}
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function digestMessage(
  user: any,
  day: string,
  rows: DigestRow[],
  options: DigestOptions,
): DigestMessage {
  const sections = [
    ["Overdue", rows.filter((r) => r.data.dueDate < day)],
    ["Due today", rows.filter((r) => r.data.dueDate === day)],
    ["Upcoming", rows.filter((r) => r.data.dueDate > day)],
  ] as const;
  const shown = new Set(rows.slice(0, 50).map((r) => r.id));
  const lines = [
    `Hello ${user.name},`,
    "",
    `${rows.length} follow-up${rows.length === 1 ? "" : "s"} · ${options.assignment === "mine" ? "Assigned to you" : "All accessible work"} · ${day}`,
    "",
  ];
  for (const [heading, items] of sections) {
    if (!items.length) continue;
    lines.push(`${heading} (${items.length})`, "");
    for (const r of items.filter((r) => shown.has(r.id))) {
      const link = new URL(process.env.APP_URL!);
      link.search = new URLSearchParams({
        workspace: r.workspace_id,
        view: r.kind,
        record: r.id,
      }).toString();
      lines.push(
        `${r.data.name} · ${r.kind === "tasks" ? "Task" : r.data.stage}`,
        `${r.workspace}${r.context ? " · " + r.context : ""} · ${r.owner} · Due ${r.data.dueDate}`,
        ...(r.data.nextAction ? [`Next step: ${r.data.nextAction}`] : []),
        link.toString(),
        "",
      );
    }
  }
  if (rows.length > 50)
    lines.push(
      `${rows.length - 50} more follow-ups are available in your CRM.`,
      "",
    );
  lines.push(
    `Look-ahead: ${options.daysAhead} days. Dates and the 08:00 delivery schedule use UTC.`,
    `Manage your preferences: ${process.env.APP_URL}/?view=settings`,
  );
  return {
    from: process.env.EMAIL_FROM || "",
    to: [user.digest_email],
    subject: `Bittrees follow-ups · ${sections[0][1].length} overdue · ${sections[1][1].length} today · ${day}`,
    text: lines.join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#173c2c;max-width:640px;margin:auto"><h1 style="font-size:24px">Your next steps</h1>${lines.map((line) => (/^https?:\/\//.test(line) ? `<p><a href="${escapeHtml(line)}">Open this record →</a></p>` : `<div style="margin-bottom:8px;white-space:pre-wrap">${escapeHtml(line)}</div>`)).join("")}</div>`,
  };
}
export async function previewDigest(userId: string, input: unknown) {
  const options = digestOptionsSchema.parse(input);
  return transaction(async (db) => {
    const user = (
      await db.query("SELECT * FROM users WHERE id=$1 FOR SHARE", [userId])
    ).rows[0];
    const day = new Date().toISOString().slice(0, 10);
    const rows = await digestRows(db, userId, day, options);
    return {
      text: rows.length
        ? digestMessage(user, day, rows, options).text
        : "No follow-ups match these settings today. No email would be sent.",
      count: rows.length,
    };
  });
}
