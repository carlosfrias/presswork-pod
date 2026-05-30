// Library entrypoint for consumers that only need to publish a single listing
// (e.g. the dashboard's per-listing "Publish to Etsy" action). Kept separate
// from index.ts so importers don't pull in the agent poll-loop (poller.js) and
// its dependency cone. resumePublish drives the full Etsy publish path
// (compliance gates, draft create, inventory, image upload, activate).
export { resumePublish } from "./publisher.js";
