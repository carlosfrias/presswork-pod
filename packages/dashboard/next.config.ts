import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  // The dashboard pulls types from @presswork/shared as a workspace package;
  // tell Next to transpile it instead of treating it as a prebuilt dep.
  transpilePackages: ["@presswork/shared"],
  images: {
    remotePatterns: [
      // fal.ai design output, Supabase Storage (design PNGs), Printify mockups
      { protocol: "https", hostname: "**.fal.media" },
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "images-api.printify.com" },
      { protocol: "https", hostname: "images.printify.com" },
    ],
  },
};

export default config;
