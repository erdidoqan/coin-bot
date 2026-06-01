import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/admin',
  trailingSlash: true,
  distDir: 'out',
};

export default nextConfig;
