export function marketplaceSince(settings,now=Date.now()){
 const days=Number(settings?.lookbackDays||7);if(!Number.isInteger(days)||days<1||days>7)throw Error('Réception limitée à sept jours');
 const start=Date.parse(settings?.since||'');if(!Number.isFinite(start))throw Error('Date de départ marketplace requise');return new Date(Math.max(start,now-days*86400000)).toISOString();
}
export function marketplaceAllowed(channel,payload,settings,now=Date.now()){
 if(!settings?.enabled)return false;
 const value=channel==='temu'?Number(payload?.detail?.parentOrderMap?.parentOrderTime)*1000:Date.parse(payload?.created_at);
 if(!Number.isFinite(value)||value<=0)throw Error('Date de création marketplace absente');
 return value>=Date.parse(marketplaceSince(settings,now))&&value<=now+300000;
}
