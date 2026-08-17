import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://127.0.0.1:3058' },
  },
  // `vite preview` serves the built output; it needs the proxy too, otherwise
  // testing a production build means testing it without an API.
  preview: {
    port: 5175,
    proxy: { '/api': 'http://127.0.0.1:3058' },
  },
  build: {
    outDir: 'dist',
    // Caddy serves dist/ straight from the repo, so the build IS the deploy.
    emptyOutDir: true,
    target: 'es2022',
  },
});
