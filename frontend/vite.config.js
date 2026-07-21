import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    // During `npm run dev`, forward API calls to the Express server (Phase 0
    // runs both side by side: Vite on 5173 for the UI, Express on 3000 for
    // /api/*). In production the Express server just serves the built files
    // directly, so this proxy only matters for local development.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
