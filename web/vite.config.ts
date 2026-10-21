import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("../shared", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  server: {
    port: 5173,
    fs: { allow: [".", shared] },
    proxy: { "/api": "http://localhost:3000" },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    // Pedaços separados e estáveis: o navegador guarda cada um em cache por conta própria, e o
    // editor (CodeMirror) e o KaTeX só baixam quando são usados.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/](@codemirror|@lezer|crelt|style-mod|w3c-keyname)[\\/]/.test(id)) return "codemirror";
          if (/[\\/]katex[\\/]/.test(id)) return "katex";
          if (/[\\/](markdown-it|mdurl|uc\.micro|linkify-it|punycode\.js|entities|dompurify)[\\/]/.test(id)) return "markdown";
        },
      },
    },
  },
});
