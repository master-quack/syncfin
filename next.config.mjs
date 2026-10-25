/** @type {import('next').NextConfig} */
// Tests build into their own folder (NEXT_DIST_DIR=.next-test) so they never overwrite the build a running server is serving.
// LOW_MEM=1 builds with one worker, for a machine that is short on memory.
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(process.env.LOW_MEM ? { experimental: { cpus: 1, workerThreads: false } } : {}),
};
