// Compare provider decimal quantities exactly. No fixed epsilon may turn an
// actual shortage into availability; repeated decimal lines must sum exactly.
function decimal(value){
 if(!['number','string'].includes(typeof value))throw Error('Stock non vérifiable : quantité non décimale');
 const text=String(value).trim(),m=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
 if(!m||text.length>512||!Number.isFinite(Number(text)))throw Error('Stock non vérifiable : quantité non décimale');
 const exponent=Number(m[4]||0),places=(m[3]||'').length-exponent;
 if(!Number.isInteger(exponent)||Math.abs(exponent)>1000||Math.abs(places)>1000)throw Error('Stock non vérifiable : précision non exploitable');
 const digits=BigInt((m[1]||'')+m[2]+(m[3]||''));
 return places<0?{n:digits*10n**BigInt(-places),places:0}:{n:digits,places};
}
function text(n,places){
 const sign=n<0n?'-':'';if(n<0n)n=-n;
 if(!places)return sign+n.toString();
 const digits=n.toString().padStart(places+1,'0');
 return sign+(digits.slice(0,-places)+'.'+digits.slice(-places)).replace(/\.?0+$/,'');
}
export function exactStockAvailability(rows){
 const parsed=rows.map(r=>[r.quantity,r.reserved_quantity,r.available,r.on_hand].map(decimal)),places=Math.max(0,...parsed.flat().map(x=>x.places));
 const values=parsed.map(r=>r.map(x=>x.n*10n**BigInt(places-x.places)));
 let need=0n,reserved=0n,available=null,onHand=null;
 for(const [q,r,a,h] of values){need+=q;reserved+=r>0n?r:0n;available=available===null||a<available?a:available;onHand=onHand===null||h<onHand?h:onHand;}
 if(available===null||onHand===null)throw Error('Stock non vérifiable : lignes absentes');
 const withReservations=available+reserved,physical=onHand<withReservations?onHand:withReservations,usable=physical>0n?physical:0n;
 return {sufficient:usable>=need,need:text(need,places),usable:text(usable,places),missing:text(need>usable?need-usable:0n,places)};
}
