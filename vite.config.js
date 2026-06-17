import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
    plugins: [react()],
    build: {
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name: "vendor-react",
                            test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                            priority: 4,
                        },
                        {
                            name: "vendor-three",
                            test: /node_modules[\\/](three|three-mesh-bvh)[\\/]/,
                            priority: 3,
                            maxSize: 420 * 1024,
                        },
                        {
                            name: "vendor-postprocessing",
                            test: /node_modules[\\/](@react-three[\\/]postprocessing|postprocessing)[\\/]/,
                            priority: 2,
                        },
                        {
                            name: "vendor-r3f",
                            test: /node_modules[\\/]@react-three[\\/]/,
                            priority: 1,
                        },
                    ],
                },
            },
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        host: "127.0.0.1",
        port: 1420,
        strictPort: true,
    },
    preview: {
        host: "127.0.0.1",
        port: 4173,
        strictPort: true,
    },
});
