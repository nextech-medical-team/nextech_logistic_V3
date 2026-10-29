// Compatibility for any existing callers of the former tender-only gate.
export {assertBlBatchNumbers as assertTenderBatchNumbers} from './bl-batch-required.mjs';
