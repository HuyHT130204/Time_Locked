import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProviders } from "../components/WalletProviders";
import "@solana/wallet-adapter-react-ui/styles.css";

export const metadata: Metadata = {
  title: "Time-Locked Wallet | Solana",
  description: "Secure your Solana assets with time-based locks. Create, manage, and withdraw time-locked SOL and SPL tokens.",
  keywords: ["Solana", "Time Lock", "Wallet", "DeFi", "Blockchain", "Cryptocurrency"],
  authors: [{ name: "Time-Locked Wallet Team" }],
  openGraph: {
    title: "Time-Locked Wallet | Solana",
    description: "Secure your Solana assets with time-based locks",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Time-Locked Wallet | Solana",
    description: "Secure your Solana assets with time-based locks",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1e40af",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased bg-black text-white min-h-screen">
        <WalletProviders>
          {children}
        </WalletProviders>
      </body>
    </html>
  );
}
