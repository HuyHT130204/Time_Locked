/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  output: 'standalone',
  serverExternalPackages: ['@solana/web3.js', '@coral-xyz/anchor'],
  webpack: (config, { isServer }) => {
    // Optimize for serverless deployment
    if (isServer) {
      config.externals = [...(config.externals || []), 'canvas', 'jsdom'];
    }
    
    // Reduce bundle size
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };

    // Tree shaking optimization
    config.optimization = {
      ...config.optimization,
      usedExports: true,
      sideEffects: false,
    };

    return config;
  },
  // Reduce bundle size by excluding unnecessary packages
  transpilePackages: ['@solana/wallet-adapter-react-ui'],
};

export default nextConfig;
