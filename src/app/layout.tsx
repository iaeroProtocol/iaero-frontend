import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ProtocolProvider } from "@/components/contexts/ProtocolContext";
import { PriceProvider } from "@/components/contexts/PriceContext";
import NetworkSwitcher from "@/components/NetworkSwitcher";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "iAERO Protocol - Liquid Staking",
  description: "Liquid staking protocol for AERO tokens on Base",
  viewport: "width=device-width, initial-scale=1.0, maximum-scale=1.0",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="dark min-h-screen bg-background">
        <PriceProvider updateInterval={0}>
          <ProtocolProvider>
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-900">
              <header className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16 py-4 flex justify-end">
                <NetworkSwitcher />
              </header>
              <div className="w-full max-w-[2560px] mx-auto">
                {children}
              </div>
            </div>
          </ProtocolProvider>
        </PriceProvider>
      </body>
    </html>
  );
}
