import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // По умолчанию на Windows Vite часто слушает только [::1]; тогда http://127.0.0.1:5173 даёт ERR_CONNECTION_REFUSED.
    host: true,
    historyApiFallback: true,
  },
})

