import { runChild } from "./child.js";

// This file is an executable build output, not a Pi extension entrypoint.
const credential = process.env.PI_HERDR_CREDENTIAL_FILE;
delete process.env.PI_HERDR_CREDENTIAL_FILE;
if (!credential) {
  process.stderr.write("pi-herdr-core: missing private child control credential.\n");
  process.exitCode = 2;
} else {
  try {
    await runChild(credential);
    process.exit(0);
  } catch {
    // Never print raw provider/MCP/control exceptions: they can contain secrets.
    process.stderr.write("pi-herdr-core: controlled child failed; inspect the owning job record.\n");
    process.exit(2);
  }
}
