import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin Turbopack's filesystem root to this project. Without this, Turbopack
  // walks upward looking for self-references and may hit permission errors on
  // parent directories.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
