import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const bebas = Bebas_Neue({ weight: "400", subsets: ["latin"], variable: "--font-bebas", display: "swap" });
const inter = Inter({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "SyncFin",
  description: "Same film, same second, different sofas.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#17222C", viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bebas.variable} ${inter.variable}`}>
      <body className="min-h-screen bg-bg font-sans text-body text-text antialiased">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="font-display text-d3 tracking-wide text-text">
            SyncFin
          </Link>
          <Link href="/library" className="text-small text-muted hover:text-text">
            Library
          </Link>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
