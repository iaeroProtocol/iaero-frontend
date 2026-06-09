import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 👇 This makes `next build` produce a fully static site in /out


  // Images: already fine for export (no Image Optimization server)
  images: { unoptimized: true },

  webpack: (config) => {
    config.resolve = config.resolve || {}

    // prevent server-only modules from leaking into client
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      crypto: false,
    }

    // stub out Node-only optional deps from wallet stacks
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@react-native-async-storage/async-storage': false,
      'pino-pretty': false,
    }

    return config
  },
}

export default nextConfig
