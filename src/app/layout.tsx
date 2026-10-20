import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Calculator",
  description: "Calculator with a local qwen3:8b assistant that computes through MCP tools.",
};

export const viewport: Viewport = {
  themeColor: "#0b1120",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans text-slate-100 antialiased">{children}</body>
    </html>
  );
}
