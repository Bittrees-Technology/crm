import type { Metadata } from "next";
import "../globals.css";
export const metadata: Metadata = {
  title: "Connect Bittrees AI · CRM",
  robots: { index: false, follow: false },
};
export default function PrivateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
