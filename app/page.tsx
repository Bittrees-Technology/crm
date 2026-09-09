"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  walletIdentity,
  walletError,
  type EthereumProvider,
} from "@/lib/auth-client";
import Papa from "papaparse";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CirclePlus,
  Clock3,
  ContactRound,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sprout,
  TrendingUp,
  Users,
  Wallet,
  X,
  Building2,
  FileText,
  LayoutGrid,
  List,
  Mail,
  LockKeyhole,
} from "lucide-react";
import {
  recordSchema,
  stages,
  type CrmRecord,
  type Kind,
  type RecordData,
} from "@/lib/model";

import {
  QuickActions,
  BackupIdentity,
  RelationshipTimeline,
  DigestSettings,
  InviteManager,
} from "./components/coordination";

type SavedView = {
  name: string;
  page: Page;
  search: string;
  filter: string;
  board: boolean;
};
type Member = { id: string; name: string; role: string };
type Me = {
  user: { id: string; name: string };
  workspaces: { id: string; name: string; role: string }[];
  identities: { kind: string; value: string }[];
};
type Snapshot = {
  role: string;
  records: CrmRecord[];
  members: Member[];
  audit: {
    id: string;
    action: string;
    actor: string;
    created_at: string;
    detail: { name?: string };
  }[];
};
type Page = "today" | Kind | "reports" | "settings";
const labels: Record<Page, string> = {
  today: "Today",
  people: "People",
  organizations: "Organizations",
  opportunities: "Opportunities",
  projects: "Projects",
  tasks: "Tasks",
  notes: "Notes",
  reports: "Reports",
  settings: "Settings",
};
const icons: Record<Page, typeof Users> = {
  today: LayoutDashboard,
  people: ContactRound,
  organizations: Building2,
  opportunities: TrendingUp,
  projects: FolderOpen,
  tasks: ListTodo,
  notes: FileText,
  reports: LayoutGrid,
  settings: Settings2,
};
const demoUser = "00000000-0000-4000-8000-000000000001";
const demoOrg = "00000000-0000-4000-8000-000000000002";
const demoProject = "00000000-0000-4000-8000-000000000003";
const today = () => new Date().toLocaleDateString("en-CA");
const relativeDate = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const dateLabel = (v: string) =>
  v
    ? new Date(v + "T12:00:00").toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "No date";
const money = (v: number, c = "EUR") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: c,
    maximumFractionDigits: 2,
  }).format(v);
const initials = (s: string) =>
  s
    .split(/[ @]/)
    .slice(0, 2)
    .map((v) => v[0])
    .join("")
    .toUpperCase();
