import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    base: '/countMe/',
    plugins: [
        tailwindcss(),
        // Установка на экран «Домой» и запуск без сети: оболочка приложения кэшируется сервис-воркером,
        // данные — локальным кэшем Firestore. Запросы к ИИ и курсам валют не кэшируются.
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['apple-touch-icon.png', 'favicon-32.png'],
            manifest: {
                name: 'AI Кошелек — учет расходов',
                short_name: 'Кошелек',
                description: 'Учет расходов: чеки, голос и текст с ИИ',
                lang: 'ru',
                start_url: '/countMe/',
                scope: '/countMe/',
                display: 'standalone',
                orientation: 'portrait',
                theme_color: '#4f46e5',
                background_color: '#f1f5f9',
                icons: [
                    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,png,woff2}'],
                navigateFallback: '/countMe/index.html',
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
                cleanupOutdatedCaches: true,
            },
        }),
    ],
    build: { chunkSizeWarningLimit: 1000 },
});
