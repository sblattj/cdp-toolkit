/**
 * Single source of truth for the package version string.
 *
 * mcp.ts reports it in the MCP `serverInfo` (and thus in the 2026-07-28
 * `_meta['io.modelcontextprotocol/serverInfo']` envelope) and on its stderr
 * ready line; keeping it in its own module means a release bump touches one
 * line here plus package.json, not a const buried in the server.
 */
export const VERSION = "2.2.0";