async function api(path: string, method = "GET", body?: unknown) {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      signal: AbortSignal.timeout(15000),
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      (e as Error).name === "TimeoutError"
        ? "The request took too long. Your changes may have saved; refresh before trying again."
        : "Could not connect. Check your connection and try again.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The service returned an unreadable response. Refresh to check your changes before trying again.",
    );
  }
  if (response.status === 401 && !path.startsWith("auth/"))
    window.dispatchEvent(new Event("crm-session-expired"));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function demoRecords(): CrmRecord[] {
  const rows: [Kind, Partial<RecordData> & { name: string }, string?][] = [
    [
      "organizations",
      {
        name: "Northstar Labs",
        category: "Technology partner",
        website: "https://example.com",
        description: "Fictional organization for this demo.",
      },
      demoOrg,
    ],
    [
      "organizations",
      { name: "Fieldwork Collective", category: "Research partner" },
    ],
    [
      "projects",
      {
        name: "Partner pilot",
        category: "Partnerships",
        description: "Explore a shared product pilot.",
      },
      demoProject,
    ],
    [
      "people",
      {
        name: "Alex Morgan",
        email: "alex@example.com",
        title: "Co-founder",
        organizationId: demoOrg,
        communication: "Allowed",
      },
    ],
    [
      "people",
      { name: "Sam Rivera", email: "sam@example.com", title: "Research lead" },
    ],
    [
      "people",
      {
        name: "Jordan Lee",
        email: "jordan@example.com",
        title: "Community builder",
      },
    ],
    [
      "opportunities",
      {
        name: "Northstar product pilot",
        organizationId: demoOrg,
        projectId: demoProject,
        category: "Partnership",
        stage: "Discovery",
        value: 12000,
        nextAction: "Share the pilot outline",
        dueDate: relativeDate(0),
      },
    ],
    [
      "opportunities",
      {
        name: "Research collaboration",
        category: "Research",
        stage: "Qualified",
        nextAction: "Agree on research questions",
        dueDate: relativeDate(2),
      },
    ],
    [
      "opportunities",
      {
        name: "Community workshop",
        category: "Partnership",
        stage: "Proposal",
        value: 2400,
        nextAction: "Review workshop proposal",
        dueDate: relativeDate(-2),
      },
    ],
    [
      "tasks",
      {
        name: "Prepare the partner briefing",
        dueDate: relativeDate(0),
        projectId: demoProject,
      },
    ],
    ["tasks", { name: "Follow up with Jordan", dueDate: relativeDate(1) }],
    [
      "notes",
      {
        name: "Discovery conversation",
        organizationId: demoOrg,
        description:
          "The team is interested in a small, focused pilot. Next step: share an outline with scope, timing, and a clear owner.",
      },
    ],
  ];
  return rows.map(([kind, data, id]) => ({
    id: id || crypto.randomUUID(),
    kind,
    data: recordSchema.parse({ ownerId: demoUser, ...data }),
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={wide ? "modal wide" : "modal"}
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Sprout size={23} />
      </span>
      <span>
        bittrees<span className="brand-sub">CRM</span>
      </span>
    </div>
  );
}
type RecoveryAccount = {
  name: string;
  identities: { kind: string; value: string }[];
  workspaces: { id: string; name: string; role: string; records: number }[];
};
type RecoveryPreview = {
  token: string;
  current: RecoveryAccount;
  other: RecoveryAccount;
};
function AccountRecovery({
  preview,
  onSuccess,
  onCancel,
}: {
  preview: RecoveryPreview;
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"review" | "verify" | "confirm">("review");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (phase === "verify")
    return (
      <Auth
        link
        recoveryToken={preview.token}
        allowedIdentities={preview.current.identities}
        initialEmail={
          preview.current.identities.find((i) => i.kind === "email")?.value ||
          ""
        }
        onSuccess={() => setPhase("confirm")}
        onClose={() => setPhase("review")}
      />
    );
  return (
    <div className="auth-form recovery-form">
      <span className="eyebrow">ACCOUNT RECOVERY</span>
      <h1>Two accounts, one person?</h1>
      <p>
        You verified a sign-in method that belongs to another account. You can
        combine them after verifying your current account too.
      </p>
      {[
        ["Your current account", preview.current],
        ["The other account", preview.other],
      ].map(([title, account]) => {
        const a = account as RecoveryAccount;
        return (
          <section className="recovery-account" key={title as string}>
            <h3>
              {title as string}: {a.name}
            </h3>
            <ul className="verified-methods">
              {a.identities.map((i) => (
                <li key={i.kind + i.value}>
                  {i.kind === "email" ? "Email" : "Wallet"}: {i.value}
                </li>
              ))}
            </ul>
            <p className="small">
              {a.workspaces.length} workspace
              {a.workspaces.length === 1 ? "" : "s"}
            </p>
            <ul>
              {a.workspaces.map((w) => (
                <li key={w.id}>
                  {w.name} · {w.role} · {w.records} records
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="small">
        All sign-in methods and workspace access will use your current account.
        Workspaces stay separate, records are kept, and assigned work moves to
        your current account. Other sessions are signed out and daily digests
        turn off. Combining cannot be undone in the app.
      </p>
      {phase === "confirm" && (
        <p className="verified" role="status">
          Both accounts verified. Review the details above before combining.
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="recovery-actions">
        <button
          className="button primary full"
          disabled={busy}
          onClick={async () => {
            if (phase === "review") {
              setPhase("verify");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await api("auth/recover", "POST", {
                token: preview.token,
                confirm: true,
              });
              await onSuccess();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Combining accounts…"
            : phase === "confirm"
              ? "Confirm and combine accounts"
              : "Verify current account"}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={onCancel}
        >
          Keep accounts separate
        </button>
      </div>
    </div>
  );
}
function Auth({
  onSuccess,
  link = false,
  onClose,
  onDemo,
  initialEmail = "",
  invitation = false,
  recoveryToken,
  allowedIdentities,
  compact = false,
}: {
  onSuccess: () => void | Promise<void>;
  link?: boolean;
  onClose?: () => void;
  onDemo?: () => void;
  initialEmail?: string;
  invitation?: boolean;
  compact?: boolean;
  recoveryToken?: string;
  allowedIdentities?: { kind: string; value: string }[];
}) {
  const [email, setEmail] = useState(initialEmail),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState(""),
    [operation, setOperation] = useState(""),
    [error, setError] = useState(""),
    [config, setConfig] = useState({
      emailEnabled: false,
      developmentEmail: false,
    });
  const flow = useRef<{ id: number; controller: AbortController } | null>(null);
  const nextFlow = useRef(0);
  const [recovery, setRecovery] = useState<RecoveryPreview | null>(null);
  const busy = !!operation;
  useEffect(() => {
    api("config")
      .then(setConfig)
      .catch(() => setError("Could not load sign-in options. Please refresh."));
    return () => flow.current?.controller.abort();
  }, []);
  function cancel() {
    flow.current?.controller.abort();
    flow.current = null;
    setOperation("");
    setError(
      "Verification cancelled. Dismiss any open wallet request before retrying or using email.",
    );
  }
  async function run(
    type: string,
    fn: (
      request: (path: string, body: unknown) => Promise<any>,
      signal: AbortSignal,
      step: (s: string) => void,
    ) => Promise<void>,
  ) {
    const current = {
      id: ++nextFlow.current,
      controller: new AbortController(),
    };
    flow.current?.controller.abort();
    flow.current = current;
    setOperation(type);
    setError("");
    const isCurrent = () => flow.current?.id === current.id;
    const request = async (path: string, body: unknown) => {
      if (!isCurrent() || current.controller.signal.aborted)
        throw new Error("Verification cancelled.");
      const r = await fetch("/api/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          path === "auth/challenge" && recoveryToken
            ? { ...(body as object), recoveryToken }
            : body,
        ),
        signal: AbortSignal.any([
          current.controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Verification failed.");
      return data;
    };
    try {
      await fn(request, current.controller.signal, (s) => {
        if (isCurrent()) setOperation(s);
      });
    } catch (e) {
      if (isCurrent())
        setError(
          (e as Error).name === "TimeoutError"
            ? "The service took too long. Please retry."
            : walletError(e),
        );
    } finally {
      if (isCurrent()) {
        setOperation("");
        flow.current = null;
      }
    }
  }
  function emailSubmit(e: FormEvent) {
    e.preventDefault();
    void run(challenge ? "email-verify" : "email-send", async (request) => {
      if (challenge) {
        const result = await request("auth/verify", {
          id: challenge,
          proof: code,
          recover: link,
        });
        if (result.recovery) setRecovery(result.recovery);
        else await onSuccess();
      } else {
        const r = await request("auth/challenge", {
          kind: "email",
          value: email,
          link,
        });
        setChallenge(r.id);
      }
    });
  }
  function wallet() {
    void run("wallet-connect", async (request, signal, step) => {
      const ethereum = (window as unknown as { ethereum?: EthereumProvider })
        .ethereum;
      if (!ethereum)
        throw new Error(
          "No Ethereum wallet is available in this browser. Open this site in your wallet browser or a browser with your wallet extension enabled. Email sign-in works here too.",
        );
      const result = await walletIdentity(
        ethereum,
        signal,
        step,
        request,
        link,
      );
      if (!signal.aborted) {
        if (result.recovery) setRecovery(result.recovery);
        else await onSuccess();
      }
    });
  }
  const walletStatus: Record<string, string> = {
    "wallet-connect": "Open your wallet to connect…",
    "wallet-sign": "Approve the sign-in message in your wallet…",
    "wallet-verify": "Confirming your identity…",
  };
  if (recovery)
    return (
      <AccountRecovery
        preview={recovery}
        onSuccess={onSuccess}
        onCancel={() => {
          setRecovery(null);
          setChallenge("");
          setCode("");
          setError("");
        }}
      />
    );
  const form = (
    <div className="auth-form">
      <span className="eyebrow">
        <LockKeyhole size={14} /> YOUR IDENTITY, VERIFIED
      </span>
      {invitation && (
        <div className="invite-banner">
          You have a workspace invitation. Sign in with the invited email, or
          sign in with your wallet and link that email.
        </div>
      )}
      <h1>
        {recoveryToken
          ? "Verify your current account"
          : link
            ? "Connect another identity"
            : "Welcome to your next chapter."}
      </h1>
      <p>
        {recoveryToken
          ? "Use one of the sign-in methods listed below. This verifies your current account before the final confirmation."
          : link
            ? "Verify an email or Ethereum wallet to use either one with your existing account."
            : "A clear view of your relationships. A place for every next step."}
      </p>
      {!link && !compact && (
        <p className="small">
          First time? Signing in creates a private account. If you already use
          CRM, sign in with your existing method and add another in Settings.
        </p>
      )}
      {allowedIdentities && (
        <ul className="verified-methods">
          {allowedIdentities.map((i) => (
            <li key={i.kind + i.value}>
              {i.kind === "email" ? "Email" : "Wallet"}: {i.value}
            </li>
          ))}
        </ul>
      )}
      {(!allowedIdentities ||
        allowedIdentities.some((i) => i.kind === "ethereum")) && (
        <button
          disabled={busy}
          className="button wallet-button"
          onClick={wallet}
        >
          <Wallet size={19} />
          {operation.startsWith("wallet-")
            ? walletStatus[operation]
            : recoveryToken
              ? "Verify current wallet"
              : link
                ? "Link Ethereum wallet"
                : "Sign in with Ethereum"}
          <ArrowUpRight size={16} />
        </button>
      )}
      {operation.startsWith("wallet-") && (
        <div className="verification-progress" role="status">
          <p>{walletStatus[operation]}</p>
          <p className="small">
            The request may be behind this window. Open your wallet extension or
            wallet app.
          </p>
          {operation !== "wallet-verify" && (
            <button type="button" className="text-button" onClick={cancel}>
              Cancel wallet request / use email
            </button>
          )}
        </div>
      )}
      {(!allowedIdentities ||
        allowedIdentities.some((i) => i.kind === "email")) && (
        <>
          <div className="separator">
            <span>continue with email</span>
          </div>
          <form onSubmit={emailSubmit}>
            <label>
              Email address
              <input
                type="email"
                required
                value={email}
                disabled={!!challenge || busy || !config.emailEnabled}
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {challenge && (
              <p className="small" role="status">
                Code sent to {email}. Check your inbox and spam folder. It
                expires in 10 minutes.
              </p>
            )}
            {challenge && (
              <label>
                Verification code
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  maxLength={8}
                  required
                  placeholder="8-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )}
            <button
              className="button primary full"
              disabled={busy || !config.emailEnabled}
            >
              {operation === "email-send"
                ? "Sending code…"
                : operation === "email-verify"
                  ? "Checking code…"
                  : challenge
                    ? "Verify and continue"
                    : "Send verification code"}
              <ArrowRight size={17} />
            </button>
            {challenge && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setChallenge("");
                  setCode("");
                }}
              >
                Use a different email or request a new code
              </button>
            )}
          </form>
        </>
      )}
      {!config.emailEnabled && (
        <p className="small">
          Email delivery is being configured. You can sign in with an Ethereum
          wallet now.
        </p>
      )}
      {config.developmentEmail && (
        <p className="small">
          Local development: verification codes appear in the server console.
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="auth-foot">
        <ShieldCheck size={16} />
        <span>No passwords. Wallet sign-in never requests a transaction.</span>
      </div>
      {onDemo && (
        <button className="text-button" onClick={onDemo}>
          Explore with fictional demo data <ArrowRight size={15} />
        </button>
      )}
      {onClose && (
        <button className="text-button" onClick={onClose}>
          Cancel
        </button>
      )}
    </div>
  );
  if (link || compact) return form;
  return (
    <main className="auth">
      <div className="auth-left">
        <Brand />
        {form}
        <footer>Independent software. Open source. MIT licensed.</footer>
      </div>
      <aside className="auth-story">
        <div className="story-top">
          <span className="pill light">THE RELATIONSHIP WORKSPACE</span>
          <span>01 / CRM</span>
        </div>
        <h2>
          Good relationships.
          <br />
          <em>Real momentum.</em>
        </h2>
        <p>Keep the people, the context, and the next step together.</p>
        <div className="story-card">
          <div className="story-card-title">
            <span className="avatar">NL</span>
            <div>
              <strong>Northstar Labs</strong>
              <small>Example partnership</small>
            </div>
            <span className="badge">Discovery</span>
          </div>
          <div className="story-timeline">
            <div>
              <span className="dot done" />
              <div>
                <strong>A conversation starts</strong>
                <small>Introduction recorded</small>
              </div>
            </div>
            <div>
              <span className="dot done" />
              <div>
                <strong>A shared direction</strong>
                <small>Opportunity scoped</small>
              </div>
            </div>
            <div>
              <span className="dot" />
              <div>
                <strong>One clear next step</strong>
                <small>Share the pilot outline</small>
              </div>
              <ArrowUpRight size={19} />
            </div>
          </div>
        </div>
        <div className="story-bottom">
          <Network size={20} />
          <span>People → possibilities → progress</span>
        </div>
      </aside>
    </main>
  );
}
export default function App() {
  const [me, setMe] = useState<Me | null>(null),
    [loading, setLoading] = useState(true),
    [demo, setDemo] = useState(false),
    [workspace, setWorkspace] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot>({
      role: "viewer",
      records: [],
      members: [],
      audit: [],
    });
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [page, setPage] = useState<Page>("today"),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [board, setBoard] = useState(true),
    [mobile, setMobile] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{
      kind: Kind;
      record?: CrmRecord;
      stage?: RecordData["stage"];
    } | null>(null),
    [linking, setLinking] = useState(false),
    [importing, setImporting] = useState(false),
    [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [reauth, setReauth] = useState(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  useEffect(() => {
    const expired = () => {
      if (me && !demo) setReauth(true);
    };
    window.addEventListener("crm-session-expired", expired);
    return () => window.removeEventListener("crm-session-expired", expired);
  }, [me, demo]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const [inviteRevision, setInviteRevision] = useState(0),
    [inviteInfo, setInviteInfo] = useState<{
      name: string;
      email: string;
      role: string;
    } | null>(null),
    [inviteError, setInviteError] = useState("");
  const [inviteToken, setInviteToken] = useState(""),
    [inviteUrl, setInviteUrl] = useState("");
  useEffect(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(`crm-views:${me?.user.id}:${workspace}`) || "[]",
      );
      setSavedViews(
        Array.isArray(stored)
          ? stored
              .filter(
                (v) =>
                  v &&
                  typeof v.name === "string" &&
                  typeof v.page === "string" &&
                  Object.hasOwn(labels, v.page) &&
                  typeof v.search === "string" &&
                  typeof v.filter === "string" &&
                  typeof v.board === "boolean",
              )
              .slice(-20)
          : [],
      );
    } catch {
      setSavedViews([]);
    }
  }, [me?.user.id, workspace]);
  function saveView() {
    const name = window.prompt("Name this view (saved in this browser)");
    if (!name?.trim()) return;
    const next = [
      ...savedViews.filter((v) => v.name !== name.trim()),
      { name: name.trim().slice(0, 80), page, search, filter, board },
    ].slice(-20);
    setSavedViews(next);
    try {
      localStorage.setItem(
        `crm-views:${me?.user.id}:${workspace}`,
        JSON.stringify(next),
      );
      notify("View saved in this browser.");
    } catch {
      setError("This browser could not save view preferences.");
    }
  }
  async function loadMe() {
    const m = await api("me");
    setMe(m);
    setWorkspace((w) =>
      m.workspaces.some((a: { id: string }) => a.id === w)
        ? w
        : m.workspaces[0]?.id || "",
    );
    return m;
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setInviteToken(params.get("invite") || "");
    if (Object.hasOwn(labels, params.get("view") || ""))
      setPage(params.get("view") as Page);
    if (params.has("demo")) {
      startDemo();
      setLoading(false);
    } else {
      loadMe()
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []);
  useEffect(() => {
    let live = true;
    setInviteInfo(null);
    setInviteError("");
    if (inviteToken && me && !demo)
      api("invites/preview", "POST", { token: inviteToken })
        .then((d) => {
          if (live) setInviteInfo(d);
        })
        .catch((e) => {
          if (live) setInviteError(e.message);
        });
    return () => {
      live = false;
    };
  }, [inviteToken, me?.user.id, demo]);
  useEffect(() => {
    const pop = () => {
      const view =
        new URLSearchParams(window.location.search).get("view") || "today";
      if (Object.hasOwn(labels, view)) {
        setPage(view as Page);
        setSearch("");
        setFilter("all");
        setMobile(false);
      }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  async function createInvitation(email: string, role: string) {
    const r = await api("workspaces/" + workspace + "/invites", "POST", {
      email,
      role,
    });
    setInviteUrl(window.location.origin + "/?invite=" + r.token);
    setInviteRevision((v) => v + 1);
    notify(
      "New invitation link ready. Copy it and share it with the recipient.",
    );
  }
  async function quickUpdate(record: CrmRecord, patch: Partial<RecordData>) {
    setBusy(true);
    setError("");
    try {
      if (demo)
        setSnapshot((s) => ({
          ...s,
          records: s.records.map((r) =>
            r.id === record.id
              ? {
                  ...r,
                  data: { ...r.data, ...patch },
                  version: r.version + 1,
                  updated_at: new Date().toISOString(),
                }
              : r,
          ),
        }));
      else {
        await api("workspaces/" + workspace + "/records", "POST", {
          id: record.id,
          kind: record.kind,
          version: record.version,
          data: { ...record.data, ...patch },
        });
        await refresh();
      }
      notify("Updated.");
    } catch (e) {
      setError((e as Error).message);
      if (!demo) await refresh().catch(() => {});
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!workspace || demo) return;
    const requested = workspace;
    const s = await api("workspaces/" + requested);
    if (workspaceRef.current === requested) setSnapshot(s);
  }
  useEffect(() => {
    let cancelled = false;
    setSearch("");
    setFilter("all");
    setEditing(null);
    setInviteUrl("");
    if (workspace && !demo) {
      setSnapshot({ role: "viewer", records: [], members: [], audit: [] });
      setBusy(true);
      api("workspaces/" + workspace)
        .then((s) => {
          if (!cancelled) setSnapshot(s);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [workspace, demo]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  function startDemo() {
    setDemo(true);
    setMe({
      user: { id: demoUser, name: "Taylor" },
      workspaces: [{ id: "demo", name: "Bittrees · Demo", role: "owner" }],
      identities: [],
    });
    setWorkspace("demo");
    setSnapshot({
      role: "owner",
      records: demoRecords(),
      members: [{ id: demoUser, name: "Taylor", role: "owner" }],
      audit: [],
    });
  }
  function notify(s: string) {
    setNotice(s);
    setError("");
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const records = snapshot.records,
    canEdit = snapshot.role !== "viewer";
  const nameOf = (id: string) =>
    records.find((r) => r.id === id)?.data.name || "—";
  const ownerOf = (id: string) =>
    snapshot.members.find((m) => m.id === id)?.name || "Unassigned";
  const due = records.filter(
    (r) =>
      ((r.kind === "tasks" && r.data.status !== "Done") ||
        (r.kind === "opportunities" &&
          !["Won", "Lost"].includes(r.data.stage))) &&
      r.data.dueDate &&
      r.data.dueDate <= today(),
  );
  const activeOpps = records.filter(
    (r) =>
      r.kind === "opportunities" && !["Won", "Lost"].includes(r.data.stage),
  );
  let visible = records.filter(
    (r) =>
      r.kind === page &&
      JSON.stringify(r.data).toLowerCase().includes(search.toLowerCase()),
  );
  if (filter === "mine")
    visible = visible.filter((r) => r.data.ownerId === me?.user.id);
  if (filter === "due")
    visible = visible.filter(
      (r) =>
        r.data.dueDate &&
        r.data.dueDate <= today() &&
        r.data.status !== "Done" &&
        !(r.kind === "opportunities" && ["Won", "Lost"].includes(r.data.stage)),
    );
  async function save(kind: Kind, data: RecordData, record?: CrmRecord) {
    await action(async () => {
      if (demo) {
        const r: CrmRecord = {
          id: record?.id || crypto.randomUUID(),
          kind,
          data,
          version: (record?.version || 0) + 1,
          created_at: record?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setSnapshot((s) => ({
          ...s,
          records: [r, ...s.records.filter((v) => v.id !== r.id)],
        }));
      } else {
        await api("workspaces/" + workspace + "/records", "POST", {
          kind,
          data,
          id: record?.id,
          version: record?.version,
        });
        await refresh();
      }
      setEditing(null);
      notify("Record saved.");
    });
  }
  async function remove(record: CrmRecord) {
    if (!window.confirm(`Delete “${record.data.name}”? This cannot be undone.`))
      return;
    await action(async () => {
      if (demo)
        setSnapshot((s) => ({
          ...s,
          records: s.records.filter((r) => r.id !== record.id),
        }));
      else {
        await api("workspaces/" + workspace + "/records", "DELETE", {
          id: record.id,
          version: record.version,
        });
        await refresh();
      }
      setEditing(null);
      notify("Record deleted.");
    });
  }
  function download(content: string, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportData() {
    await action(async () => {
      const data = demo
        ? snapshot
        : await api("workspaces/" + workspace + "/export");
      download(
        JSON.stringify(data, null, 2),
        "bittrees-crm.json",
        "application/json",
      );
      notify("Workspace exported.");
    });
  }
  function nav(p: Page) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", p);
    window.history.pushState(null, "", url);
    setPage(p);
    setSearch("");
    setFilter("all");
    setMobile(false);
    setError("");
  }
  if (loading)
    return (
      <div className="loading">
        <Sprout size={30} />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!me)
    return (
      <Auth
        invitation={!!inviteToken}
        onSuccess={async () => {
          await loadMe();
        }}
        onDemo={startDemo}
      />
    );
  return (
    <div className="app">
      {mobile && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <Brand />
        <label className="workspace-select">
          <span className="workspace-icon">
            {initials(
              me.workspaces.find((w) => w.id === workspace)?.name || "W",
            )}
          </span>
          <select
            aria-label="Workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              "today",
              "people",
              "organizations",
              "opportunities",
              "projects",
              "tasks",
              "notes",
              "reports",
            ] as Page[]
          ).map((p) => {
            const Icon = icons[p];
            return (
              <button
                key={p}
                className={page === p ? "nav-item active" : "nav-item"}
                onClick={() => nav(p)}
              >
                <Icon size={18} />
                <span>{labels[p]}</span>
                {p === "tasks" && (
                  <small>
                    {
                      records.filter(
                        (r) => r.kind === "tasks" && r.data.status === "Open",
                      ).length
                    }
                  </small>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="live-dot" />
            {demo ? "Fictional demo workspace" : "A place for the next step"}
          </div>
          <button
            className={page === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => nav("settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
          <div className="user-row">
            <span className="avatar small-avatar">
              {initials(me.user.name)}
            </span>
            <div>
              <strong>{me.user.name}</strong>
              <small>{snapshot.role}</small>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              onClick={() =>
                void action(async () => {
                  if (!demo) await api("auth/logout", "POST");
                  setMe(null);
                  setDemo(false);
                  setWorkspace("");
                  setSnapshot({
                    role: "viewer",
                    records: [],
                    members: [],
                    audit: [],
                  });
                  window.history.replaceState(null, "", "/");
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobile(!mobile)}
            aria-label="Toggle navigation"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{labels[page]}</strong>
          </div>
          <div className="top-actions">
            {demo ? (
              <button
                className="text-button"
                onClick={() => {
                  setMe(null);
                  setDemo(false);
                  setWorkspace("");
                }}
              >
                Sign in to save your work <ArrowUpRight size={15} />
              </button>
            ) : (
              <span className="secure-label">
                <ShieldCheck size={15} />
                Verified session
              </span>
            )}
            <button
              className="icon-button"
              disabled={busy}
              title="Refresh workspace"
              onClick={() => void action(refresh)}
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
          </div>
        </header>
        {demo && (
          <div className="demo-bar">
            DEMO{" "}
            <span>
              All names and records are fictional. Changes last only for this
              session.
            </span>
          </div>
        )}
        {error && (
          <div role="alert" className="error global-message">
            {error}
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="toast">
            <CheckCheck size={18} />
            {notice}
          </div>
        )}
        {inviteToken && !demo && (
          <div className="invite-banner">
            <span>
              {inviteError ||
                (inviteInfo
                  ? `Join ${inviteInfo.name} as ${inviteInfo.role}. Invited email: ${inviteInfo.email}`
                  : "Loading invitation…")}
            </span>
            {inviteInfo &&
              !me.identities.some(
                (i) => i.kind === "email" && i.value === inviteInfo.email,
              ) && (
                <button className="button" onClick={() => setLinking(true)}>
                  Verify invited email
                </button>
              )}
            <button
              className="button primary"
              disabled={
                !inviteInfo ||
                !!inviteError ||
                busy ||
                !me.identities.some(
                  (i) => i.kind === "email" && i.value === inviteInfo.email,
                )
              }
              onClick={() =>
                void action(async () => {
                  const r = await api("invites/accept", "POST", {
                    token: inviteToken,
                  });
                  await loadMe();
                  setWorkspace(r.workspaceId);
                  setInviteToken("");
                  window.history.replaceState(null, "", "/");
                  notify("You joined the workspace.");
                })
              }
            >
              Accept invitation
            </button>
            <button className="text-button" onClick={() => setInviteToken("")}>
              Dismiss
            </button>
          </div>
        )}
        <main className="content">
          {page === "today" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {new Date()
                      .toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      })
                      .toUpperCase()}
                  </span>
                  <h1>Make the next move.</h1>
                  <p>
                    Welcome back, {me.user.name}. Here’s where things stand.
                  </p>
                </div>
                {canEdit && (
                  <button
                    className="button primary"
                    onClick={() => setEditing({ kind: "opportunities" })}
                  >
                    <Plus size={18} />
                    New opportunity
                  </button>
                )}
              </div>
              <div className="metrics">
                <Metric
                  label="Active opportunities"
                  value={String(activeOpps.length)}
                  detail="Conversations moving forward"
                  icon={TrendingUp}
                />
                <Metric
                  label="Follow-ups due"
                  value={String(due.length)}
                  detail={
                    due.length
                      ? "Ready for your attention"
                      : "You’re all caught up"
                  }
                  icon={Clock3}
                />
                <Metric
                  label="People in your network"
                  value={String(
                    records.filter((r) => r.kind === "people").length,
                  )}
                  detail="Relationships worth keeping close"
                  icon={Users}
                />
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="section-heading">
                    <h2>
                      Your next steps{" "}
                      <span className="count">{due.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => nav("tasks")}
                    >
                      All tasks <ArrowRight size={15} />
                    </button>
                  </div>
                  {due.length ? (
                    <div className="task-list">
                      {due.slice(0, 8).map((r) => (
                        <div className="task-row" key={r.id}>
                          <button
                            type="button"
                            className="task-open"
                            onClick={() =>
                              setEditing({ kind: r.kind, record: r })
                            }
                          >
                            <span className="task-ring" />
                            <span>
                              <strong>
                                {r.kind === "opportunities"
                                  ? r.data.nextAction
                                  : r.data.name}
                              </strong>
                              <small>
                                {r.kind === "opportunities"
                                  ? r.data.name
                                  : ownerOf(r.data.ownerId)}
                              </small>
                            </span>
                          </button>
                          {canEdit ? (
                            <QuickActions
                              record={r}
                              disabled={busy}
                              onChange={(patch) => quickUpdate(r, patch)}
                            />
                          ) : (
                            <span className="due">
                              {dateLabel(r.data.dueDate)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="Room to move forward"
                      text="Add a task or an opportunity with a next step. Your due follow-ups will appear here."
                      action={
                        canEdit
                          ? () => setEditing({ kind: "tasks" })
                          : undefined
                      }
                      label="Add a task"
                    />
                  )}
                </section>
                <section className="panel pipeline-summary">
                  <div className="section-heading">
                    <h2>Pipeline pulse</h2>
                    <TrendingUp size={18} />
                  </div>
                  {stages
                    .filter((s) => !["Won", "Lost"].includes(s))
                    .map((s, i) => {
                      const count = activeOpps.filter(
                        (r) => r.data.stage === s,
                      ).length;
                      return (
                        <div key={s} className="pulse-row">
                          <div>
                            <span className={"stage-dot s" + i} />
                            {s}
                            <strong>{count}</strong>
                          </div>
                          <div className="bar-track">
                            <span
                              style={{
                                width: `${activeOpps.length ? (count / activeOpps.length) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  <button
                    className="text-button"
                    onClick={() => nav("opportunities")}
                  >
                    Open opportunities <ArrowRight size={15} />
                  </button>
                </section>
              </div>
              <section className="panel activity-panel">
                <div className="section-heading">
                  <h2>Recent activity</h2>
                  <span className="small">Across this workspace</span>
                </div>
                {snapshot.audit.length ? (
                  snapshot.audit.slice(0, 6).map((a) => (
                    <div className="activity-row" key={a.id}>
                      <span className="avatar small-avatar">
                        {initials(a.actor)}
                      </span>
                      <div>
                        <strong>{a.actor}</strong> {a.action.toLowerCase()}{" "}
                        {a.detail.name && <b>{a.detail.name}</b>}
                      </div>
                      <time>{new Date(a.created_at).toLocaleDateString()}</time>
                    </div>
                  ))
                ) : (
                  <div className="quiet-empty">
                    Your team’s updates will appear here as work moves forward.
                  </div>
                )}
              </section>
            </>
          ) : page === "reports" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">WORKSPACE HEALTH</span>
                  <h1>Progress, in perspective.</h1>
                  <p>A practical view of follow-through and outcomes.</p>
                </div>
                <button className="button" onClick={exportData}>
                  <ArrowDownToLine size={17} />
                  Export workspace
                </button>
              </div>
              <div className="metrics">
                <Metric
                  label="Next-step coverage"
                  value={`${activeOpps.length ? Math.round((activeOpps.filter((r) => r.data.ownerId && r.data.nextAction && r.data.dueDate).length / activeOpps.length) * 100) : 0}%`}
                  detail="Active opportunities with a clear next step"
                  icon={CheckCheck}
                />
                <Metric
                  label="Won opportunities"
                  value={String(
                    records.filter(
                      (r) =>
                        r.kind === "opportunities" && r.data.stage === "Won",
                    ).length,
                  )}
                  detail="Completed commercial and partner outcomes"
                  icon={TrendingUp}
                />
                <Metric
                  label="Overdue follow-ups"
                  value={String(
                    due.filter((r) => r.data.dueDate < today()).length,
                  )}
                  detail="Open tasks and active opportunities"
                  icon={Clock3}
                />
              </div>
              <section className="panel">
                <div className="section-heading">
                  <h2>Opportunity breakdown</h2>
                  <span className="small">Amounts grouped by currency</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Stage</th>
                        <th>Opportunities</th>
                        <th>EUR</th>
                        <th>USD</th>
                        <th>GBP</th>
                        <th>Avg. days in stage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stages.map((stage) => {
                        const rows = records.filter(
                          (r) =>
                            r.kind === "opportunities" &&
                            r.data.stage === stage,
                        );
                        return (
                          <tr key={stage}>
                            <td>
                              <span className="badge">{stage}</span>
                            </td>
                            <td>{rows.length}</td>
                            {["EUR", "USD", "GBP"].map((c) => (
                              <td key={c}>
                                {money(
                                  rows
                                    .filter((r) => r.data.currency === c)
                                    .reduce((a, r) => a + r.data.value, 0),
                                  c,
                                )}
                              </td>
                            ))}
                            <td>
                              {rows.length
                                ? Math.floor(
                                    rows.reduce(
                                      (sum, r) =>
                                        sum +
                                        (Date.now() -
                                          new Date(
                                            r.stage_changed_at || r.created_at,
                                          ).getTime()) /
                                          86400000,
                                      0,
                                    ) / rows.length,
                                  )
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
              <p className="small footnote">
                Amounts are entered estimates, not accounting balances.
                Different currencies are never combined.
              </p>
            </>
          ) : page === "settings" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR WORKSPACE</span>
                  <h1>Identity & coordination.</h1>
                  <p>Keep access clear and your team connected.</p>
                </div>
              </div>
              {!demo && (
                <BackupIdentity
                  identities={me.identities}
                  onLink={() => setLinking(true)}
                />
              )}
              <div className="settings-grid">
                <section className="panel">
                  <div className="section-heading">
                    <h2>Your identity</h2>
                    <ShieldCheck size={19} />
                  </div>
                  <form
                    className="settings-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = new FormData(e.currentTarget).get("name");
                      void action(async () => {
                        if (demo)
                          setMe({
                            ...me,
                            user: { ...me.user, name: String(name) },
                          });
                        else {
                          await api("me", "PATCH", { name });
                          await loadMe();
                        }
                        notify("Name updated.");
                      });
                    }}
                  >
                    <label>
                      Display name
                      <input
                        name="name"
                        key={me.user.name}
                        disabled={busy}
                        defaultValue={me.user.name}
                        required
                        maxLength={80}
                      />
                    </label>
                    <button className="button" disabled={busy}>
                      Save name
                    </button>
                  </form>
                  <div className="identity-list">
                    {me.identities.map((i) => (
                      <div key={i.value} className="identity-row">
                        {i.kind === "email" ? (
                          <Mail size={18} />
                        ) : (
                          <Wallet size={18} />
                        )}
                        <span>{i.value}</span>
                        <span className="verified">
                          <Check size={13} />
                          Verified
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="panel-pad">
                    <button
                      className="button"
                      disabled={demo}
                      onClick={() => setLinking(true)}
                    >
                      <Plus size={16} />
                      Link email or wallet
                    </button>
                    <p className="small">
                      Each identity belongs to one account. Linking requires
                      proof of ownership. Contact wallet fields do not grant
                      account access.
                    </p>
                  </div>
                </section>
                <section className="panel">
                  <div className="section-heading">
                    <h2>Workspace</h2>
                    <FolderOpen size={19} />
                  </div>
                  <form
                    className="settings-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = String(
                        new FormData(e.currentTarget).get("name"),
                      );
                      void action(async () => {
                        if (demo)
                          setMe({
                            ...me,
                            workspaces: [{ ...me.workspaces[0], name }],
                          });
                        else {
                          await api("workspaces/" + workspace, "PATCH", {
                            name,
                          });
                          await loadMe();
                        }
                        notify("Workspace renamed.");
                      });
                    }}
                  >
                    <label>
                      Workspace name
                      <input
                        name="name"
                        key={
                          workspace +
                          me.workspaces.find((w) => w.id === workspace)?.name
                        }
                        defaultValue={
                          me.workspaces.find((w) => w.id === workspace)?.name
                        }
                        required
                        maxLength={100}
                        disabled={busy || snapshot.role !== "owner"}
                      />
                    </label>
                    <button
                      className="button"
                      disabled={busy || snapshot.role !== "owner"}
                    >
                      Save workspace
                    </button>
                  </form>
                  <div className="panel-pad button-stack">
                    <button className="button" onClick={exportData}>
                      <ArrowDownToLine size={17} />
                      Export all workspace data
                    </button>
                    <button
                      className="button"
                      disabled={demo}
                      onClick={() => setCreatingWorkspace(true)}
                    >
                      <Plus size={17} />
                      Create another workspace
                    </button>
                  </div>
                </section>
                <DigestSettings
                  identities={me.identities}
                  demo={demo}
                  onLink={() => setLinking(true)}
                />
                <section className="panel full-span">
                  <div className="section-heading">
                    <h2>
                      Team members{" "}
                      <span className="count">{snapshot.members.length}</span>
                    </h2>
                    <span className="small">
                      Owners manage access · Editors update records · Viewers
                      read
                    </span>
                  </div>
                  {snapshot.members.map((m) => (
                    <div className="member-row" key={m.id}>
                      <span className="avatar small-avatar">
                        {initials(m.name)}
                      </span>
                      <strong>
                        {m.name}
                        {m.id === me.user.id ? " (you)" : ""}
                      </strong>
                      {m.role === "owner" || snapshot.role !== "owner" ? (
                        <span className="badge">{m.role}</span>
                      ) : (
                        <select
                          aria-label={`Role for ${m.name}`}
                          value={m.role}
                          disabled={busy || demo}
                          onChange={(e) => {
                            const role = e.target.value;
                            if (
                              role === "remove" &&
                              !window.confirm(
                                `Remove ${m.name} from this workspace?`,
                              )
                            )
                              return;
                            void action(async () => {
                              await api(
                                "workspaces/" + workspace + "/members",
                                "PATCH",
                                { userId: m.id, role },
                              );
                              await refresh();
                              notify("Member access updated.");
                            });
                          }}
                        >
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                          <option value="remove">Remove access</option>
                        </select>
                      )}
                    </div>
                  ))}
                  {snapshot.role === "owner" && (
                    <form
                      className="invite-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const values = new FormData(e.currentTarget);
                        void action(() =>
                          createInvitation(
                            String(values.get("email")),
                            String(values.get("role")),
                          ),
                        );
                      }}
                    >
                      <label>
                        Invite by verified email
                        <input
                          name="email"
                          required
                          type="email"
                          placeholder="teammate@company.com"
                          disabled={demo}
                        />
                      </label>
                      <label>
                        Role
                        <select name="role">
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      </label>
                      <button
                        className="button primary"
                        disabled={busy || demo}
                      >
                        <Plus size={17} />
                        Create invite link
                      </button>
                    </form>
                  )}
                  {snapshot.role === "owner" && (
                    <InviteManager
                      key={workspace}
                      workspace={workspace}
                      demo={demo}
                      revision={inviteRevision}
                      onInvite={createInvitation}
                      onChanged={(revoked) => {
                        if (revoked) {
                          setInviteUrl("");
                          notify("Invitation revoked.");
                        }
                        void refresh().catch((e) => setError(e.message));
                      }}
                    />
                  )}
                  {inviteUrl && (
                    <div className="panel-pad">
                      <label>
                        Invitation link · expires in seven days
                        <input
                          readOnly
                          value={inviteUrl}
                          onFocus={(e) => e.target.select()}
                        />
                      </label>
                      <p className="small">
                        Only the recipient’s verified email can accept this
                        invitation. Share this link directly with them.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {page === "opportunities"
                      ? "TURN CONVERSATIONS INTO PROGRESS"
                      : "YOUR RELATIONSHIP WORKSPACE"}
                  </span>
                  <h1>
                    {labels[page]}
                    <span className="heading-count">
                      {records.filter((r) => r.kind === page).length}
                    </span>
                  </h1>
                  <p>
                    {
                      (
                        {
                          people: "The people behind every possibility.",
                          organizations: "A shared view of who you work with.",
                          opportunities:
                            "Every conversation, with a clear next step.",
                          projects:
                            "Connect relationships to the work that matters.",
                          tasks: "Small steps. Steady progress.",
                          notes: "Keep the context close.",
                        } as Record<string, string>
                      )[page]
                    }
                  </p>
                </div>
                {canEdit && (
                  <button
                    className="button primary"
                    onClick={() => setEditing({ kind: page as Kind })}
                  >
                    <Plus size={18} />
                    Add{" "}
                    {page === "people"
                      ? "person"
                      : page === "opportunities"
                        ? "opportunity"
                        : page.slice(0, -1)}
                  </button>
                )}
              </div>
              <div className="toolbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search records"
                    placeholder={`Search ${labels[page].toLowerCase()}…`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter records"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All records</option>
                  <option value="mine">Assigned to me</option>
                  {["tasks", "opportunities"].includes(page) && (
                    <option value="due">Follow-ups due</option>
                  )}
                </select>
                {savedViews.some((v) => v.page === page) && (
                  <select
                    aria-label="Saved views"
                    value=""
                    onChange={(e) => {
                      const v = savedViews.find(
                        (v) => v.name === e.target.value && v.page === page,
                      );
                      if (v) {
                        setSearch(v.search);
                        setFilter(v.filter);
                        setBoard(v.board);
                      }
                    }}
                  >
                    <option value="">Saved views</option>
                    {savedViews
                      .filter((v) => v.page === page)
                      .map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                  </select>
                )}
                <button className="button subtle" onClick={saveView}>
                  Save view
                </button>
                <div className="toolbar-spacer" />
                {page === "opportunities" && (
                  <div className="toggle">
                    <button
                      title="Board view"
                      className={board ? "selected" : ""}
                      onClick={() => setBoard(true)}
                    >
                      <LayoutGrid size={17} />
                    </button>
                    <button
                      title="Table view"
                      className={!board ? "selected" : ""}
                      onClick={() => setBoard(false)}
                    >
                      <List size={17} />
                    </button>
                  </div>
                )}
                {["people", "organizations"].includes(page) && canEdit && (
                  <button
                    className="button subtle"
                    onClick={() => setImporting(true)}
                  >
                    Import CSV
                  </button>
                )}
                <button
                  className="button subtle"
                  title="Export this view as CSV"
                  onClick={() =>
                    download(
                      Papa.unparse(
                        visible.map((r) => ({ id: r.id, ...r.data })),
                        { escapeFormulae: true },
                      ),
                      `bittrees-${page}.csv`,
                      "text/csv",
                    )
                  }
                >
                  <ArrowDownToLine size={17} />
                  <span className="hide-mobile">Export</span>
                </button>
              </div>
              {page === "opportunities" && board ? (
                <div className="board">
                  {stages.map((stage, i) => {
                    const rows = visible.filter((r) => r.data.stage === stage);
                    return (
                      <section className="board-column" key={stage}>
                        <div className="column-heading">
                          <span className={"stage-dot s" + i} />
                          <h2>{stage}</h2>
                          <span className="count">{rows.length}</span>
                        </div>
                        {rows.map((r) => (
                          <article className="opportunity-card" key={r.id}>
                            <button
                              type="button"
                              className="card-open"
                              onClick={() =>
                                setEditing({ kind: r.kind, record: r })
                              }
                            >
                              <span className="card-category">
                                {r.data.category || "Opportunity"}
                              </span>
                              <h3>{r.data.name}</h3>
                              <p>
                                {r.data.organizationId
                                  ? nameOf(r.data.organizationId)
                                  : "No organization linked"}
                              </p>
                              {r.data.value > 0 && (
                                <strong className="card-value">
                                  {money(r.data.value, r.data.currency)}
                                </strong>
                              )}
                              <div className="card-next">
                                <ArrowRight size={13} />
                                {r.data.nextAction || "No next step"}
                              </div>
                              <div className="card-footer">
                                <span
                                  className={
                                    r.data.dueDate &&
                                    r.data.dueDate < today() &&
                                    !["Won", "Lost"].includes(r.data.stage)
                                      ? "due overdue"
                                      : "due"
                                  }
                                >
                                  <Clock3 size={12} />
                                  {dateLabel(r.data.dueDate)}
                                </span>
                                <span
                                  title={ownerOf(r.data.ownerId)}
                                  className="avatar mini-avatar"
                                >
                                  {initials(ownerOf(r.data.ownerId))}
                                </span>
                              </div>
                            </button>
                            {canEdit && (
                              <QuickActions
                                record={r}
                                disabled={busy}
                                onChange={(patch) => quickUpdate(r, patch)}
                              />
                            )}
                          </article>
                        ))}
                        {!rows.length && (
                          <div className="column-empty">No opportunities</div>
                        )}
                        {canEdit && (
                          <button
                            className="column-add"
                            aria-label={`Add opportunity in ${stage}`}
                            onClick={() =>
                              setEditing({
                                kind: "opportunities",
                                record: undefined,
                                stage,
                              })
                            }
                          >
                            <Plus size={14} />
                            Add opportunity
                          </button>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : visible.length ? (
                <section className="panel table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>
                          {page === "people"
                            ? "Email"
                            : page === "tasks"
                              ? "Status"
                              : page === "notes"
                                ? "Context"
                                : page === "opportunities"
                                  ? "Stage"
                                  : "Type"}
                        </th>
                        <th>
                          {page === "people"
                            ? "Organization"
                            : "Related project"}
                        </th>
                        <th>Owner</th>
                        <th>
                          {["tasks", "opportunities"].includes(page)
                            ? "Due date"
                            : "Updated"}
                        </th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <button
                              className="record-link"
                              onClick={() =>
                                setEditing({ kind: r.kind, record: r })
                              }
                            >
                              <span className="avatar">
                                {initials(r.data.name)}
                              </span>
                              <span>
                                <strong>{r.data.name}</strong>
                                {r.data.title && <small>{r.data.title}</small>}
                              </span>
                            </button>
                          </td>
                          <td>
                            {page === "tasks" ? (
                              <span
                                className={
                                  "badge " +
                                  (r.data.status === "Done" ? "success" : "")
                                }
                              >
                                {r.data.status}
                              </span>
                            ) : page === "opportunities" ? (
                              <span className="badge">{r.data.stage}</span>
                            ) : page === "people" ? (
                              r.data.email || "—"
                            ) : page === "notes" ? (
                              <span className="truncate">
                                {r.data.description || "—"}
                              </span>
                            ) : (
                              r.data.category || "—"
                            )}
                          </td>
                          <td>
                            {nameOf(
                              page === "people"
                                ? r.data.organizationId
                                : r.data.projectId,
                            )}
                          </td>
                          <td>
                            <span className="owner-cell">
                              <span className="avatar mini-avatar">
                                {initials(ownerOf(r.data.ownerId))}
                              </span>
                              {ownerOf(r.data.ownerId)}
                            </span>
                          </td>
                          <td>
                            {["tasks", "opportunities"].includes(page) ? (
                              <span
                                className={
                                  r.data.dueDate < today() &&
                                  r.data.dueDate &&
                                  r.data.status !== "Done" &&
                                  !["Won", "Lost"].includes(r.data.stage)
                                    ? "due overdue"
                                    : "due"
                                }
                              >
                                {dateLabel(r.data.dueDate)}
                              </span>
                            ) : (
                              new Date(r.updated_at).toLocaleDateString(
                                undefined,
                                { month: "short", day: "numeric" },
                              )
                            )}
                          </td>
                          <td>
                            {canEdit &&
                              ["tasks", "opportunities"].includes(r.kind) && (
                                <QuickActions
                                  record={r}
                                  disabled={busy}
                                  onChange={(patch) => quickUpdate(r, patch)}
                                />
                              )}
                            <button
                              className="icon-button"
                              title={`Open ${r.data.name}`}
                              onClick={() =>
                                setEditing({ kind: r.kind, record: r })
                              }
                            >
                              <ArrowUpRight size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : (
                <section className="panel">
                  <Empty
                    title={
                      search || filter !== "all"
                        ? "No matching records"
                        : `A fresh start for ${labels[page].toLowerCase()}`
                    }
                    text={
                      search || filter !== "all"
                        ? "Try another search or change your filter."
                        : "Add your first record to start connecting people, context, and next steps."
                    }
                    action={
                      canEdit
                        ? () => setEditing({ kind: page as Kind })
                        : undefined
                    }
                    label="Add your first record"
                  />
                </section>
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <Sprout size={13} /> Bittrees CRM{" "}
          <span>Independent. Open source.</span>
          <a
            href="https://github.com/Bittrees-Technology/crm"
            target="_blank"
            rel="noreferrer"
          >
            MIT license <ArrowUpRight size={12} />
          </a>
        </footer>
      </div>
      {editing && (
        <RecordEditor
          key={editing.record?.id || editing.kind}
          workspace={workspace}
          demo={demo}
          kind={editing.kind}
          initialStage={editing.stage}
          record={editing.record}
          records={records}
          members={snapshot.members}
          userId={me.user.id}
          canEdit={canEdit}
          busy={busy}
          error={error}
          onClose={() => {
            setEditing(null);
            setError("");
          }}
          onSave={(d) => save(editing.kind, d, editing.record)}
          onDelete={editing.record ? () => remove(editing.record!) : undefined}
        />
      )}
      {linking && (
        <Modal
          title="Link a verified identity"
          onClose={() => setLinking(false)}
        >
          <Auth
            link
            initialEmail={inviteInfo?.email || ""}
            onSuccess={async () => {
              await loadMe();
              await refresh();
              setLinking(false);
              notify(
                "Verified sign-in methods updated. You can use either method.",
              );
            }}
          />
        </Modal>
      )}
      {importing && (
        <Importer
          kind={page === "organizations" ? "organizations" : "people"}
          existing={records}
          busy={busy}
          error={error}
          onClose={() => {
            setImporting(false);
            setError("");
          }}
          onImport={(rows) =>
            void action(async () => {
              if (demo) {
                setSnapshot((s) => ({
                  ...s,
                  records: [
                    ...s.records,
                    ...rows.map((data) => ({
                      id: crypto.randomUUID(),
                      kind: page as Kind,
                      data,
                      version: 1,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })),
                  ],
                }));
                notify(`${rows.length} demo records imported.`);
              } else {
                const r = await api(
                  "workspaces/" + workspace + "/import",
                  "POST",
                  { kind: page, rows },
                );
                await refresh();
                notify(
                  `${r.imported} imported; ${r.skipped} duplicates skipped.`,
                );
              }
              setImporting(false);
            })
          }
        />
      )}
      {reauth && (
        <Modal title="Your session expired" onClose={() => setReauth(false)}>
          <p className="panel-pad">
            Sign in again to continue. Your open edits stay here.
          </p>
          <Auth
            compact
            initialEmail={
              me.identities.find((i) => i.kind === "email")?.value || ""
            }
            onSuccess={async () => {
              await loadMe();
              await refresh();
              setReauth(false);
              notify("Signed in again. You can continue.");
            }}
          />
        </Modal>
      )}
      {creatingWorkspace && (
        <Modal
          title="Create workspace"
          onClose={() => setCreatingWorkspace(false)}
        >
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name");
              void action(async () => {
                const r = await api("workspaces", "POST", { name });
                await loadMe();
                setWorkspace(r.id);
                setCreatingWorkspace(false);
                notify("Workspace created.");
              });
            }}
          >
            <label>
              Workspace name
              <input
                name="name"
                required
                maxLength={100}
                placeholder="Your team or organization"
              />
            </label>
            <p className="small">
              Records and membership are separate for each workspace.
            </p>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary" disabled={busy}>
              Create workspace
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Users;
}) {
  return (
    <section className="metric">
      <div>
        <span>{label}</span>
        <Icon size={18} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}
function Empty({
  title,
  text,
  action,
  label,
}: {
  title: string;
  text: string;
  action?: () => void;
  label?: string;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Sprout size={26} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="button" onClick={action}>
          <Plus size={16} />
          {label}
        </button>
      )}
    </div>
  );
}
function RecordEditor({
  workspace,
  demo,
  kind,
  initialStage,
  record,
  records,
  members,
  userId,
  canEdit,
  busy,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  workspace: string;
  demo: boolean;
  kind: Kind;
  initialStage?: RecordData["stage"];
  record?: CrmRecord;
  records: CrmRecord[];
  members: Member[];
  userId: string;
  canEdit: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (data: RecordData) => void;
  onDelete?: () => void;
}) {
  const [data, setData] = useState<RecordData>(
    record?.data || {
      ...recordSchema.parse({
        name: "New record",
        ownerId: userId,
        stage: initialStage || "Introduction",
      }),
      name: "",
    },
  );
  const original = useRef(JSON.stringify(data));
  const dirty = canEdit && JSON.stringify(data) !== original.current;
  function closeEditor() {
    if (busy) return;
    if (!dirty || window.confirm("Discard your unsaved changes?")) onClose();
  }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const update = (key: keyof RecordData, v: string | number) =>
    setData((d) => ({ ...d, [key]: v }));
  const input = (
    key: keyof RecordData,
    label: string,
    type = "text",
    required = false,
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={String(data[key])}
        required={required}
        maxLength={key === "description" ? 4000 : 200}
        onChange={(e) =>
          update(
            key,
            type === "number" ? Number(e.target.value) : e.target.value,
          )
        }
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? "0.01" : undefined}
        max={type === "number" ? 1e12 : undefined}
      />
    </label>
  );
  const select = (
    key: keyof RecordData,
    label: string,
    options: { value: string; label: string }[],
    required = false,
  ) => (
    <label>
      {label}
      <select
        value={String(data[key])}
        required={required}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const ref = (key: keyof RecordData, label: string, k: Kind) =>
    select(
      key,
      label,
      records
        .filter((r) => r.kind === k && r.id !== record?.id)
        .map((r) => ({ value: r.id, label: r.data.name })),
    );
  return (
    <Modal
      title={
        record
          ? record.data.name
          : `New ${kind === "people" ? "person" : kind === "opportunities" ? "opportunity" : kind.slice(0, -1)}`
      }
      onClose={closeEditor}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(data);
        }}
      >
        <fieldset disabled={!canEdit || busy} className="editor-fields">
          <div className="form-grid">
            {input(
              "name",
              kind === "tasks"
                ? "Task"
                : kind === "notes"
                  ? "Note title"
                  : "Name",
              "text",
              true,
            )}
            {select(
              "ownerId",
              "Owner",
              members.map((m) => ({ value: m.id, label: m.name })),
              kind === "opportunities" && !["Won", "Lost"].includes(data.stage),
            )}
            {kind === "people" && (
              <>
                {input("email", "Email address", "email")}
                {input("title", "Role / title")}
                {ref("organizationId", "Organization", "organizations")}
                {select(
                  "communication",
                  "Communication preference",
                  ["Unknown", "Allowed", "Do not contact"].map((v) => ({
                    value: v,
                    label: v,
                  })),
                )}
              </>
            )}
            {kind === "organizations" && (
              <>
                {input("website", "Website", "url")}
                {input("category", "Organization type")}
              </>
            )}
            {kind === "projects" && input("category", "Project type")}
            {kind === "opportunities" && (
              <>
                {select(
                  "category",
                  "Opportunity type",
                  ["Partnership", "Customer", "Research", "Contributor"].map(
                    (v) => ({ value: v, label: v }),
                  ),
                )}
                {select(
                  "stage",
                  "Stage",
                  stages.map((v) => ({ value: v, label: v })),
                  true,
                )}
                {input("value", "Estimated value", "number")}
                {select(
                  "currency",
                  "Currency",
                  ["EUR", "USD", "GBP"].map((v) => ({ value: v, label: v })),
                  true,
                )}
                {ref("organizationId", "Organization", "organizations")}
                {ref("personId", "Contact", "people")}
                {input(
                  "nextAction",
                  "Next action",
                  "text",
                  !["Won", "Lost"].includes(data.stage),
                )}
                {input(
                  "dueDate",
                  "Next action due",
                  "date",
                  !["Won", "Lost"].includes(data.stage),
                )}
              </>
            )}
            {kind === "tasks" && (
              <>
                {select(
                  "status",
                  "Status",
                  ["Open", "Done"].map((v) => ({ value: v, label: v })),
                  true,
                )}
                {input("dueDate", "Due date", "date")}
                {ref("opportunityId", "Opportunity", "opportunities")}
                {ref("personId", "Contact", "people")}
              </>
            )}
            {kind === "notes" && (
              <>
                {ref("personId", "Person", "people")}
                {ref("organizationId", "Organization", "organizations")}
                {ref("opportunityId", "Opportunity", "opportunities")}
              </>
            )}
            {kind !== "projects" && ref("projectId", "Project", "projects")}
            {["people", "organizations"].includes(kind) &&
              input("wallet", "Wallet reference (unverified)")}
            {input("source", "Source / reference")}
            <label className="full-span">
              {kind === "notes" ? "Note" : "Description / context"}
              <textarea
                rows={5}
                maxLength={4000}
                value={data.description}
                onChange={(e) => update("description", e.target.value)}
              />
            </label>
          </div>
        </fieldset>
        {error && (
          <div className="error modal-error" role="alert">
            {error}
          </div>
        )}
        {record && (
          <RelationshipTimeline
            workspace={workspace}
            record={record}
            records={records}
            demo={demo}
          />
        )}
        {record && (
          <div className="record-meta">
            Version {record.version} · Updated{" "}
            {new Date(record.updated_at).toLocaleString()}
          </div>
        )}
        <div className="modal-actions">
          {onDelete && canEdit && (
            <button
              type="button"
              className="text-button danger"
              onClick={onDelete}
              disabled={busy}
            >
              Delete record
            </button>
          )}
          <div className="toolbar-spacer" />
          <button
            type="button"
            className="button"
            onClick={closeEditor}
            disabled={busy}
          >
            Close
          </button>
          {canEdit && (
            <button className="button primary" disabled={busy}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              Save record
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
function Importer({
  kind,
  existing,
  busy,
  error,
  onClose,
  onImport,
}: {
  kind: "people" | "organizations";
  existing: CrmRecord[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onImport: (rows: RecordData[]) => void;
}) {
  const [rows, setRows] = useState<RecordData[]>([]),
    [skipped, setSkipped] = useState(0),
    [problem, setProblem] = useState("");
  async function read(file?: File) {
    if (!file) return;
    setRows([]);
    setProblem("");
    if (file.size > 1_000_000) {
      setProblem("Choose a CSV smaller than 1 MB.");
      return;
    }
    const csv = Papa.parse<Record<string, string>>(await file.text(), {
      header: true,
      skipEmptyLines: "greedy",
    });
    if (csv.errors.length) {
      setProblem(
        "The CSV could not be read. Check the column headers and quoting.",
      );
      return;
    }
    if (csv.data.length > 500) {
      setProblem("Import up to 500 rows at a time.");
      return;
    }
    let skip = 0;
    const found = existing.filter((r) => r.kind === kind).map((r) => r.data),
      valid: RecordData[] = [];
    for (const [i, r] of csv.data.entries()) {
      const item = recordSchema.safeParse({
        name: r.name || r.Name,
        email: r.email || r.Email || "",
        title: r.title || "",
        website: r.website || "",
        category: r.category || "",
        source: r.source || "CSV import",
        description: r.description || "",
      });
      if (!item.success) {
        setProblem(
          `Row ${i + 2}: ${item.error.issues.map((e) => e.message).join(", ")}`,
        );
        return;
      }
      if (
        [...found, ...valid].some(
          (d) =>
            d.name.toLowerCase() === item.data.name.toLowerCase() ||
            (d.email &&
              d.email.toLowerCase() === item.data.email.toLowerCase()),
        )
      ) {
        skip++;
        continue;
      }
      valid.push(item.data);
    }
    setRows(valid);
    setSkipped(skip);
  }
  return (
    <Modal title={`Import ${kind}`} onClose={onClose} wide>
      <div className="modal-body">
        <p>
          Use a CSV with a <strong>name</strong> column. Optional columns:
          email, title, website, category, source, description.
        </p>
        <label className="file-label">
          Choose CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void read(e.target.files?.[0])}
          />
        </label>
        <p className="small">
          Up to 500 rows. Matching names or emails are skipped, never
          overwritten. Relationships and ownership can be added after import.
        </p>
        {(problem || error) && (
          <div className="error" role="alert">
            {problem || error}
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div className="import-summary">
              <strong>{rows.length} ready to import</strong>
              <span>{skipped} duplicates skipped</span>
            </div>
            <div className="table-wrap import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Type / role</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td>{r.email || "—"}</td>
                      <td>{r.title || r.category || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!rows.length && skipped > 0 && (
          <p>All {skipped} rows already exist.</p>
        )}
      </div>
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          disabled={busy || !rows.length || !!problem}
          className="button primary"
          onClick={() => onImport(rows)}
        >
          Import {rows.length} records
        </button>
      </div>
    </Modal>
  );
}
