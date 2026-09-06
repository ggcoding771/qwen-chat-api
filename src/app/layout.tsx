import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Qwen Chat API — OpenAI-compatible gateway for chat.qwen.ai",
  description: "An OpenAI-compatible API proxy that drives a real browser session on chat.qwen.ai to satisfy Baxia anti-bot. Drop-in replacement for /v1/chat/completions.",
  keywords: ["Qwen", "OpenAI", "API", "Baxia", "proxy", "Next.js", "TypeScript"],
  authors: [{ name: "Qwen Chat API" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Qwen Chat API",
    description: "OpenAI-compatible gateway for chat.qwen.ai",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Qwen Chat API",
    description: "OpenAI-compatible gateway for chat.qwen.ai",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
