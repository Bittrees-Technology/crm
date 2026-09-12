import InsightsScript from "next/script";
import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Bittrees CRM · Relationships, in motion",
  description:
    "An independent, open-source relationship workspace. People, partnerships, and the next step.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<InsightsScript src="https://insights.bittrees.org/consent.js" data-insights-site="bittrees-crm" strategy="afterInteractive" />
      </body>
    </html>
  );
}
