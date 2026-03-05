import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Bridge",
  description: "Chat UI bridging to Claude Code CLI",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
