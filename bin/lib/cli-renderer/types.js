/**
 * Event types the CliRenderer consumes.
 *
 * Keeping this vendor-neutral: renderer knows nothing about Claude
 * CLI, stream-json, or any specific streaming protocol. A streaming
 * parser (Phase 56b) translates Claude CLI's stream-json into these
 * events; a deploy-actor later could translate its own event stream
 * into the same shape. The renderer is a reusable primitive.
 */
export {};
//# sourceMappingURL=types.js.map