// Session snapshots carry the full conversation and tool output, and anyone who can read the repository's
// artifacts can download them. The broker derives the key from the repository alone, so changing the App,
// the provider or the model never strands an older snapshot.
// Usage: snapshot.ts save <archive> <dir> <path>...  |  snapshot.ts load <archive> <dir>
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [command, archive, dir, ...paths] = process.argv.slice(2);
// The marker separates a plain archive from a corrupted ciphertext, which must never be unpacked.
const encryptedMark = new TextEncoder().encode("CRSNP1\n"), plainMark = new TextEncoder().encode("CRSNP0\n");
const starts = (raw: Uint8Array, mark: Uint8Array) => mark.every((byte, index) => raw[index] === byte);

async function fetchKey() {
  const broker = process.env.BROKER;
  if (!broker) throw new Error("BROKER is required to look up session snapshot keys");
  // Ask for the key per operation, so it is never in the job environment while Codex runs.
  const oidc = Bun.spawnSync(["bash", join(import.meta.dir, "oidc.sh"), broker]);
  if (oidc.exitCode) throw new Error(oidc.stderr.toString());
  // A redirect would turn this POST into a GET, whose 405 must not read as a broker that predates snapshot keys.
  const response = await fetch(`${broker}/snapshot-key`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${oidc.stdout.toString().trim()}` } });
  // A broker that predates snapshot keys keeps the previous behaviour instead of failing every review.
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new Error(`Snapshot key request failed: ${response.status}; refusing to store the session unencrypted.`);
  const { key } = (await response.json()) as { key: string };
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new Error("The broker must return a 256-bit snapshot key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function unpack(tar: Uint8Array) {
  mkdirSync(dir, { recursive: true });
  if (await Bun.spawn(["tar", "-C", dir, "-xzf", "-"], { stdin: tar, stderr: "inherit" }).exited) throw new Error("Could not unpack the session archive");
}

if (command === "save") {
  const present = paths.filter(path => existsSync(join(dir, path)));
  // The upload used to fail when nothing was written; keep that failure instead of saving an empty archive.
  if (!present.length) throw new Error(`No session files to save in ${dir}`);
  // Ciphertext cannot be compressed by the upload, so the archive is compressed first.
  const tar = Bun.spawn(["tar", "-C", dir, "-czf", "-", ...present], { stdout: "pipe", stderr: "inherit" });
  const plain = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
  if (await tar.exited) throw new Error("Could not read the session into an archive");
  const key = await fetchKey();
  if (!key) {
    console.log("::warning::The broker does not provide snapshot keys, so this snapshot is stored in the clear.");
    await Bun.write(archive, Buffer.concat([plainMark, plain]));
  } else {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
    await Bun.write(archive, Buffer.concat([encryptedMark, iv, new Uint8Array(sealed)]));
  }
  console.log(`Saved ${present.join(", ")} into ${archive}`);
} else if (command === "load") {
  // An artifact saved before snapshots became one archive already unpacked its files.
  if (!(await Bun.file(archive).exists())) {
    // Restoring nothing would silently start a fresh session that looks like a continuation.
    if (!["sessions", "last-thread-id", "check-runs.jsonl"].some(path => existsSync(join(dir, path)))) throw new Error(`Neither an archive nor older session files are in ${dir}`);
    console.log("::notice::Restored an older session snapshot as it was uploaded.");
  } else {
    const raw = new Uint8Array(await Bun.file(archive).arrayBuffer());
    if (starts(raw, plainMark)) await unpack(raw.subarray(plainMark.length));
    else if (!starts(raw, encryptedMark)) throw new Error(`${archive} is not a session snapshot`);
    else {
      const key = await fetchKey();
      // A wrong key, a modified archive or a broker that lost the secret must leave the session empty.
      if (!key) throw new Error(`${archive} is encrypted, but the broker no longer provides snapshot keys.`);
      const iv = raw.subarray(encryptedMark.length, encryptedMark.length + 12);
      let plain: ArrayBuffer;
      try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw.subarray(encryptedMark.length + 12)); }
      catch { throw new Error(`${archive} could not be decrypted; the repository's snapshot key or the archive itself changed.`); }
      await unpack(new Uint8Array(plain));
    }
    rmSync(archive);
  }
} else throw new Error("Usage: snapshot.ts save <archive> <dir> <path>... | load <archive> <dir>");
