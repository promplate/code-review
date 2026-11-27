import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

try {
  // The caller runs this outside the checkout, since uvx ignores project configuration.
  const configured = process.env.UV_CACHE_DIR || execFileSync(process.argv[2], ["cache", "dir"], {
    // A cache lookup with no-cache enabled returns a disposable directory.
    env: { ...process.env, UV_NO_CACHE: "false" },
    encoding: "utf8",
  }).replace(/\r?\n$/, "");
  const cache = resolve(process.argv[3], configured);
  if (!configured || /[\r\n]/.test(cache)) process.exit(1);
  mkdirSync(cache, { recursive: true });
  accessSync(cache, constants.R_OK | constants.X_OK);
  // uvx starts the server from its cached environment. A writable noexec mount cannot host it.
  const probe = join(cache, `.review-${crypto.randomUUID()}`);
  closeSync(openSync(probe, "wx", 0o700));
  try {
    accessSync(probe, constants.X_OK);
  } finally {
    unlinkSync(probe);
  }
  console.log(cache);
} catch {
  process.exitCode = 1;
}
