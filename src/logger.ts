/**
 * stdout is the JSON-RPC channel for a stdio MCP server. Anything written
 * there that is not a protocol frame corrupts the stream, so every diagnostic
 * in this process goes to stderr. Never use console.log here.
 */
function emit(level: string, msg: string, extra?: unknown) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (extra === undefined) process.stderr.write(line + "\n");
  else process.stderr.write(`${line} ${safe(extra)}\n`);
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => emit("INFO ", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("WARN ", msg, extra),
  error: (msg: string, extra?: unknown) => emit("ERROR", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (process.env.DEBUG) emit("DEBUG", msg, extra);
  },
};
