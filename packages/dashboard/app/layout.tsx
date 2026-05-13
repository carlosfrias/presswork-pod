import "../styles/globals.css";
import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { getSessionEmail, isAllowed } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Presswork",
  description: "Operator dashboard for the Presswork pipeline",
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
