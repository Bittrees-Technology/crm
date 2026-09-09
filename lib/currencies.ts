// CRM denominations only; these entries do not select a token contract or network.
export const currencyCodes = [
  "EUR",
  "USD",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "JPY",
  "CNY",
  "HKD",
  "SGD",
  "INR",
  "BRL",
  "AED",
  "SEK",
  "NOK",
  "DKK",
  "NZD",
  "ZAR",
  "BTC",
  "ETH",
  "SOL",
  "USDC",
  "USDT",
  "DAI",
  "BIT",
  "BTREE",
] as const;
export type Currency = (typeof currencyCodes)[number];
export const currencyGroups = [
  {
    label: "Bittrees",
    options: [
      ["BIT", "Bittrees BIT"],
      ["BTREE", "Bittrees BTREE"],
    ],
  },
  {
    label: "Fiat currencies",
    options: [
      ["EUR", "Euro"],
      ["USD", "US dollar"],
      ["GBP", "British pound"],
      ["CAD", "Canadian dollar"],
      ["AUD", "Australian dollar"],
      ["CHF", "Swiss franc"],
      ["JPY", "Japanese yen"],
      ["CNY", "Chinese yuan"],
      ["HKD", "Hong Kong dollar"],
      ["SGD", "Singapore dollar"],
      ["INR", "Indian rupee"],
      ["BRL", "Brazilian real"],
      ["AED", "UAE dirham"],
      ["SEK", "Swedish krona"],
      ["NOK", "Norwegian krone"],
      ["DKK", "Danish krone"],
      ["NZD", "New Zealand dollar"],
      ["ZAR", "South African rand"],
    ],
  },
  {
    label: "Crypto & stablecoins",
    options: [
      ["BTC", "Bitcoin"],
      ["ETH", "Ether"],
      ["SOL", "Solana"],
      ["USDC", "USD Coin"],
      ["USDT", "Tether"],
      ["DAI", "Dai"],
    ],
  },
] as const;
export type Amount = string | number;
const scale = 10n ** 18n;
export const amountPattern = "[0-9]{1,13}(\\.[0-9]{1,18})?";
const decimal = /^[0-9]+(\.[0-9]{1,18})?$/;
// Numbers remain accepted for existing records/API clients. New forms send decimal strings.
function plain(value: Amount): string {
  return typeof value === "number"
    ? value.toLocaleString("en-US", {
        useGrouping: false,
        maximumFractionDigits: 18,
      })
    : value;
}
function units(value: Amount): bigint {
  const source = plain(value);
  if (!decimal.test(source))
    throw new Error(
      "Enter a positive decimal amount with up to 18 decimal places.",
    );
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(18, "0"));
}
export function validAmount(value: Amount): boolean {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || value < 0 || (value > 0 && value < 1e-18))
  )
    return false;
  try {
    return units(value) <= 1_000_000_000_000n * scale;
  } catch {
    return false;
  }
}
function fromUnits(value: bigint): string {
  const fraction = (value % scale)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return (value / scale).toString() + (fraction ? "." + fraction : "");
}
export function sumAmounts(values: Amount[]): string {
  return fromUnits(values.reduce((sum, value) => sum + units(value), 0n));
}
export function formatAmount(
  value: Amount,
  currency: string = "EUR",
  locale?: string,
): string {
  const exact = fromUnits(units(value));
  const [whole, fraction = ""] = exact.split(".");
  const fiat = currencyGroups[1].options.some(([code]) => code === currency);
  const minimum = fiat
    ? (new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
      }).resolvedOptions().minimumFractionDigits ?? 0)
    : 0;
  const digits = fraction.padEnd(minimum, "0");
  const separator =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((p) => p.type === "decimal")?.value || ".";
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));
  return `${formatted}${digits ? separator + digits : ""} ${currency}`;
}
