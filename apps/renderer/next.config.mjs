import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@archivist/shared'],
  reactStrictMode: true,
  turbopack: { root: path.resolve(here, '../..') },
};

export default nextConfig;
