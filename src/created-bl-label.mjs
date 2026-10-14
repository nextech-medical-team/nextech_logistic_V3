// A recorded, published BL is sufficient for the label step. No BC, stock,
// mapping, fiscal or preparation comparison is performed after that boundary.
export function hasCreatedBl(o){return !!o?.erp_live?.bl?.id&&['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(o.erp_live.bl.status);}
export function hasPartialCreatedBl(d){return hasCreatedBl({erp_live:{bl:d?.bl}});}
export const createdBlSql="erp_live->'bl'->>'id' IS NOT NULL AND erp_live->'bl'->>'status' IN ('pending','make_the_shipment','in_preparation','ready_to_ship')";
