import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
    // Hand-edited PNG uploads from the Design page's Replace-image form land
    // at 3000×3600 transparent and routinely run 5–20MB. Next.js Server
    // Actions default to a 1MB body limit, which would reject every realistic
    // upload. 25mb leaves headroom for the largest print-resolution PNGs.
    serverActions: {
      bodySizeLimit: "25mb",
    },
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
