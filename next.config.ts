import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true, // Required for static export
  },
  env: {
    NEXT_PUBLIC_ALCHEMY_KEY: process.env.NEXT_PUBLIC_ALCHEMY_KEY,
    NEXT_PUBLIC_COINGECKO_API_KEY: process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
  },
};

export default nextConfig;