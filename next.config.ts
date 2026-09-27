import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=86400' },
  // HTML CSP is request-specific in middleware. A static value here would
  // overwrite its nonce and the stricter policies of attachment/OAuth routes.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: '/', headers: securityHeaders },
      { source: '/:path*', headers: securityHeaders },
    ];
  },
};

export default nextConfig;
