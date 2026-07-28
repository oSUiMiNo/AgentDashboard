import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** core サーバの待ち受け先（設計§12 の既定値）。 */
const CORE_ORIGIN = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn/ui が生成するコードは "@/..." エイリアスを前提にしている
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // 開発中は vite の HMR を使いたいので、WebSocket と API だけ core へ中継する。
    // 本番（単一バイナリ）では core 自身が web を配信するのでこの設定は使われない
    proxy: {
      '/ws': { target: CORE_ORIGIN, ws: true },
      '/api': { target: CORE_ORIGIN },
    },
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
