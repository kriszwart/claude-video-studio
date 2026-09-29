import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Video Studio",
  description: "Project-based video creation powered by Claude",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
