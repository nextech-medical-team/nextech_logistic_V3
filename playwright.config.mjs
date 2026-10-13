import {defineConfig} from '@playwright/test';
const url='http://127.0.0.1:'+Number(process.env.UI_FIXTURE_PORT||31234);
export default defineConfig({testDir:'./test/ui',workers:1,timeout:60000,reporter:'list',webServer:{command:'node scripts/ui-fixture.mjs',url,timeout:30000,reuseExistingServer:false},use:{baseURL:url,headless:true}});
