import type { NextConfig } from "next";

const internalApiBase = (
  process.env.API_URL ?? "http://api:8000/api"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    return [
      {
        source: '/_ediora-api/:path*',
        destination: `${internalApiBase}/:path*`,
      },
    ];
  },
};

export default nextConfig;
