import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { SiweMessage } from "siwe";
import { getAddress } from "ethers";
import { pool, transaction } from "./db";
import { HttpError } from "./model";
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export const cookieName =
  process.env.NODE_ENV === "production" ? "__Host-crm-session" : "crm-session";
const challengeCookie =
  process.env.NODE_ENV === "production"
    ? "__Host-crm-challenge"
    : "crm-challenge";
export function cookie(req: Request, name: string) {
  return (
    req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function checkOrigin(req: Request) {
  const origins = [
    process.env.APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
  ].filter(Boolean);
  const origin = req.headers.get("origin");
  if (!origin || !origins.includes(origin))
    throw new HttpError(403, "Request origin is not allowed.");
  return origin;
}
export async function currentUser(req: Request, required = true) {
  const raw = cookie(req, cookieName);
  const { rows } = raw
    ? await pool().query(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now()",
        [hash(raw)],
      )
    : { rows: [] };
  if (!rows[0] && required)
    throw new HttpError(401, "Please sign in to continue.");
  return rows[0] as { id: string; name: string } | undefined;
}
export async function rateLimit(key: string, max = 20) {
  const { rows } = await pool().query(
    `INSERT INTO rate_limits(key,hits,resets_at) VALUES($1,1,now()+interval '10 minutes') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.resets_at<now() THEN 1 ELSE rate_limits.hits+1 END,resets_at=CASE WHEN rate_limits.resets_at<now() THEN now()+interval '10 minutes' ELSE rate_limits.resets_at END RETURNING hits`,
    [hash(key)],
  );
  if (rows[0].hits > max)
    throw new HttpError(
      429,
      "Too many attempts. Please try again in ten minutes.",
    );
}
function emailDigest(id: string, code: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new HttpError(503, "Identity verification is not configured.");
  return createHmac("sha256", secret)
    .update(id + ":" + code)
    .digest("hex");
}
export async function startChallenge(
  req: Request,
  body: {
    kind: "email" | "ethereum";
    value: string;
    link?: boolean;
    chainId?: number;
  },
) {
  const origin = checkOrigin(req);
  const user = body.link ? await currentUser(req) : undefined;
  const id = randomUUID(),
    browser = token(),
    nonce = randomBytes(16).toString("hex");
  let value = body.value.trim().toLowerCase(),
    payload = "",
    secret = "";
  await rateLimit("identity:" + body.kind + ":" + value, 5);
  if (body.kind === "ethereum") {
    try {
      value = getAddress(value).toLowerCase();
    } catch {
      throw new HttpError(400, "Enter a valid Ethereum address.");
    }
    payload = new SiweMessage({
      domain: new URL(origin).host,
      address: getAddress(value),
      statement: body.link
        ? "Link this wallet to your Bittrees CRM identity."
        : "Sign in to Bittrees CRM. This does not authorize transactions.",
      uri: origin,
      version: "1",
      chainId: body.chainId || 1,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 600000).toISOString(),
    }).prepareMessage();
    secret = hash(nonce);
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254)
      throw new HttpError(400, "Enter a valid email address.");
    if (
      !(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) &&
      !(
        process.env.NODE_ENV !== "production" &&
        process.env.DEV_EMAIL_CONSOLE === "true"
      )
    )
      throw new HttpError(
        503,
        "Email sign-in is awaiting sender configuration. Ethereum sign-in is available.",
      );
    payload = String(randomInt(10000000, 100000000));
    secret = emailDigest(id, payload);
  }
  await pool().query(
    "INSERT INTO challenges(id,kind,value,secret_hash,browser_hash,user_id,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
    [
      id,
      body.kind,
      value,
      secret,
      hash(browser),
      user?.id || null,
      body.kind === "ethereum" ? payload : null,
    ],
  );
  if (body.kind === "email") {
    if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM,
          to: [value],
          subject: "Your Bittrees CRM sign-in code",
          text: `Your Bittrees CRM verification code is ${payload}. It expires in 10 minutes. If you did not request this code, ignore this email.`,
        }),
      });
      if (!response.ok) {
        await pool().query("DELETE FROM challenges WHERE id=$1", [id]);
        throw new HttpError(
          503,
          "We could not deliver the code. Please try again later.",
        );
      }
    } else {
      console.info(`[LOCAL EMAIL ONLY] ${value}: ${payload}`);
    }
  }
  return {
    body: { id, message: body.kind === "ethereum" ? payload : undefined },
    cookie: setCookie(challengeCookie, browser, 600),
  };
}
export async function verifyChallenge(
  req: Request,
  body: { id: string; proof: string },
) {
  checkOrigin(req);
  const browser = cookie(req, challengeCookie),
    activeUser = await currentUser(req, false);
  const sessionToken = token();
  const result = await transaction(async (db) => {
    const { rows } = await db.query(
      "SELECT * FROM challenges WHERE id=$1 FOR UPDATE",
      [body.id],
    );
    const c = rows[0];
    if (
      !c ||
      c.consumed ||
      new Date(c.expires_at).getTime() < Date.now() ||
      c.attempts >= 5 ||
      c.browser_hash !== hash(browser)
    )
      return { error: "This verification has expired. Start again." };
    if (c.user_id && c.user_id !== activeUser?.id)
      return { error: "Sign in again before linking an identity." };
    await db.query("UPDATE challenges SET attempts=attempts+1 WHERE id=$1", [
      c.id,
    ]);
    let valid = false;
    if (c.kind === "email") {
      const expected = Buffer.from(c.secret_hash),
        actual = Buffer.from(emailDigest(c.id, body.proof));
      valid =
        expected.length === actual.length && timingSafeEqual(expected, actual);
    } else {
      try {
        if (!/^0x[a-fA-F0-9]{130}$/.test(body.proof))
          return { error: "Verification failed. Check the code or signature." };
        const message = new SiweMessage(c.payload);
        const verification = await message.verify({
          signature: body.proof,
          domain: message.domain,
          nonce: message.nonce,
        });
        valid =
          verification.success &&
          message.uri === req.headers.get("origin") &&
          hash(message.nonce) === c.secret_hash &&
          message.address.toLowerCase() === c.value;
      } catch {
        valid = false;
      }
    }
    if (!valid)
      return { error: "Verification failed. Check the code or signature." };
    // Serialize identity creation/linking even when two valid challenges race.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      c.kind + ":" + c.value,
    ]);
    const existing = (
      await db.query(
        "SELECT user_id FROM identities WHERE kind=$1 AND value=$2",
        [c.kind, c.value],
      )
    ).rows[0];
    if (c.user_id && existing && existing.user_id !== c.user_id)
      return {
        error:
          "This identity already belongs to another account. Accounts are never merged automatically.",
      };
    let userId = c.user_id || existing?.user_id;
    if (!userId) {
      userId = randomUUID();
      const workspaceId = randomUUID();
      await db.query("INSERT INTO users(id,name) VALUES($1,$2)", [
        userId,
        c.kind === "email"
          ? c.value.split("@")[0]
          : c.value.slice(0, 6) + "…" + c.value.slice(-4),
      ]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
        workspaceId,
        "My workspace",
      ]);
      await db.query(
        "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
    }
    if (!existing)
      await db.query(
        "INSERT INTO identities(kind,value,user_id) VALUES($1,$2,$3)",
        [c.kind, c.value, userId],
      );
    await db.query("UPDATE challenges SET consumed=true WHERE id=$1", [c.id]);
    await db.query(
      "INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [hash(sessionToken), userId],
    );
    // Linking or signing in rotates the browser session.
    await db.query("DELETE FROM sessions WHERE hash=$1", [
      hash(cookie(req, cookieName)),
    ]);
    return { userId };
  });
  if (result.error) throw new HttpError(400, result.error);
  return {
    body: { ok: true },
    cookie: setCookie(cookieName, sessionToken, 604800),
  };
}
