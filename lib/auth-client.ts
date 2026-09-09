export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
export function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(
        new Error(
          "Verification cancelled. Dismiss any open wallet request before retrying.",
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(new Error("Verification cancelled."));
        else resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export function walletError(error: unknown) {
  const e = error as {
    code?: number;
    message?: string;
    error?: { code?: number };
  };
  if (e.code === 4001 || e.error?.code === 4001)
    return "You declined the wallet request. You can retry or use email.";
  if (e.code === -32002 || e.error?.code === -32002)
    return "A request is already open in your wallet. Open the wallet to approve or dismiss it, then retry.";
  return e.message || "Wallet verification failed. Please try again.";
}
export async function walletIdentity(
  provider: EthereumProvider,
  signal: AbortSignal,
  step: (s: string) => void,
  request: (path: string, body: unknown) => Promise<any>,
  link: boolean,
) {
  const wait = <T>(p: Promise<T>, ms: number, message: string) =>
    bounded(p, signal, ms, message);
  step("wallet-connect");
  const accounts = await wait(
    provider.request({ method: "eth_requestAccounts" }),
    30000,
    "The wallet did not respond. Open your wallet and dismiss any pending request, then retry or use email.",
  );
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
    throw new Error("No wallet account was selected.");
  const address = accounts[0];
  const chain = await wait(
    provider.request({ method: "eth_chainId" }),
    10000,
    "The wallet network could not be read. Unlock your wallet and retry.",
  );
  const chainId = Number(chain);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    throw new Error("Your wallet returned an unsupported network.");
  const c = await wait(
    request("auth/challenge", {
      kind: "ethereum",
      value: address,
      chainId,
      link,
    }),
    15000,
    "The sign-in service took too long. Please retry.",
  );
  step("wallet-sign");
  const bytes = new TextEncoder().encode(c.message);
  const message =
    "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const proof = await wait(
    provider.request({ method: "personal_sign", params: [message, address] }),
    60000,
    "The signature request timed out. Dismiss the old request in your wallet before retrying.",
  );
  if (signal.aborted) throw new Error("Verification cancelled.");
  step("wallet-verify");
  await wait(
    request("auth/verify", { id: c.id, proof }),
    15000,
    "The service did not confirm verification. Refresh Settings to check whether linking completed, then retry if needed.",
  );
}
