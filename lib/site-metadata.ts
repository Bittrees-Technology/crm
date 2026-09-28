import type { Metadata } from "next";
export const siteOrigin = "https://crm.bittrees.org";
export const productDescription =
  "Manage contacts, organizations, opportunities, projects, tasks, and notes with scoped sharing and email or Ethereum wallet sign-in.";
export const productMetadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  applicationName: "Bittrees CRM",
  title: "Bittrees CRM",
  description: productDescription,
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "Bittrees CRM",
    locale: "en_US",
    title: "Bittrees CRM",
    description: productDescription,
    url: "/about",
    images: [
      {
        url: "/social-preview.png",
        width: 1200,
        height: 630,
        alt: "Bittrees CRM — contacts, organizations, opportunities, projects, tasks, and notes",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bittrees CRM",
    description: productDescription,
    images: [
      {
        url: "/social-preview.png",
        alt: "Bittrees CRM — contacts, organizations, opportunities, projects, tasks, and notes",
      },
    ],
  },
};
