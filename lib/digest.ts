import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./model";
export type DigestMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
};
export type DigestSender = (
  message: DigestMessage,
  key: string,
) => Promise<void>;
export async function saveDigestPreference(userId: string, input: unknown) {
  const body = z
    .object({ enabled: z.boolean(), email: z.string().max(254).default("") })
    .parse(input);
  const email = body.email.trim().toLowerCase();
  return transaction(async (db) => {
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
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
      "UPDATE users SET digest_enabled=$2,digest_email=$3 WHERE id=$1",
      [userId, body.enabled, email],
    );
    return { ok: true };
  });
}
export async function digestPreference(userId: string) {
  const user = (
    await pool().query(
      "SELECT digest_enabled AS enabled,digest_email AS email FROM users WHERE id=$1",
      [userId],
    )
  ).rows[0];
  const last = (
    await pool().query(
      "SELECT day,status,sent_at FROM digest_receipts WHERE user_id=$1 ORDER BY day DESC LIMIT 1",
      [userId],
    )
  ).rows[0];
  return { ...user, last: last || null };
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
      await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])
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
    const rows = (
      await db.query(
        `SELECT r.id,r.data,w.name AS workspace FROM records r JOIN members m ON m.workspace_id=r.workspace_id AND m.user_id=$1 JOIN workspaces w ON w.id=r.workspace_id
    WHERE r.data->>'ownerId'=$1::text AND r.data->>'dueDate'<>'' AND r.data->>'dueDate'<=to_char($2::date+7,'YYYY-MM-DD')
    AND ((r.kind='tasks' AND r.data->>'status'='Open') OR (r.kind='opportunities' AND r.data->>'stage' NOT IN ('Won','Lost')))
    ORDER BY r.data->>'dueDate',w.name,r.id`,
        [userId, day],
      )
    ).rows;
    if (!rows.length) return "skipped";
    const message: DigestMessage = {
      from: process.env.EMAIL_FROM || "",
      to: [user.digest_email],
      subject: `Your Bittrees CRM next steps · ${day}`,
      text: [
        `Hello ${user.name},`,
        "",
        "Your overdue and upcoming follow-ups (next 7 days):",
        "",
        ...rows
          .slice(0, 50)
          .map(
            (r) =>
              `${r.data.dueDate < day ? "Overdue" : r.data.dueDate === day ? "Today" : r.data.dueDate} · ${r.workspace} · ${r.data.nextAction || r.data.name}${r.data.nextAction ? " — " + r.data.name : ""}`,
          ),
        ...(rows.length > 50
          ? [`…and ${rows.length - 50} more in your workspace.`]
          : []),
        "",
        `Open your tasks: ${process.env.APP_URL}/?view=tasks`,
        "",
        `You opted in to this daily digest. Turn it off in Settings: ${process.env.APP_URL}/?view=settings`,
        "Dates and the daily 08:00 schedule use UTC.",
      ].join("\n"),
    };
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
      receipt.record_ids.some((id: string) => !rows.some((r) => r.id === id))
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
