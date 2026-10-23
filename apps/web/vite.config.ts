import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  // Caminhos relativos: o mesmo build funciona na raiz (iaulinbot.vercel.app) e dentro do Emet (emet.shinjiapps.com/promo/).
  base: './',
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': 'http://127.0.0.1:3030' } },
  // Static preview deliberately has no development API proxy.
  preview: { proxy: {} },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
});
