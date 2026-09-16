import InsightsScript from "next/script";
import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Bittrees CRM",
  description:
    "Manage contacts, organizations, opportunities, projects, tasks, and notes.",
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
