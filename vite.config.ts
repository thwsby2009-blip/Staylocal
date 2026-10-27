import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './', // Capacitor 8.x 必備：相對路徑，否則 WebView 載不到 assets（空白畫面）
  plugins: [react()],
})
