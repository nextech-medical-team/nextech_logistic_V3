export const backgroundTasks=['receipt-recovery','temu-automatic-purchase','stock-resume','v2-followup','temu-logistics','marketplace-shopify','marketplace-temu','marketplace-collection','marketplace-inbox','read-catalog','product-weights','read-weights','read-stocks','read-services','catalog-periodic','erplain-refresh','procurement','erplain-preparation','automatic-preparation','corrections','resolutions','carrier-gls','carrier-gofo','partials','extra-parcels','exports','tracking','tracking-sync','lifecycle','maintenance','progress','order-workflow'];
export function validateTaskControls(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Interrupteurs invalides');
 for(const [key,value] of Object.entries(input))if(!backgroundTasks.includes(key)||typeof value!=='boolean')throw Error('Traitement ou valeur invalide');
 return input;
}
export async function taskControls(db,input){
 if(input!==undefined){validateTaskControls(input);await db.query("INSERT INTO settings(key,value) VALUES('background_tasks',$1) ON CONFLICT(key) DO UPDATE SET value=settings.value||excluded.value",[JSON.stringify(input)]);}
 const saved=(await db.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};
 return Object.fromEntries(backgroundTasks.map(name=>[name,saved[name]!==false]));
}
