import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test/ui',workers:1,timeout:60000,reporter:'list',webServer:{command:'node scripts/ui-fixture.mjs',url:'http://127.0.0.1:31234',timeout:30000,reuseExistingServer:false},use:{baseURL:'http://127.0.0.1:31234',headless:true}});
