// Read routes and dedicated transitions retain their own business guards.
// Excel preparation can release only its import hold, after API verification;
// the generic guard would reject that hold before the transition can run.
const dedicated=new Set(['/api/labels/batches','/api/orders/processing','/api/partial/visible','/api/erplain/documents/refresh','/api/partial/refresh','/api/erplain/stock/restore-cancelled','/api/temu/excel/prepare']);
export function suspensionGuardRequired(path,method){return method==='POST'&&/^\/api\/(resolutions|corrections|partial|parcels|labels|carriers|orders|erplain|temu|workspace|import-corrections)/.test(path)&&!dedicated.has(path);}
