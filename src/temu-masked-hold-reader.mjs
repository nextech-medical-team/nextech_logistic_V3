import {marketplaceContentFrozen} from './marketplace-content-freeze.mjs';
import {readFile} from 'node:fs/promises';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {evidenceHash} from './temu-masked-hold-plan.mjs';
const countries=new Map(Object.entries({France:'FR',Belgium:'BE',Croatia:'HR','Czech Republic':'CZ',Denmark:'DK',Greece:'GR',Hungary:'HU',Ireland:'IE',Italy:'IT',Latvia:'LV',Netherlands:'NL',Poland:'PL',Portugal:'PT',Slovenia:'SI',Spain:'ES',Sweden:'SE',Austria:'AT',Germany:'DE',Finland:'FI',Luxembourg:'LU',Malta:'MT',Estonia:'EE',Lithuania:'LT',Slovakia:'SK',Romania:'RO',Bulgaria:'BG',Cyprus:'CY','United Kingdom':'GB',Switzerland:'CH',Norway:'NO',Iceland:'IS'}).map(([k,v])=>[k.toLowerCase(),v]));
export function maskedTemuSourceReader({directory='/var/lib/nextech-live',config,apiFactory=temuApi,vaultLoader=loadShopVault,now=()=>Date.now(),shouldStop=()=>false}={}){
 const apis=new Map();let identity,rootApi,privateConfig;
 return async order=>{
  if(marketplaceContentFrozen(order))throw Error('BC rempli · Relecture des articles et adresses TEMU désactivée');
  const reference=order.source_reference||order.reference,shop=String(order.source_payload?.sourceShop||order.source_payload?.mallId||'');
  if(order.channel!=='temu'||!/^PO-\d+-\d+$/.test(reference)||!/^\d+$/.test(shop))throw Error('TEMU · Identité de la commande non vérifiable');
  const read=async(api,type,args={})=>{if(shouldStop())throw Error('Arrêt demandé');return api.read(type,args);};
  if(!privateConfig){privateConfig=config||JSON.parse((await readFile(directory+'/temu-production.json','utf8')).replace(/^\uFEFF/,''));rootApi=apiFactory(privateConfig);identity=await read(rootApi,'bg.open.accesstoken.info.get');apis.set(String(identity.mallId),rootApi);}
  let api=apis.get(shop);
  if(!api){const associated=(identity.associatedMallTokenList||[]).find(x=>String(x.mallId)===shop);const candidates=[];if(associated?.accessToken)candidates.push({...privateConfig,TEMU_ACCESS_TOKEN:associated.accessToken});
   for(const entry of await vaultLoader(directory))if(entry.appKey===privateConfig.TEMU_APP_KEY&&entry.country===order.address?.country)candidates.push({...privateConfig,TEMU_APP_SECRET:entry.appSecret,TEMU_ACCESS_TOKEN:entry.accessToken});
   for(const candidate of candidates){const possible=apiFactory(candidate),check=await read(possible,'bg.open.accesstoken.info.get');if(String(check.mallId)===shop){api=possible;break;}}
   if(!api)throw Error('TEMU · Boutique source non accessible');apis.set(shop,api);
  }
  const args={parentOrderSn:reference},first=await read(api,'bg.order.detail.v2.get',args),rawShipping=await read(api,'bg.order.decryptshippinginfo.get',args),amounts=await read(api,'bg.order.amount.query',args),last=await read(api,'bg.order.detail.v2.get',args);
  if(first.parentOrderMap?.parentOrderSn!==reference||last.parentOrderMap?.parentOrderSn!==reference||amounts.parentOrderMap?.parentOrderSn!==reference||evidenceHash(first)!==evidenceHash(last))throw Error('TEMU · Identité ou détail modifié pendant la lecture');
  const shipping=rawShipping.result||rawShipping,country=countries.get(String(first.parentOrderMap.regionName1||'').normalize('NFKC').trim().toLowerCase());
  if(!country||country!==order.address?.country)throw Error('TEMU · Pays source différent ou non vérifiable');
  return {origin:'provider',readOnly:true,complete:true,channel:'temu',orderId:order.id,shop,checkedAt:new Date(now()).toISOString(),first,last,payload:{detail:{...structuredClone(first),v3Amounts:{data:amounts}},shipping,country}};
 };
}
