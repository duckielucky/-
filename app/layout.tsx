import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;
  return {
    title: "Lucky Scratch",
    description: "A fast, tactile neon scratch-card game with virtual coins.",
    applicationName: "Lucky Scratch",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Lucky" },
    openGraph: {
      title: "Lucky Scratch - Reveal the neon surprise",
      description: "Match lucky numbers, collect tickets, and chase dazzling virtual coin wins.",
      type: "website",
      images: [{ url: socialImage, width: 1200, height: 630, alt: "Lucky Scratch neon scratch ticket" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Lucky Scratch - Reveal the neon surprise",
      description: "Match lucky numbers, collect tickets, and chase dazzling virtual coin wins.",
      images: [socialImage],
    },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#12071a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
