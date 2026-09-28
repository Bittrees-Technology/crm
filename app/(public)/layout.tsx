import type { Metadata, Viewport } from "next";
import { productMetadata } from "@/lib/site-metadata";
export const metadata: Metadata = productMetadata;
export const viewport: Viewport = { themeColor: "#132e25" };
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
