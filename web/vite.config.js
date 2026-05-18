import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind v4's Vite integration scans source files for utility
  // classes and emits the generated stylesheet for the
  // `web/src/lib/tailwind.css` entry. Plain ES modules otherwise.
  plugins: [tailwindcss()],
  build: {
    target: 'es2020',
    // MapLibre alone is ~700 kB minified; without splitting it the
    // single bundle trips Rollup's 500 kB warning. Lift the ceiling
    // and bucket the heavy third-party deps into named vendor
    // chunks so a change in app code doesn't bust their browser
    // cache.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('maplibre-gl')) return 'maplibre';
          if (id.includes('@turf/')) return 'turf';
          if (id.includes('pmtiles')) return 'pmtiles';
          return 'vendor';
        },
      },
    },
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
