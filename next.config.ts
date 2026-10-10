import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The annual report PDF reads its fonts and logo from disk at runtime, which file tracing cannot see.
  outputFileTracingIncludes: { '/api/vendors/[id]/evaluations/[revisionId]/pdf': ['./node_modules/font-th-sarabun-new/fonts/THSarabunNew-webfont.ttf', './node_modules/font-th-sarabun-new/fonts/THSarabunNew_bold-webfont.ttf', './public/images/cbh-lab-logo-v3.png'] },
  async headers() {
    return [{source:'/:path*',headers:[
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
      {key:'X-Frame-Options',value:'DENY'},
      {key:'Permissions-Policy',value:'camera=(self), microphone=()'},
    ]}];
  },
};

export default nextConfig;
