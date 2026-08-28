import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Studio runs on 7000; the BFF (apps/bff) runs on 7001. The BFF registers no
// CORS plugin (see apps/bff/RAPOR.md), so every /api call must go through this
// same-origin proxy in dev. `rewrite` strips the /api prefix because the BFF
// serves its routes at the root (/auth/login, /runs, ...), not under /api.
const BFF_ORIGIN = process.env["MAESTRO_BFF_ORIGIN"] ?? "http://localhost:7001";

/**
 * Which interface the dev server binds, and which Host headers it answers.
 *
 * Both matter behind a reverse proxy, and they fail differently:
 *
 * - `host`: the default binds loopback only, so a proxy on another machine —
 *   or in another container — connects to nothing and reports 502. Set
 *   `MAESTRO_STUDIO_HOST=0.0.0.0` when something in front needs to reach it.
 *   The default stays loopback: a dev server that binds every interface
 *   because nobody set a variable is exposed by omission.
 * - `allowedHosts`: Vite refuses a request whose `Host` header it does not
 *   recognise (DNS-rebinding protection). A proxy forwards the PUBLIC name, so
 *   `maestro.bank.local` arrives at a server that only knows `localhost` and
 *   the answer is a 403 the proxy surfaces as a gateway error. List the names
 *   the proxy will send in `MAESTRO_STUDIO_ALLOWED_HOSTS` (comma-separated).
 *
 * This is the DEV server. In production Studio is a static bundle behind nginx
 * (deploy/docker/Dockerfile.studio) and neither setting applies.
 */
const STUDIO_HOST = process.env["MAESTRO_STUDIO_HOST"] ?? "127.0.0.1";
const ALLOWED_HOSTS = (process.env["MAESTRO_STUDIO_ALLOWED_HOSTS"] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

/**
 * Say which names ARE allowed, at start-up.
 *
 * Vite's refusal names the host it rejected and tells the reader to edit
 * `vite.config.js` — advice that does not apply here, because the list comes
 * from an environment variable. Worse, the usual cause is a one-character
 * difference between the name in the variable and the name the proxy sends
 * (`code.` vs `coder.`), and neither the refusal nor the config file shows
 * what the running server actually accepts. Printing it turns a five-minute
 * hunt into a glance at the log.
 */
if (ALLOWED_HOSTS.length > 0) {
  console.info(`[studio] izin verilen host adları: ${ALLOWED_HOSTS.join(", ")}`);
} else if (STUDIO_HOST !== "127.0.0.1") {
  console.warn(
    "[studio] MAESTRO_STUDIO_ALLOWED_HOSTS boş ve sunucu loopback dışına bağlandı — " +
      "ters vekilden gelen istekler 'Blocked request' ile reddedilir. " +
      "Vekilin ilettiği adı bu değişkene yazın (virgülle ayırarak).",
  );
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The @maestro/config barrel re-exports env.ts, which reads process.env
      // and pulls zod in. The browser only needs the message catalog, so we
      // alias straight to the i18n module and keep Node code out of the bundle.
      "@maestro/config/i18n": fileURLToPath(
        new URL("../../packages/config/src/i18n.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: STUDIO_HOST,
    port: 7000,
    strictPort: true,
    ...(ALLOWED_HOSTS.length > 0 ? { allowedHosts: ALLOWED_HOSTS } : {}),
    proxy: {
      "/api": {
        target: BFF_ORIGIN,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: { port: 7000, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
