export const invalidTemuQuantities = 'Articles ou quantités TEMU invalides';
export const cancelledTemuFulfillment = 'TEMU · Annulée — aucun article restant à expédier';

const integer = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value.trim())) && Number.isSafeInteger(Number(value));

// TEMU quantities are sale units. Never substitute ERP quantities or the
// original (pre-cancellation) quantity into a transport request.
export function inspectTemuQuantities(detail, reference) {
  const items = detail?.orderList;
  if (detail?.parentOrderMap?.parentOrderSn !== reference || !Array.isArray(items) || !items.length) throw Error('Identité ou articles TEMU incomplets');
  const status = Number(detail.parentOrderMap.parentOrderStatus);
  const seen = new Set(), lines = [], cancelled = [];
  for (const item of items) {
    if (typeof item.orderSn !== 'string' || !item.orderSn.trim() || seen.has(item.orderSn) || !integer(item.quantity) || Number(item.quantity) < 0) throw Error(invalidTemuQuantities);
    seen.add(item.orderSn);
    const quantity = Number(item.quantity);
    if (quantity > 0) { lines.push({parentOrderSn: reference, orderSn: item.orderSn, quantity}); continue; }
    const original = Number(item.originalOrderQuantity), removed = Number(item.canceledQuantityBeforeShipment);
    if (![3, 4].includes(status) || Number(item.orderStatus) !== 3 || !integer(item.originalOrderQuantity) || !integer(item.canceledQuantityBeforeShipment) || original <= 0 || removed !== original) throw Error(invalidTemuQuantities);
    cancelled.push({orderSn: item.orderSn, originalQuantity: original, cancelledQuantity: removed});
  }
  if (status === 3 && lines.length && cancelled.length) throw Error('TEMU · Annulation incohérente : articles restants à vérifier');
  if (!lines.length && status !== 3) throw Error('TEMU · Annulation partielle : aucun article restant à préparer');
  return {lines, cancelled, fullyCancelled: status === 3 && !lines.length};
}

export function temuFulfillmentBlock(order) {
  if (order?.channel !== 'temu') return null;
  try { return inspectTemuQuantities(order.source_payload?.temuOrderDetail, order.reference).fullyCancelled ? cancelledTemuFulfillment : null; }
  catch { return null; }
}

// Presentation only: retain every independent issue, document and job state.
export function projectTemuQuantityDiagnosis(order) {
  const block = temuFulfillmentBlock(order);
  if (!block) return order;
  for (const [target, key] of [[order, 'issue'], [order.temu_job, 'error'], [order.erp_live_job, 'error'], [order, 'resolution_error']]) {
    if (target?.[key] === invalidTemuQuantities) target[key] = block;
  }
  return order;
}
