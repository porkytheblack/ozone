import { defineConfig } from "tsup"

export default defineConfig({
    entry: ['app/server/index.ts'],
    // sourcemap: true,
    clean: true,
    dts: true,
    format: ['esm'],
})