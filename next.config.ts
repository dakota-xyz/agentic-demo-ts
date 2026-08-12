import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev badge sits bottom-left, exactly on top of the rail's
  // "Sign out" row. Off, so what is on screen while developing is what ships.
  devIndicators: false,
  /* config options here */
};

export default nextConfig;
