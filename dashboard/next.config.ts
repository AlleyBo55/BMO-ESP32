import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Enable typed routes in App Router for better DX
  typedRoutes: true,
  // ffmpeg-static is optional and resolved at runtime via require(); keep it out
  // of the bundle so the build never depends on the package being present.
  serverExternalPackages: ['ffmpeg-static'],
};

export default config;
