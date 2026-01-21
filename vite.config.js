import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless'
        }
    },
    worker: {
        format: 'es',
        plugins: () => [wasm(), topLevelAwait()]
    },
    plugins: [
        wasm(),
        topLevelAwait(),
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
                id: '/aithena',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                display_override: ['standalone', 'minimal-ui'],
                orientation: 'any',
                dir: 'ltr',
                lang: 'en',
                categories: ['productivity', 'utilities', 'education'],
                prefer_related_applications: false,
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
                ],
                screenshots: [
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        form_factor: 'wide',
                        label: 'Aithena AI Assistant'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        form_factor: 'narrow',
                        label: 'Aithena AI Assistant Mobile'
                    }
                ],
                shortcuts: [
                    {
                        name: 'New Chat',
                        short_name: 'Chat',
                        description: 'Start a new AI conversation',
                        url: '/',
                        icons: [{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' }]
                    }
                ],
                launch_handler: {
                    client_mode: 'focus-existing'
                }
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
