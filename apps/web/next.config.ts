import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // Transpile workspace packages so Next.js can process their TypeScript/ESM.
    // react-syntax-highlighter ships a mixed CJS/ESM bundle that Next.js 15
    // can't resolve automatically — explicit transpilation fixes the runtime crash.
    transpilePackages: ['@ai-hivemind/shared', 'react-syntax-highlighter'],

    // Enforce strict mode in development
    reactStrictMode: true,

    // Disable x-powered-by header
    poweredByHeader: false,

    // Proxy /api/* requests to the Express backend.
    // This allows frontend code to use relative paths (fetch("/api/foo"))
    // instead of hardcoding a port. BACKEND_PORT is injected as an env var
    // in sandbox containers; defaults to 3001 for local dev.
    rewrites: async () => [
        {
            source: '/api/:path*',
            destination: `http://localhost:${process.env['BACKEND_PORT'] ?? '3001'}/api/:path*`,
        },
    ],
};

export default nextConfig;
