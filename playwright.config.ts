import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir:'./tests/e2e',
  fullyParallel:false,
  workers:1,
  timeout:30000,
  use:{
    baseURL:'http://127.0.0.1:3031',
    trace:'retain-on-failure',
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),args:['--no-sandbox']}
  },
  projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
  webServer:[
    {command:'npx tsx tests/cloud-browser-server.ts',url:'http://127.0.0.1:3032/api/v1/account',reuseExistingServer:false,timeout:30000},
    {command:'npx tsx tests/browser-server.ts',url:'http://127.0.0.1:3031/api/v1/health',reuseExistingServer:false,timeout:30000},
    {command:'npx tsx tests/static-browser-server.ts',url:'http://127.0.0.1:4174',reuseExistingServer:false,timeout:30000}
  ],
  // No GitHub, o relatório 'github' mostra o motivo de cada falha direto no resumo do teste.
  reporter:process.env.CI ? [['github'],['list'],['html',{open:'never'}]] : [['list'],['html',{open:'never'}]]
});
