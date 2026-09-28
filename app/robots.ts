import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-metadata";
export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview")
    return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/about",
        "/favicon.svg",
        "/favicon-32.png",
        "/apple-touch-icon.png",
        "/social-preview.png",
        "/_next/",
      ],
      disallow: ["/api/", "/connect/"],
    },
    sitemap: `${siteOrigin}/sitemap.xml`,
  };
}
