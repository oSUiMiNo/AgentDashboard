import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn/ui が生成するコードは "@/..." エイリアスを前提にしている
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    // core が rust-embed でこのフォルダを取り込み、単一バイナリへ同梱する（設計§1）
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // E2E は Playwright が担当するので Vitest の対象から外す
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
