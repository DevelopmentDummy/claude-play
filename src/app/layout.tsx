import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Bridge",
  description: "Chat UI bridging to Claude Code CLI",
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
