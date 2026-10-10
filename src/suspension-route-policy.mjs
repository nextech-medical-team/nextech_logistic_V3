// These POST routes consult state. The existing dedicated cancellation/stock
// routes retain their own business guards; no general writer is exempted.
const dedicated=new Set(['/api/orders/processing','/api/partial/visible','/api/erplain/documents/refresh','/api/partial/refresh','/api/erplain/stock/restore-cancelled']);
export function suspensionGuardRequired(path,method){return method==='POST'&&/^\/api\/(resolutions|corrections|partial|parcels|labels|carriers|orders|erplain|temu|workspace|import-corrections)/.test(path)&&!dedicated.has(path);}
