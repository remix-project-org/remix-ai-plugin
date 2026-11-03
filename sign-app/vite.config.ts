import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../sign-dist',
    emptyOutDir: true,
  },
  // During dev, proxy API + MCP traffic to the MCP server so a single
  // ngrok tunnel on port 5173 covers everything
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/actions': 'http://localhost:3000',
      '/mcp': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Keep the connection alive for SSE / streamable-HTTP long polls
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('connection', 'keep-alive')
          })
        },
      },
    },
  },
})
