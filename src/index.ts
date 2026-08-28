#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";
import { getPortalMeta } from "./zoho.js";

/** stdio entry point — one server, one client, local process. */
async function main() {
  log.info(
    `starting zoho-timesheet MCP server (portal ${config.portalId}, ` +
      `dc .${config.domain}, user ${config.userId})`,
  );

  // Warm the portal metadata, but never block startup on Zoho being reachable.
  getPortalMeta().catch(() => {});

  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  log.info("connected on stdio");
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", String(reason));
});

main().catch((err) => {
  log.error("fatal", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
