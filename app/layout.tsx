import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SplayCheck — visibility splay assessment",
  description:
    "Draw and check junction visibility splays (Manual for Streets / DMRB CD 109) on Google Maps. Desktop feasibility checks for highway engineers.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body className="h-full bg-slate-950 text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
