/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' 使构建产物可部署在任意子路径
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true, // 允许局域网访问（手机测试 UI；摄像头需 https，见 README）
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    // heic2any 等大依赖动态分包
    chunkSizeWarningLimit: 15000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand'],
          exporter: ['pdf-lib', 'jszip'],
        },
      },
    },
  },
});
