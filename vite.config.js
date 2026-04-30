import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev server: skip CSP so Vite HMR (WebSocket + eval-based source maps) isn't blocked.
    // Production CSP is enforced by vercel.json at the edge.
    headers: baseHeaders(),
  },
  preview: {
    headers: { ...baseHeaders(), ...cspHeader() },
  },
})

// Headers safe for both dev and prod
function baseHeaders() {
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=()",
  };
}

// CSP applied in preview + production (via vercel.json) only
function cspHeader() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.openstreetmap.org",
      "connect-src 'self' https://raw.githubusercontent.com https://nominatim.openstreetmap.org",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  };
}
