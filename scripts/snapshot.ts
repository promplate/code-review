// Session snapshots carry the full conversation and tool output, and anyone who can read the repository's
// artifacts can download them. The broker derives the key from the repository alone, so changing the App,
// the provider or the model never strands an older snapshot.
// Usage: snapshot.ts save <archive> <dir> [path...]  |  snapshot.ts load <archive> <dir>
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [command, archive, dir, ...paths] = process.argv.slice(2);
const SESSION_PATHS = ["sessions", "last-thread-id", "check-runs.jsonl"];
// Each marker identifies a format, so a truncated or foreign file can never be mistaken for a session archive.
const encryptedMark = new TextEncoder().encode("CRSNP1\n"), plainMark = new TextEncoder().encode("CRSNP0\n");
// Off by default: a repository opts in when its readers must not download the conversation.
const encryption = process.env.ENCRYPT_SNAPSHOTS === "true";
const starts = (raw: Uint8Array, mark: Uint8Array) => mark.every((byte, index) => raw[index] === byte);

async function fetchKey() {
  const broker = process.env.BROKER;
  if (!broker) throw new Error("BROKER is required to look up session snapshot keys");
  // Ask for the key per operation, so it is never in the job environment while Codex runs.
  const oidc = Bun.spawnSync(["bash", join(import.meta.dir, "oidc.sh"), broker]);
  if (oidc.exitCode) throw new Error(oidc.stderr.toString());
  // Only a completed transfer may supply the key. Keep failed attempts' bodies out of retry.sh's stdout.
  const request = Bun.spawnSync(["bash", join(import.meta.dir, "retry.sh"), "bash", "-c", 'reply=$(curl "$@") && printf %s "$reply"', "_",
    "-fsS", "-w", "%{stderr}\\n%{http_code}\\n", "-X", "POST",
    "-H", `Authorization: Bearer ${oidc.stdout.toString().trim()}`, `${broker}/snapshot-key`], { stdin: "ignore" });
  const status = Number(request.stderr.toString().match(/^\d{3}$/gm)?.at(-1));
  // Without a key there is no way to keep the session out of the artifact, so it is never stored in the clear.
  if (status === 404) throw new Error("The broker does not provide snapshot keys, so the session cannot be stored or restored encrypted.");
  if (request.exitCode !== 0 || status !== 200) throw new Error(`Snapshot key request failed: ${status || "no response"}; refusing to continue without one.`);
  const { key } = JSON.parse(request.stdout.toString()) as { key: string };
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new Error("The broker must return a 256-bit snapshot key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function unpack(tar: Uint8Array) {
  mkdirSync(dir, { recursive: true });
  if (await Bun.spawn(["tar", "-C", dir, "-xzf", "-"], { stdin: tar, stderr: "inherit" }).exited) throw new Error("Could not unpack the session archive");
}

if (command === "save") {
  const present = (paths.length ? paths : SESSION_PATHS).filter(path => existsSync(join(dir, path)));
  // The upload used to fail when nothing was written; keep that failure instead of saving an empty archive.
  if (!present.length) throw new Error(`No session files to save in ${dir}`);
  // Ciphertext cannot be compressed by the upload, so the archive is compressed first.
  const tar = Bun.spawn(["tar", "-C", dir, "-czf", "-", ...present], { stdout: "pipe", stderr: "inherit" });
  const plain = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
  if (await tar.exited) throw new Error("Could not read the session into an archive");
  const key = encryption ? await fetchKey() : null;
  if (!key) {
    console.log("::warning::Snapshots are not encrypted; anyone who can read this repository can download them.");
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
    if (!SESSION_PATHS.some(path => existsSync(join(dir, path)))) throw new Error(`Neither an archive nor older session files are in ${dir}`);
    console.log("::notice::Restored an older session snapshot as it was uploaded.");
  } else {
    const raw = new Uint8Array(await Bun.file(archive).arrayBuffer());
    // The archive's own marker decides, so turning encryption off still opens what an encrypted save wrote.
    if (starts(raw, plainMark)) await unpack(raw.subarray(plainMark.length));
    else if (!starts(raw, encryptedMark)) throw new Error(`${archive} is not a session snapshot`);
    else {
      const key = await fetchKey();
      const iv = raw.subarray(encryptedMark.length, encryptedMark.length + 12);
      let plain: ArrayBuffer;
      // A wrong key or a modified archive must leave the session empty rather than restore it.
      try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw.subarray(encryptedMark.length + 12)); }
      catch { throw new Error(`${archive} could not be decrypted; the repository's snapshot key or the archive itself changed.`); }
      await unpack(new Uint8Array(plain));
    }
    rmSync(archive);
  }
} else throw new Error("Usage: snapshot.ts save <archive> <dir> [path...] | load <archive> <dir>");
