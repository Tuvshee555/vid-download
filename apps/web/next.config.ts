import path from 'node:path';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@vd/shared', '@vd/core'],
  // ffmpeg-static resolves its binary relative to its own folder: keep it un-bundled.
  serverExternalPackages: ['ffmpeg-static'],
  // Monorepo: trace files from the repository root so the hoisted node_modules are included.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Ship the yt-dlp and ffmpeg binaries with the API functions that run them.
  outputFileTracingIncludes: {
    '/api/**/*': ['./bin/**/*', '../../node_modules/ffmpeg-static/ffmpeg', '../../node_modules/ffmpeg-static/package.json'],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
