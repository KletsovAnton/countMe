import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    base: '/countMe/',
    plugins: [tailwindcss()],
    build: { chunkSizeWarningLimit: 1000 },
});
