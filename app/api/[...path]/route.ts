import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  checkOrigin,
  cookie,
  cookieName,
  currentUser,
  hash,
  rateLimit,
  setCookie,
  startChallenge,
  verifyChallenge,
} from "@/lib/auth";
import { pool, transaction } from "@/lib/db";
import { HttpError } from "@/lib/model";
import {
  acceptInvite,
  createInvite,
  deleteRecord,
  importRecords,
  membership,
  lockActiveAccount,
  saveRecord,
  snapshot,
  updateMember,
  listInvites,
  revokeInvite,
  previewInvite,
  timeline,
} from "@/lib/service";
import {
  digestPreference,
  saveDigestPreference,
  runDigests,
} from "@/lib/digest";
import { completeRecovery } from "@/lib/recovery";
import { timingSafeEqual } from "node:crypto";
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(req: NextRequest) {
  const path = req.nextUrl.pathname.replace(/^\/api\//, "");
  const json = (
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    NextResponse.json(data, {
      status,
      headers: { "Cache-Control": "no-store", ...headers },
    });
  try {
    if (path === "cron/digest" && req.method === "GET") {
      const expected = Buffer.from("Bearer " + (process.env.CRON_SECRET || "")),
        actual = Buffer.from(req.headers.get("authorization") || "");
      if (
        !process.env.CRON_SECRET ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new HttpError(401, "Unauthorized.");
      const result = await runDigests();
      return json(result, result.failed || result.remaining ? 503 : 200);
    }
    if (path === "config" && req.method === "GET")
      return json({
        emailEnabled:
          !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) ||
          (process.env.NODE_ENV !== "production" &&
            process.env.DEV_EMAIL_CONSOLE === "true"),
        developmentEmail:
          process.env.NODE_ENV !== "production" &&
          process.env.DEV_EMAIL_CONSOLE === "true",
      });
    if (path === "health" && req.method === "GET") {
      await pool().query("SELECT id FROM workspaces LIMIT 1");
      return json({ status: "ok", version: "0.3.0" });
    }
    let body: Record<string, unknown> = {};
    if (req.method !== "GET") {
      checkOrigin(req);
      if (Number(req.headers.get("content-length") || 0) > 1_000_000)
        throw new HttpError(
          413,
          "Upload is too large. Import up to 500 rows at a time.",
        );
      const raw = await req.text();
      if (raw.length > 1_000_000)
        throw new HttpError(413, "Upload is too large.");
      body = raw ? JSON.parse(raw) : {};
    }
    if (path.startsWith("auth/") && req.method === "POST") {
      const ip = process.env.VERCEL
        ? req.headers.get("x-vercel-forwarded-for") || "unknown"
        : "local";
      await rateLimit("auth-ip:" + ip, 40);
      if (path === "auth/challenge") {
        const result = await startChallenge(
          req,
          z
            .object({
              kind: z.enum(["email", "ethereum"]),
              value: z.string().max(254),
              link: z.boolean().optional(),
              recoveryToken: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              chainId: z
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER)
                .optional(),
            })
            .parse(body),
        );
        return json(result.body, 200, { "Set-Cookie": result.cookie });
      }
      if (path === "auth/verify") {
        const result = await verifyChallenge(
          req,
          z
            .object({
              id: z.uuid(),
              proof: z.string().max(2048),
              recover: z.boolean().optional(),
            })
            .parse(body),
        );
        return json(result.body, 200, { "Set-Cookie": result.cookie });
      }
      if (path === "auth/recover") {
        const input = z
          .object({
            token: z.string().regex(/^[a-f0-9]{64}$/),
            confirm: z.literal(true),
          })
          .parse(body);
        const result = await completeRecovery(req, input.token);
        return json(result.body, 200, { "Set-Cookie": result.cookie });
      }
      if (path === "auth/logout") {
        await pool().query("DELETE FROM sessions WHERE hash=$1", [
          hash(cookie(req, cookieName)),
        ]);
        return json({ ok: true }, 200, {
          "Set-Cookie": setCookie(cookieName, "", 0),
        });
      }
    }
    const user = (await currentUser(req))!;
    if (req.method !== "GET") await rateLimit("user:" + user.id, 300);
    if (path === "me/digest" && req.method === "GET")
      return json(await digestPreference(user.id));
    if (path === "me/digest" && req.method === "PATCH")
      return json(await saveDigestPreference(user.id, body));
    if (path === "invites/preview" && req.method === "POST")
      return json(
        await previewInvite(
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(body.token),
        ),
      );
    if (path === "me" && req.method === "GET") {
      const [workspaces, identities] = await Promise.all([
        pool().query(
          "SELECT w.*,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at",
          [user.id],
        ),
        pool().query(
          "SELECT kind,value,verified_at FROM identities WHERE user_id=$1",
          [user.id],
        ),
      ]);
      return json({
        user,
        workspaces: workspaces.rows,
        identities: identities.rows,
      });
    }
    if (path === "me" && req.method === "PATCH") {
      const name = z.string().trim().min(1).max(80).parse(body.name);
      await pool().query(
        "UPDATE users SET name=$1 WHERE id=$2 AND merged_into IS NULL",
        [name, user.id],
      );
      return json({ ok: true });
    }
    if (path === "workspaces" && req.method === "POST") {
      const name = z.string().trim().min(1).max(100).parse(body.name);
      const id = randomUUID();
      await transaction(async (db) => {
        await lockActiveAccount(db, user.id);
        await db.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
          id,
          name,
        ]);
        await db.query(
          "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
          [id, user.id],
        );
      });
      return json({ id }, 201);
    }
    if (path === "invites/accept" && req.method === "POST")
      return json(
        await acceptInvite(
          user.id,
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(body.token),
        ),
      );
    const match = path.match(/^workspaces\/([^/]+)(?:\/(.+))?$/);
    if (match) {
      const [, w, resource] = match;
      z.uuid().parse(w);
      if (!resource && req.method === "GET")
        return json(await snapshot(user.id, w));
      if (!resource && req.method === "PATCH") {
        const name = z.string().trim().min(1).max(100).parse(body.name);
        await transaction(async (db) => {
          await membership(w, user.id, true, true, db);
          await db.query("UPDATE workspaces SET name=$1 WHERE id=$2", [
            name,
            w,
          ]);
        });
        return json({ ok: true });
      }
      if (resource === "records" && req.method === "POST")
        return json(await saveRecord(user.id, w, body));
      if (resource === "records" && req.method === "DELETE")
        return json(
          await deleteRecord(
            user.id,
            w,
            z.uuid().parse(body.id),
            z.number().int().positive().parse(body.version),
          ),
        );
      if (resource === "import" && req.method === "POST")
        return json(await importRecords(user.id, w, body));
      const timelineMatch = resource?.match(/^records\/([^/]+)\/timeline$/);
      if (timelineMatch && req.method === "GET")
        return json(await timeline(user.id, w, timelineMatch[1]));
      if (resource === "invites" && req.method === "GET")
        return json(await listInvites(user.id, w));
      if (resource === "invites" && req.method === "DELETE")
        return json(await revokeInvite(user.id, w, z.uuid().parse(body.id)));
      if (resource === "invites" && req.method === "POST")
        return json(await createInvite(user.id, w, body));
      if (resource === "members" && req.method === "PATCH")
        return json(await updateMember(user.id, w, body));
      if (resource === "export" && req.method === "GET") {
        const data = await snapshot(user.id, w);
        return json(
          {
            schema: "bittrees-crm-export.v1",
            exportedAt: new Date().toISOString(),
            ...data,
          },
          200,
          { "Content-Disposition": 'attachment; filename="bittrees-crm.json"' },
        );
      }
    }
    throw new HttpError(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError)
      return json(
        {
          error: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    if (e instanceof SyntaxError)
      return json({ error: "Invalid request." }, 400);
    console.error(
      "CRM request failed",
      e instanceof Error ? e.message : "Unknown error",
    );
    return json(
      { error: "The service is unavailable. Please try again shortly." },
      503,
    );
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
