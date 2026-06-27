import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import basicSsl from "@vitejs/plugin-basic-ssl";

const useHttp = process.env.VITE_USE_HTTP === "1";

export default defineConfig({
  // basicSsl generates a local self-signed cert so the Quest can load the
  // page over https:// (WebXR refuses to run on a non-secure origin).
  plugins: [viteSingleFile(), ...(useHttp ? [] : [basicSsl()])],
  build: {
    target: "es2020",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
});
