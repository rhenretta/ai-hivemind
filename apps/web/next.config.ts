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

};

export default nextConfig;
