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
  title: "ClipForge — Client-side Audio / Video Editor",
  description:
    "Convert MP4 to 192kbps MP3, split video by custom timestamps, and export separate clips or one merged master file — 100% in your browser via FFmpeg.wasm.",
  keywords: [
    "video editor",
    "MP4 to MP3",
    "audio extraction",
    "FFmpeg.wasm",
    "client-side video cutting",
    "clip splitter",
  ],
  authors: [{ name: "ClipForge" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "ClipForge — Client-side Audio / Video Editor",
    description:
      "Convert MP4 to MP3, split by timestamps, and export clips — all in your browser.",
    url: "https://chat.z.ai",
    siteName: "ClipForge",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipForge — Client-side Audio / Video Editor",
    description:
      "Convert MP4 to MP3, split by timestamps, and export clips — all in your browser.",
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
