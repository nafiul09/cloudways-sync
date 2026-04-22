import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Local add-on renderer builds to a single CJS bundle consumable by
// Local's Electron renderer process. The `main` field in package.json
// points at `lib/main/index.js`; the `renderer` field points here.
export default defineConfig({
  // Use the classic JSX runtime (React.createElement) to match Local's
  // React 16.14 environment. The automatic runtime requires
  // `react/jsx-runtime` as a separate module, which Local's custom
  // module loader may not resolve for addons.
  plugins: [react({ jsxRuntime: 'classic' })],
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'lib/renderer',
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/renderer/index.tsx'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // Local's renderer provides React + its own components. Don't bundle them.
      // Local ships React 16.14 at runtime; don't bundle React/ReactDOM,
      // and don't reference `react-dom/client` — that subpath doesn't
      // exist in React 16 and requiring it would crash the entire addon.
      external: [
        'react',
        'react-dom',
        '@getflywheel/local',
        '@getflywheel/local/renderer',
        '@getflywheel/local-components',
        'electron',
      ],
    },
    sourcemap: true,
    minify: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
  },
});
