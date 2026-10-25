import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 3000),
    // Required by shopify app dev (Cloudflare tunnel).
    allowedHosts: true,
    hmr: { protocol: "wss", clientPort: 443 },
  },
  // Workspace packages export TypeScript: Vite must compile them instead of
  // treating them as external dependencies.
  ssr: { noExternal: ["@sync/db", "@sync/worker"] },
  plugins: [reactRouter()],
});
