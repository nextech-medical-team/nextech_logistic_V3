// A common tracking number is allowed. Only the obsolete diagnostic is removed.
// No job, label, document, status or business data is changed here.
export const sharedParcelReason="Colis partagé entre plusieurs commandes";
export function withoutSharedParcelReason(raw){
 if(typeof raw!=='string')return raw;
 const parts=raw.split(';');
 if(!parts.some(part=>part.trim()===sharedParcelReason))return raw;
 return parts.map(part=>part.trim()).filter(part=>part&&part!==sharedParcelReason).join('; ')||null;
}
export function withoutSharedParcelReasonSql(raw){
 const reason="'"+sharedParcelReason.replaceAll("'","''")+"'";
 const parts="regexp_split_to_table(("+raw+"),';') WITH ORDINALITY AS shared_reason(part,position)";
 const whitespace=String.fromCharCode(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279);
 const trimmed="btrim(part,'"+whitespace+"')";
 return "CASE WHEN EXISTS(SELECT 1 FROM "+parts+" WHERE "+trimmed+"="+reason+") THEN (SELECT string_agg("+trimmed+",'; ' ORDER BY position) FROM "+parts+" WHERE nullif("+trimmed+",'') IS NOT NULL AND "+trimmed+"<>"+reason+") ELSE ("+raw+") END";
}
export function projectSharedParcelContext(ctx){
 if(!ctx||typeof ctx!=='object')return ctx;
 for(const [target,key] of [[ctx.order,'issue'],[ctx.order,'resolution_error'],[ctx.erpJob,'error'],[ctx.job,'error'],[ctx.temuJob,'error']])if(target&&Object.hasOwn(target,key))target[key]=withoutSharedParcelReason(target[key]);
 return ctx;
}
