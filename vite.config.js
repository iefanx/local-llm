import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            devOptions: {
                enabled: true,
                suppressWarnings: true
            },
            includeAssets: ['favicon.png', 'apple-touch-icon.png', 'mask-icon.svg'],
            manifest: {
                name: 'Aithena',
                short_name: 'Aithena',
                description: 'A private, on-device AI assistant powered by WebGPU. Works offline after first model download.',
                theme_color: '#000000',
                background_color: '#000000',
                icons: [
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
                maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10 MiB
                runtimeCaching: [
                    {
                        urlPattern: /^https:\/\/esm\.run\/.*/i,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'esm-cache',
                            expiration: {
                                maxEntries: 10,
                                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                    {
                        urlPattern: /^https:\/\/huggingface\.co\/.*/i,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'model-cache',
                            expiration: {
                                maxEntries: 50,
                                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    }
                ]
            }
        })
    ]
})
