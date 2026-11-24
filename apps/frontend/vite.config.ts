import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const plugins = [react()];
  if (command === 'build') return { plugins, build: { license: true } };

  const port = process.env.PLANNER_PROXY_PORT ?? '27430';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PLANNER_PROXY_PORT must be a loopback port between 1 and 65535.');
  }

  return {
    plugins,
    server: {
      host: '127.0.0.1',
      proxy: { '^/(?:api|health)(?:/|\\?|$)': `http://127.0.0.1:${port}` },
    },
  };
});
