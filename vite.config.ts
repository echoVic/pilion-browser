import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react(), {
    name: 'pilion-development-csp',
    transformIndexHtml(html, context) {
      if (!context.server) return html;
      return html.replace(/content="default-src 'none';[^"]+"/, `content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*"`);
    },
  }],
  build: { outDir: 'dist-renderer' }, base: './',
});
