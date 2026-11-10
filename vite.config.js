import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, proxy: { '^/api/': 'http://localhost:3001' } },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'index.html', login: 'login.html', register: 'register.html',
        tanks: 'tanks.html', records: 'records.html', valve: 'valve.html',
      },
    },
  },
});