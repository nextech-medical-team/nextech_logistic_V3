export function labelItemText(l){const q=String(l.target_quantity??l.quantity??'').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');return `${l.target_sku||l.source_sku} (${q} pcs)`;}
export function labelDate(value){const s=String(value||'');const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return m[3]+'/'+m[2]+'/'+m[1];const fr=s.match(/^(\d{2}\/\d{2}\/\d{4})/);return fr?fr[1]:'';}
export function isAmazonPrime(o){
 if(o.channel!=='amazon')return false;
 for(const [key,value] of Object.entries(o.source_payload||{}))if(['isprime','isprimeorder','amazonprime'].includes(key.toLowerCase().replace(/[^a-z0-9]/g,''))&&['true','yes','1','oui'].includes(String(value).trim().toLowerCase()))return true;
 return false;
}
export function labelReference(o,max=40){
 const value=String(o.external_reference||o.source_payload?.externalreference||o.reference||'').replace(/\s+/g,' ').trim();
 if(!value)throw new Error('Référence externe absente pour l’étiquette');
 const suffix=amazonService(o);const tag=suffix?' ('+suffix+')':'';
 return value.slice(0,Math.max(0,max-tag.length))+tag;
}
export function amazonService(o){if(o.channel!=='amazon')return '';for(const [key,value] of Object.entries(o.source_payload||{}))if(['shipservicelevel','shippingservicelevel'].includes(key.toLowerCase().replace(/[^a-z0-9]/g,''))&&String(value).trim().toLowerCase()==='priority')return 'Priority';return isAmazonPrime(o)?'Prime':'';}
export function parcelRecipient(o,index=1,total=1,max=35){const suffix=total>1?' ('+index+'/'+total+')':'';return String(o.address?.name||o.recipient||'').replace(/\s+/g,' ').trim().slice(0,max-suffix.length)+suffix;}
export function gofoInstructions(o,max=100){const prefix=[amazonService(o),labelDate(o.source_date||o.received_at)].filter(Boolean).join(' ');const items=(o.lines||[]).map(labelItemText);let result=prefix,omitted=false;for(const item of items){if((result+' '+item).trim().length>max-8){omitted=true;continue;}result=(result+' '+item).trim();}return result+(omitted?' +Autres':'');}
export function labelReferences(o,max=40){return [labelReference(o,max),String(o.label_bl||o.erp_live?.bl?.label||'').trim(),labelDate(o.source_date||o.received_at)].filter(Boolean).map(v=>v.slice(0,max));}
export function labelNotes(o){
 const items=(o.lines||[]).map(labelItemText);
 const notes=[[],[]];let index=0,omitted=false;
 for(const item of items){if(item.length>50){omitted=true;continue;}if([...notes[index],item].join(' ').length>50){if(index===0)index=1;else{omitted=true;continue;}}if([...notes[index],item].join(' ').length<=50)notes[index].push(item);else omitted=true;}
 if(omitted){while([...notes[1],'+Autres'].join(' ').length>50)notes[1].pop();notes[1].push('+Autres');}
 return {note1:notes[0].join(' '),note2:notes[1].join(' '),full:items.join(' '),omitted};
}
