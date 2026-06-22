import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/suggest': 'http://localhost:5001',
      '/search': 'http://localhost:5001',
      '/cache/debug': 'http://localhost:5001',
      '/api': 'http://localhost:5001',
    },
  },
});
