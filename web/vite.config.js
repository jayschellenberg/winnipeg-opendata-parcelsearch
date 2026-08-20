import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      // Two pages: the app, and the land-sales charts it opens in a
      // second tab. Without naming both here Vite would build index.html
      // alone and charts.html would 404 in production while working
      // fine in dev.
      input: {
        main: resolve(__dirname, 'index.html'),
        charts: resolve(__dirname, 'charts.html'),
      },
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
    // Honour PORT so the dev server can be told which port to take. The
    // Manitoba sibling app lives in an adjacent repo and defaults to the
    // same 5173; without this, running both at once means one of them
    // silently answers for the other.
    port: Number(process.env.PORT) || 5173,
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
