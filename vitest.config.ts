import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.env.ts'],
    include: ['tests/**/*.spec.ts'],
    threads: false,
    testTimeout: 60000,
    hookTimeout: 60000
  }
} as any);
