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
  // The dashboard pulls types from @presswork/shared and @presswork/listing as
  // workspace packages; tell Next to transpile them instead of treating them as
  // prebuilt deps. @presswork/listing exposes resumePublish for per-listing
  // publish from the dashboard without requiring a full agent run.
  // @presswork/shared is consumed as prebuilt dist/*.js; @presswork/listing is
  // transpiled from source for its types. Both must be listed so Next treats
  // them as first-party rather than external CJS deps.
  transpilePackages: ["@presswork/shared", "@presswork/listing"],
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
