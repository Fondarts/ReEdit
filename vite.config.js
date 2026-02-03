import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Proxy requests to ComfyUI to avoid CORS issues
    proxy: {
      '/system_stats': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/prompt': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/history': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/queue': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/interrupt': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/view': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/ws': {
        target: 'ws://127.0.0.1:8188',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
