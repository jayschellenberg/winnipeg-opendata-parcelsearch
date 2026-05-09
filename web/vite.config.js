import { defineConfig } from 'vite';

export default defineConfig({
  // Plain static site, no framework plugins needed.
  build: {
    target: 'es2020',
  },
  // Dev-server proxy for the Manitoba contaminated-sites registry CSV.
  // The upstream doesn't set CORS headers, so the browser can't fetch
  // it directly. In production the same path is rewritten by Vercel
  // (see vercel.json). Both environments resolve `/proxy/contam-sites.csv`
  // to the same upstream URL — this keeps the client-side fetch URL
  // identical in dev and prod.
  server: {
    proxy: {
      '/proxy/contam-sites.csv': {
        target: 'https://manitoba.ca',
        changeOrigin: true,
        secure: true,
        rewrite: () =>
          '/sd/waste_management/contaminated_sites/registry/cs-data.csv',
      },
    },
  },
});
