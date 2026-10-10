import {erplainAccount} from './erplain-accounts.mjs';
export async function initializeStocks(db){await db.exec(`CREATE TABLE IF NOT EXISTS stock_cache(variant_id BIGINT PRIMARY KEY,sku TEXT,label TEXT,on_hand NUMERIC,available NUMERIC,active BOOLEAN,updated_at TIMESTAMPTZ DEFAULT now()); CREATE INDEX IF NOT EXISTS stock_cache_sku ON stock_cache(sku);`);}
export function stockSync(db,directory){
 let running=false,promise=null,state={done:0,total:0,error:null,lastRun:null};const api=erplainAccount(directory,'source');
 async function run(){
  state={done:0,total:0,error:null,lastRun:state.lastRun};
  try{await api.verify();let last=1;
   for(let page=1;page<=last;page++){
    const {Variants:v}=await api.request('query V3StockRead($page:Int!) { Variants(first:100,page:$page) { paginatorInfo { total lastPage } data { id sku label on_hand available active } } }',{page});
    last=v.paginatorInfo.lastPage;state.total=v.paginatorInfo.total;
    await db.query(`INSERT INTO stock_cache(variant_id,sku,label,on_hand,available,active) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,sku text,label text,on_hand numeric,available numeric,active boolean) ON CONFLICT(variant_id) DO UPDATE SET sku=excluded.sku,label=excluded.label,on_hand=excluded.on_hand,available=excluded.available,active=excluded.active,updated_at=now()`,[JSON.stringify(v.data)]);state.done+=v.data.length;
   }state.lastRun=new Date().toISOString();
  }catch(e){state.error=e.message;}finally{running=false;}
 }
 return {start(){if(!running){running=true;promise=run();}return {running,...state};},status:()=>({running,...state}),wait:()=>promise};
}
