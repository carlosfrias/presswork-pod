import "../styles/globals.css";
import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { getSessionEmail, isAllowed } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Presswork",
  description: "Operator dashboard for the Presswork pipeline",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
  manifest: "/site.webmanifest",
  other: {
    "theme-color": "#ffffff",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const email = await getSessionEmail();
  const showNav = isAllowed(email);

  return (
    <html lang="en">
      <body className="min-h-screen bg-(--surface-0) text-(--text-primary) antialiased">
        {showNav && email && <Nav email={email} />}
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
