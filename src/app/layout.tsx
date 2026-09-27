import "./globals.css";
import React from "react";

export const metadata = {
  title: "Receipt Expense AI Integration Slice",
  description:
    "Async receipt extraction with Gemini and natural language follow-up summary with DeepSeek.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
