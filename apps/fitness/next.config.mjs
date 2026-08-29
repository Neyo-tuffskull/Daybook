/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Decision D4: both apps are served from one origin under a path prefix, so
  // a single origin-scoped session cookie covers both and SameSite can stay
  // Strict. Moving to subdomains later means clearing this and setting the
  // cookie Domain instead.
  basePath: '/fit',
  transpilePackages: ['@daybook/ui', '@daybook/domain', '@daybook/contracts'],
  experimental: { typedRoutes: true },
};
export default nextConfig;
