import {readFile} from 'node:fs/promises';
import path from 'node:path';

const fields={
 'erplain-live.json':['ERPLAIN_API_KEY','ERPLAIN_COMPANY_ID'],
 'temu-production.json':['TEMU_APP_KEY','TEMU_APP_SECRET','TEMU_ACCESS_TOKEN'],
 'carriers-production.json':['GLS_CLIENT_ID','GLS_CLIENT_SECRET','GOFO_APP_ID','GOFO_APP_SECRET','GOFO_BASE_URL','GOFO_ROUTE_COUNTRY'],
 'tracking-production.json':['GLS_TRACK_TRACE_CLIENT_ID','GLS_TRACK_TRACE_CLIENT_SECRET','GLS_TRACK_TRACE_BASE_URL','GLS_TRACK_TRACE_AUTH_BASE_URL']
};

// Environment values take precedence over private JSON files. Never log this object.
export async function trackingSyncConfig(directory,file,env=process.env){
 let config={};
 try{config=JSON.parse((await readFile(path.join(directory,file),'utf8')).replace(/^\uFEFF/,''));}
 catch(e){if(e.code!=='ENOENT')throw Error('Configuration privée illisible : '+file);}
 for(const key of fields[file]||[])if(env[key]?.trim())config[key]=env[key].trim();
 if(file==='erplain-live.json')return {
  url:config.url||'https://api.erplain.app/graphql',
  companyId:config.ERPLAIN_COMPANY_ID||config.companyId||100174,
  apiKey:config.ERPLAIN_API_KEY||config.apiKey
 };
 if(file==='carriers-production.json')config.GOFO_BASE_URL||='https://api-eu.gofoexpress.com';
 return config;
}
