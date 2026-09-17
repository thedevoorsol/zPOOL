import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => ({
  // Some wallet-standard dependencies read process.env.NODE_ENV; give the browser a value.
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  optimizeDeps: { exclude: ['@lightprotocol/hasher.rs'] },
  plugins: [react(), nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events'], globals: { Buffer: true, global: true, process: true } })],
  build: { target: 'es2022' },
  server: { port: 5174 },
}));
