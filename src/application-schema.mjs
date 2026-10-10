import {initializeProcessingClock} from './order-priority.mjs';
// Schema-only entry point: no HTTP server, credentials, timers or API calls.
import {initializeCarrierJobs} from './carrier-jobs.mjs';
import {initializeComments2005} from './comments-2005.mjs';
import {initializeTemuShipping} from './temu-shipping.mjs';
import {initializeStocks} from './stock-sync.mjs';
import {initializeErplainLive} from './erplain-live-workflow.mjs';
import {initializePartialDeliveries} from './partial-deliveries.mjs';
import {initializeCorrections} from './problem-corrections.mjs';
import {initializeResolutions} from './problem-resolution.mjs';
import {initializeProcurement} from './procurement.mjs';
import {initializeLifecycle} from './lifecycle-worker.mjs';
import {initializeErplainRefresh} from './erplain-refresh.mjs';
import {initializeMarketplaceInbox} from './marketplace-inbox.mjs';
import {initializeLabelDownloads} from './label-downloads.mjs';
import {initializeReadServiceJobs} from './read-service-jobs.mjs';
export const applicationInitializers=[initializeCarrierJobs,initializeComments2005,initializeTemuShipping,initializeStocks,initializeErplainLive,initializePartialDeliveries,initializeCorrections,initializeResolutions,initializeProcurement,initializeLifecycle,initializeErplainRefresh,initializeMarketplaceInbox,initializeLabelDownloads,initializeReadServiceJobs,initializeProcessingClock];
