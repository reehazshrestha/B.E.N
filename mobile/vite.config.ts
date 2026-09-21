import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Capacitor serves the build from the device filesystem, so every asset
  // reference has to be relative.
  base: './',
  build: { outDir: 'dist' },
  server: { host: true, port: 5174 }
});
