import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(mode = "success") {
  // macOS resolves the /var tmpdir alias in process.cwd() of spawned stand-ins; compare canonical paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hosted-review-"))); dirs.push(dir);
  const checkout = join(dir, "repo"), bin = join(dir, "bin"), state = join(dir, "state"), temp = join(dir, "temp");
  for (const path of [checkout, bin, state, temp]) mkdirSync(path);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", checkout, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);
  git("init", "-q", "-b", "main"); git("commit", "--allow-empty", "-qm", "base");
  const head = git("rev-parse", "HEAD").stdout.toString().trim(); git("update-ref", "refs/remotes/origin/main", head);
  const executable = (name: string, contents: string) => { const path = join(bin, name); writeFileSync(path, contents); chmodSync(path, 0o755); };
  executable("bun", `#!/usr/bin/env bash
if [ "$1" = add ] || [ "$PWD" = "$RUNNER_TEMP/prices" ]; then exit 0; fi
if [ -n "$REVIEW_BUN_LOG" ]; then printf '%s\\t%s\\t%s\\n' "$PWD" "$1" "$2" >> "$REVIEW_BUN_LOG"; fi
exec '${process.execPath}' "$@"
`);
  executable("tail", "#!/bin/sh\nexit 0\n");
  executable("sleep", "#!/bin/sh\nexit 0\n");
  executable("gh", `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
const args=process.argv.slice(2), path=args[1], mode=process.env.TEST_MODE, temp=process.env.RUNNER_TEMP;
appendFileSync(temp+'/calls', JSON.stringify(args)+'\\n');
if(args[0]==='pr' && path==='merge' && mode==='merge-fails') process.exit(1);
if(path?.endsWith('/pulls/7') && !args.includes('-X')) {
 if(mode==='initial-read-fails') process.exit(1);
 if(args.includes('--jq')) {
  const query=args[args.indexOf('--jq')+1];
  const moved=mode==='moved'||mode==='stale-verdict'||(mode.startsWith('moved-on-retry')&&existsSync(temp+'/retried'));
  console.log(query==='.user.login'?'author':query.includes('.state')?'open '+process.env.HEAD_SHA:moved?'new-head':process.env.HEAD_SHA);
  process.exit(0);
 }
 console.log(JSON.stringify({head:{sha:mode==='initial-moved'?'new-head':process.env.HEAD_SHA,ref:'feature',repo:{full_name:'owner/repo'}},base:{ref:'main'},user:{login:'author'},draft:false}));
} else if(path?.startsWith('repos/') && path.includes('/pulls/7/reviews')) {
 if(args.includes('--input')) { const body=readFileSync(args[args.indexOf('--input')+1],'utf8'); appendFileSync(process.env.RUNNER_TEMP+'/reviews',body); if(mode==='publish-fails') process.exit(1); }
 else console.log('[]');
} else if(path?.includes('/files?')) console.log('{}');
else if(path==='graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else if(path?.includes('/reactions?')) console.log('[]');
else if(path?.endsWith('/reactions')) console.log('9');
else if(path?.endsWith('/check-runs') && args.includes('--jq')) console.log('10');
else if(path?.endsWith('/check-runs/42') && !args.includes('-X')) console.log(process.env.TEST_CHECK_STATUS||'completed');
else if(path?.endsWith('/check-runs/10') && !args.includes('-X')) {
 if(mode==='check-reply-rejected'||mode==='check-reply-unapplied') {
  console.log(JSON.stringify({head_sha:process.env.HEAD_SHA,status:'in_progress'}));
  process.exit(0);
 }
 const check=JSON.parse(readFileSync(temp+'/check.json','utf8'));
 delete check.output.annotations;
 console.log(JSON.stringify(check));
}
else if(path?.endsWith('/check-runs/10/annotations')) {
 const check=JSON.parse(readFileSync(temp+'/check.json','utf8'));
 console.log(JSON.stringify(mode==='check-reply-lost'?check.output.annotations:[]));
}
else if(path==='users/reviewer[bot]') {
 if(mode==='retry-identity' && !existsSync(temp+'/identity-retried')) {
  await Bun.write(temp+'/identity-retried','');
  process.stdout.write('{"message":"Service Unavailable"}');
  console.error('gh: Service Unavailable (HTTP 503)'); process.exit(1);
 }
 console.log('12345');
}
else if(args.includes('--input') && args[args.indexOf('--input')+1]==='-') {
 const body=await Bun.stdin.text();
 if(path?.includes('/check-runs/')) {
  await Bun.write(temp+'/check.json',body);
  if(mode.startsWith('check-reply-')) {
   const status=mode==='check-reply-rejected'?422:502;
   if(args.includes('--include')) process.stdout.write('HTTP/2.0 '+status+' Fixture\\nContent-Type: application/json\\r\\n\\r\\n');
   console.error('gh: request failed (HTTP '+status+')'); process.exit(1);
  }
 }
}
`);
  executable("codex", `#!${process.execPath}
if(process.argv.includes('--version')) {console.log('codex 0.169.0'); process.exit(0);}
const mode=process.env.TEST_MODE, retry=process.argv.includes('resume');
if(process.env.REVIEW_TRACE_RELAY_URL||process.env.TEST_TRACE_ENV==='true') await Bun.write(process.env.RUNNER_TEMP+'/trace-env.json', JSON.stringify({
  stockEnabled:process.env.TRACE_TO_LANGFUSE, projectKeyPresent:['LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_CODEX_PUBLIC_KEY','LANGFUSE_CODEX_SECRET_KEY'].some(key=>!!process.env[key]),
  relayTokenPresent:!!process.env.REVIEW_TRACE_RELAY_TOKEN
}));
if(process.env.TEST_TRACE_ENV==='true' && process.env.REVIEW_TRACE_RELAY_URL) {
  const timestamp=new Date().toISOString();
  const records=[{type:'session_meta',payload:{id:'fixture'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},{type:'event_msg',payload:{type:'task_complete'}}];
  await Bun.write(process.env.CODEX_HOME+'/sessions/rollout-fixture.jsonl',records.map(record=>JSON.stringify({...record,timestamp})).join('\\n')+'\\n');
}
if(retry) await Bun.write(process.env.RUNNER_TEMP+'/retried','');
if(mode==='codex-fails'||(retry&&mode==='moved-on-retry-error')) process.exit(1);
const invalid=mode==='stale-verdict'||mode==='invalid-verdict'||mode.startsWith('moved-on-retry');
const blocking=mode.startsWith('check-reply-');
const commits=invalid
 ? [{sha:process.env.HEAD_SHA,conclusion:'failure'},{sha:'new-head',conclusion:'success'}]
 : [{sha:process.env.HEAD_SHA,conclusion:blocking?'failure':'success'}];
const verdict={conclusion:blocking?'failure':'success',summary:blocking?'Fix this':'',reactions:['+1'],commits,merge:mode.startsWith('merge')?{method:'squash',subject:'Fixture',body:''}:null,annotations:blocking?[{path:'a.py',line:1,level:'failure',message:'Fix this'}]:[]};
await Bun.write(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(verdict));
await Bun.write(process.env.CODEX_HOME+'/auth.json',JSON.stringify({tokens:{refresh_token:'refreshed'}}));
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(verdict)}}));
`);
  const event = join(temp, "event.json"), config = join(temp, "config.toml"), auth = join(temp, "auth.json");
  writeFileSync(event, JSON.stringify({ action: "opened", sender: {login:"author",type:"User"}, pull_request: {number:7,head:{sha:head}} }));
  writeFileSync(config, 'model = "test-model"\n'); writeFileSync(auth, '{"tokens":{"refresh_token":"initial"}}');
  const env={...process.env, PATH:`${bin}:${process.env.PATH}`, TEST_MODE:mode, GITHUB_ACTION_PATH:root,GITHUB_REPOSITORY:"owner/repo",PR_NUMBER:"7", HEAD_SHA:head, CODEX_HOME:state,
    RUNNER_TEMP:temp, GH_CONFIG_DIR:join(dir,"gh"),BOT_LOGIN:"reviewer[bot]", GITHUB_EVENT_PATH:event,ACTIVITY_ID:"delivery",DETAILS_URL:"https://platform.example/reviews/run",DEFAULT_BRANCH:"main",
    CODEX_CONFIG_FILE:config,CODEX_AUTH_FILE:auth,REVIEW_RUN_ID:"job-id",EVENT_NAME:"pull_request",CHECK_ID:"",EYES_REACTION_ID:"",EYES_REACTION_PATH:"",
    REVIEW_OUTPUT_LOG:"",REVIEW_STEP_INDEX:""};
  return {head,state,temp,env,bin,checkout, run:(extra: Record<string, string> = {})=>Bun.spawnSync(["bash",join(root,"scripts/hosted-review.sh")],{cwd:checkout,env:{...env,...extra},timeout:15000})};
}

test("hosted relay disables installed content tracing and installs metadata hooks without storing its token in the session", () => {
  const f = fixture(), now = Date.now();
  mkdirSync(join(f.checkout, ".codex"));
  writeFileSync(join(f.checkout, ".codex/langfuse.json"), JSON.stringify({ enabled: true, public_key: "PRIVATE_PROJECT_KEY", secret_key: "PRIVATE_PROJECT_SECRET" }));
  const config = `model = "test-model"
[plugins."tracing@codex-observability-plugin"]
enabled = true
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "bun /tmp/langfuse/node_modules/@langfuse/codex-observability-plugin/dist/index.mjs"
`;
  const token = "rrt_" + "a".repeat(64);
  const result = f.run({ CODEX_CONFIG: config, LANGFUSE_PUBLIC_KEY: "PRIVATE_PROJECT_KEY", LANGFUSE_SECRET_KEY: "PRIVATE_PROJECT_SECRET",
    LANGFUSE_CODEX_SECRET_KEY: "PRIVATE_CODEX_PROJECT_SECRET", TRACE_TO_LANGFUSE: "true",
    REVIEW_TRACE_RELAY_URL: "http://127.0.0.1:1/trace", REVIEW_TRACE_RELAY_TOKEN: token,
    REVIEW_TRACE_RUN_STARTED_AT: String(now), REVIEW_TRACE_RELAY_EXPIRES_AT: String(now + 60_000) });
  expect(result.exitCode).toBe(0);
  const installed = Bun.TOML.parse(readFileSync(join(f.state, "config.toml"), "utf8")) as any;
  expect(installed.plugins["tracing@codex-observability-plugin"].enabled).toBe(false);
  const commands = Object.values(installed.hooks).flatMap((entries: any) => entries.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command)));
  expect(commands.filter((command: string) => command.includes("review-trace.mjs"))).toHaveLength(2);
  expect(commands.some((command: string) => command.includes("@langfuse"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.temp, "trace-env.json"), "utf8"))).toEqual({ stockEnabled: "false", projectKeyPresent: false, relayTokenPresent: true });
  expect(existsSync(join(f.temp, "langfuse"))).toBe(false);
  expect(readFileSync(join(f.state, "config.toml"), "utf8")).not.toContain(token);
  expect(readFileSync(join(f.temp, "review-trace/state.json"), "utf8")).not.toContain(token);
  expect(result.stdout.toString() + result.stderr.toString()).not.toMatch(/PRIVATE_PROJECT|PRIVATE_CODEX|rrt_/);
});

test("a superseded attempt skips tracing restored sessions", () => {
  const f = fixture("initial-moved"), now = Date.now();
  const result = f.run({ REVIEW_TRACE_RELAY_URL: "http://127.0.0.1:1/trace", REVIEW_TRACE_RELAY_TOKEN: "test",
    REVIEW_TRACE_RUN_STARTED_AT: String(now), REVIEW_TRACE_RELAY_EXPIRES_AT: String(now + 60_000) });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(f.temp, "review-trace"))).toBe(false);
});

test.each([false, true])("Actions relay strips inherited project credentials in the fresh run step (relay: %s)", async relay => {
  const f = fixture(), now = Date.now(), githubEnv = join(f.temp, "github-env");
  const events: { kind: string; status: string }[] = [];
  using receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    events.push(...(await request.json()).events);
    return new Response(null, { status: 202 });
  } });
  writeFileSync(githubEnv, "");
  const jobEnv = { ...f.env, AGENT: "false", BASE: "main", GITHUB_ENV: githubEnv, GITHUB_STEP_SUMMARY: join(f.temp, "summary.md"), TEST_TRACE_ENV: "true",
    LANGFUSE_PUBLIC_KEY: "PRIVATE_PROJECT_KEY", LANGFUSE_SECRET_KEY: "PRIVATE_PROJECT_SECRET",
    LANGFUSE_CODEX_PUBLIC_KEY: "PRIVATE_CODEX_PROJECT_KEY", LANGFUSE_CODEX_SECRET_KEY: "PRIVATE_CODEX_PROJECT_SECRET", TRACE_TO_LANGFUSE: "true",
    REVIEW_TRACE_RELAY_URL: relay ? new URL("/trace", receiver.url).href : "", REVIEW_TRACE_RELAY_TOKEN: relay ? "rrt_" + "a".repeat(64) : "",
    REVIEW_TRACE_RUN_STARTED_AT: String(now), REVIEW_TRACE_RELAY_EXPIRES_AT: String(now + 60_000) };
  const steps = (Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any).runs.steps;
  const configure = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", steps.find((step: any) => step.name === "Configure codex").run], { cwd: f.checkout, env: jobEnv, timeout: 15000 });
  expect(configure.exitCode).toBe(0);
  // GitHub starts the next step from the job environment plus GITHUB_ENV; a shell
  // unset in Configure codex does not remove the original job-level credentials.
  const persisted = Object.fromEntries(readFileSync(githubEnv, "utf8").trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  const child = Bun.spawn(["bash", "-eo", "pipefail", "-c", steps.find((step: any) => step.name === "Run codex review").run],
    { cwd: f.checkout, env: { ...jobEnv, ...persisted }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.temp, "trace-env.json"), "utf8"))).toEqual({ stockEnabled: relay ? "false" : "true", projectKeyPresent: !relay, relayTokenPresent: relay });
  expect(events.map(event => [event.kind, event.status])).toEqual(relay ? [["turn", "success"]] : []);
  expect(configure.stdout.toString() + configure.stderr.toString() + stdout + stderr).not.toMatch(/PRIVATE_PROJECT|PRIVATE_CODEX|rrt_/);
});

test("relay removes recognized content exporters without deleting unrelated hooks with Langfuse or Codex in their path", () => {
  const f = fixture(), now = Date.now(), action = join(f.temp, "langfuse-codex-action");
  symlinkSync(root, action, "dir");
  const retained = ["bash /tmp/langfuse-codex-checks/check.sh", "python checks.py --topic langfuse-codex", "echo /tmp/node_modules/@langfuse/codex-observability-plugin/dist/index.mjs"];
  const removed = ["bun /tmp/langfuse/node_modules/@langfuse/codex-observability-plugin/dist/index.mjs", 'node "/tmp/plugin cache/node_modules/@langfuse/codex-observability-plugin/dist/index.mjs"', "bun './node_modules/@langfuse/codex-observability-plugin/dist/index.mjs'"];
  const config = Bun.TOML.stringify({ model: "test-model", hooks: { Stop: [{ hooks: [...retained, ...removed].map(command => ({ type: "command", command })) }] } });
  const result = f.run({ GITHUB_ACTION_PATH: action, CODEX_CONFIG: config,
    REVIEW_TRACE_RELAY_URL: "http://127.0.0.1:1/trace", REVIEW_TRACE_RELAY_TOKEN: "rrt_" + "a".repeat(64),
    REVIEW_TRACE_RUN_STARTED_AT: String(now), REVIEW_TRACE_RELAY_EXPIRES_AT: String(now + 60_000) });
  expect(result.exitCode).toBe(0);
  const installed = Bun.TOML.parse(readFileSync(join(f.state, "config.toml"), "utf8")) as any;
  const commands = Object.values(installed.hooks).flatMap((entries: any) => entries.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command)));
  for (const command of retained) expect(commands).toContain(command);
  for (const command of removed) expect(commands).not.toContain(command);
  expect(commands.filter((command: string) => command === `bash ${action}/scripts/review-hook.sh`)).toHaveLength(3);
  expect(commands.filter((command: string) => command.includes("review-trace.mjs"))).toHaveLength(2);
});

test("shared setup supplies the App identity for commits and merges in linked worktrees", () => {
  const setup = fixture("retry-identity");
  const env: Record<string, string | undefined> = {...setup.env, AGENT: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANGFUSE_PUBLIC_KEY: "", HOME: setup.temp, LC_ALL: "C"};
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], {cwd: setup.checkout, env});
  expect(git("config", "user.useConfigOnly", "true").exitCode).toBe(0);
  const before = git("commit", "--allow-empty", "-m", "missing identity");
  expect(before.exitCode).not.toBe(0);
  expect(before.stderr.toString()).toContain("Author identity unknown");
  for (let i = 0; i < 2; i++) {
    const configured = Bun.spawnSync(["bash", "-e", "-c", '. "$GITHUB_ACTION_PATH/scripts/configure-review.sh"'], {cwd: setup.checkout, env});
    expect(configured.exitCode).toBe(0);
    expect(git("config", "user.email").stdout.toString().trim()).toBe("12345+reviewer[bot]@users.noreply.github.com");
  }
  expect(git("commit", "--allow-empty", "-m", "configured identity").exitCode).toBe(0);
  const worktree = join(setup.temp, "worktree");
  expect(git("worktree", "add", "-b", "fix", worktree).exitCode).toBe(0);
  expect(git("-C", worktree, "commit", "--allow-empty", "-m", "fix").exitCode).toBe(0);
  expect(git("merge", "--no-ff", "fix", "-m", "merge fix").exitCode).toBe(0);
  const identity = "reviewer[bot] <12345+reviewer[bot]@users.noreply.github.com>";
  for (const ref of ["HEAD", "HEAD^1", "fix"]) {
    expect(git("show", "-s", "--format=%an <%ae>%n%cn <%ce>", ref).stdout.toString().trim()).toBe(`${identity}\n${identity}`);
  }
});

test("hosted entry runs shared review, publishes at the exact head and returns refreshed credentials", () => {
  const setup=fixture(), result=setup.run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"completed",headSha:setup.head,published:true});
  expect(JSON.parse(readFileSync(join(setup.temp,"reviews"),"utf8"))).toEqual({event:"APPROVE",commit_id:setup.head});
  expect(readFileSync(join(setup.state,"sessions/.github-published-head"),"utf8")).toBe(setup.head+"\n");
  expect(JSON.parse(readFileSync(join(setup.state,"auth.json"),"utf8"))).toEqual({tokens:{refresh_token:"refreshed"}});
});

test.each([["Actions", "npm"], ["hosted", "npm"], ["Actions", "direct"], ["hosted", "direct"]])("%s isolates checkout preload without moving the review cwd (%s Codex)", (entry, launcher) => {
  const setup = fixture(), log = join(setup.temp, "bun.log"), codex = join(setup.bin, "codex");
  const marker = join(setup.temp, "preload-ran"), startup = join(setup.temp, "codex-startup.jsonl");
  const actionPath = join(setup.temp, "action path");
  symlinkSync(root, actionPath);
  const env = { ...setup.env, GITHUB_ACTION_PATH: actionPath, REVIEW_BUN_LOG: log, LANGFUSE_PUBLIC_KEY: "", HOME: setup.temp };
  writeFileSync(join(setup.checkout, "bunfig.toml"), 'preload = ["./untrusted-preload.ts"]\nconsole.depth = 1\n');
  writeFileSync(join(setup.checkout, "untrusted-preload.ts"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
throw new Error("checkout preload executed");
`);
  writeFileSync(join(setup.checkout, ".env"), "REVIEW_STARTUP_DOTENV=checkout-dotenv\n");
  // An absolute trusted entry point alone must still reproduce the unsafe startup.
  const probe = join(setup.temp, "trusted-probe.ts");
  writeFileSync(probe, 'console.log("trusted entry reached");\n');
  const unsafe = Bun.spawnSync([process.execPath, probe], { cwd: setup.checkout, env });
  expect(unsafe.exitCode).not.toBe(0);
  expect(unsafe.stderr.toString()).toContain("checkout preload executed");
  expect(unsafe.stdout.toString()).not.toContain("trusted entry reached");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  // These stand-ins use Bun, unlike native gh/Codex; isolate them independently of the wrapper under test.
  const mockConfig = join(setup.temp, "mock-bun.toml");
  writeFileSync(mockConfig, "# Only the native command stand-ins use this configuration.\n");
  const direct = `#!${process.execPath} --config=${mockConfig}`;
  const gh = join(setup.bin, "gh");
  writeFileSync(gh, readFileSync(gh, "utf8").replace(/^#!.*$/m, direct));
  writeFileSync(codex, readFileSync(codex, "utf8").replace(/^#!.*$/m, `${launcher === "npm" ? "#!/usr/bin/env node" : direct}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(startup)}, JSON.stringify({ cwd: process.cwd(), dotenv: process.env.REVIEW_STARTUP_DOTENV, args: process.argv.slice(2) }) + "\\n");`));
  if (launcher === "direct") {
    writeFileSync(join(setup.temp, "direct-codex.ts"), readFileSync(codex, "utf8"));
    writeFileSync(codex, `#!/usr/bin/env bash
exec '${process.execPath}' --config="$RUNNER_TEMP/mock-bun.toml" "$RUNNER_TEMP/direct-codex.ts" "$@"
`);
  }
  if (entry === "hosted") {
    const { result: review } = runIndexed(setup, env);
    expect({ exitCode: review.exitCode, preload: existsSync(marker) }).toEqual({ exitCode: 0, preload: false });
  } else {
    const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const runStep = (name: string, extra: Record<string, string>) => {
      const script = action.runs.steps.find(step => step.name === name)?.run;
      if (!script) throw new Error(`Missing Actions step ${name}`);
      return Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], { cwd: setup.checkout, env: { ...env, ...extra }, timeout: 15000 });
    };
    const githubEnv = join(setup.temp, "github-env"), stepEnv = {
      AGENT: "true", ISSUE_NUMBER: "7", PR_NUMBER: "", GITHUB_ENV: githubEnv,
      GITHUB_STEP_SUMMARY: join(setup.temp, "summary.md"),
    };
    const configured = runStep("Configure codex", stepEnv);
    expect({ exitCode: configured.exitCode, preload: existsSync(marker) }).toEqual({ exitCode: 0, preload: false });
    const output = Object.fromEntries(readFileSync(githubEnv, "utf8").trimEnd().split("\n").map(line => {
      const equal = line.indexOf("=");
      return [line.slice(0, equal), line.slice(equal + 1)];
    }));
    expect(output.CODEX_RUNTIME).toBe(launcher === "npm" ? join(actionPath, "scripts", "review-bun.sh") : "");
    expect(runStep("Run codex review", { ...stepEnv, ...output }).exitCode).toBe(0);
  }
  expect(existsSync(marker)).toBe(false);
  const launches = readFileSync(startup, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  expect(launches.map(({ cwd }) => cwd)).toEqual([setup.checkout, setup.checkout]);
  expect(launches[0].args).toEqual(["--version"]);
  expect(launches[1].args[0]).toBe("exec");
  if (launcher === "npm") expect(launches.map(({ dotenv }) => dotenv)).toEqual(["checkout-dotenv", "checkout-dotenv"]);
  const calls = readFileSync(log, "utf8").trimEnd().split("\n").map(line => line.split("\t"))
    .filter(([cwd, arg]) => cwd === setup.checkout && arg !== "--version");
  const launch = launcher === "npm" ? [codex] : [];
  const args = (entrypoint: string) => [setup.checkout, `--config=${join(actionPath, "scripts", "review-bun.toml")}`, entrypoint];
  const patches = join(actionPath, "scripts", "codex-patches.mjs");
  // The two sides of the review pipeline can start in either order.
  expect(calls.filter(call => call[2] === patches)).toEqual([args(patches)]);
  expect(calls.filter(call => call[2] !== patches)).toEqual([
    ...launch, join(actionPath, "scripts", "doc-fallbacks.ts"), "-e", ...(entry === "hosted" ? ["-e"] : []), ...launch,
  ].map(args));
});

test("a head that moves during hosted review is superseded without publishing a review", () => {
  const setup=fixture("moved"), result=setup.run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"superseded",currentHead:"new-head",published:false});
  expect(Bun.file(join(setup.temp,"reviews")).size).toBe(0);
});

test.each(["stale-verdict", "moved-on-retry", "moved-on-retry-error"])("hosted %s supersedes an invalid verdict without posting a diagnostic", mode => {
  const setup = fixture(mode), result = setup.run();
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(setup.temp, "retried"))).toBe(mode !== "stale-verdict");
  expect(JSON.parse(readFileSync(join(setup.temp, "result.json"), "utf8"))).toMatchObject({
    status: "superseded", headSha: setup.head, currentHead: "new-head", published: false,
  });
  expect(JSON.parse(readFileSync(join(setup.temp, "check.json"), "utf8"))).toMatchObject({
    status: "completed", conclusion: "neutral", output: { title: expect.stringContaining("Superseded by") },
  });
  const calls = readFileSync(join(setup.temp, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args[1] === "repos/owner/repo/check-runs/10" && args.includes("--input"))).toHaveLength(1);
  expect(calls.some(args => args[0] === "pr" && args[1] === "comment")).toBe(false);
  expect(existsSync(join(setup.temp, "reviews"))).toBe(false);
});

test("an invalid verdict on the current head still retries and reports the failure", () => {
  const setup = fixture("invalid-verdict"), result = setup.run();
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(join(setup.temp, "retried"))).toBe(true);
  expect(result.stdout.toString()).toContain("Codex returned no verdict");
  expect(JSON.parse(readFileSync(join(setup.temp, "result.json"), "utf8"))).toMatchObject({status: "failed", published: false});
  expect(existsSync(join(setup.temp, "superseded"))).toBe(false);
});

test.each(["codex-fails", "publish-fails"])("hosted %s leaves the publication checkpoint uncommitted", mode => {
  const setup=fixture(mode), result=setup.run();
  expect(result.exitCode).not.toBe(0);
  if (mode === "codex-fails") expect(readFileSync(join(setup.state,"last-thread-id"),"utf8")).toBe("");
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"failed",published:false});
  expect(Bun.file(join(setup.state,"sessions/.github-published-head")).size).toBe(0);
});

test.each(["lost", "unverified", "unapplied", "rejected"])("hosted check publication with a %s response", mode => {
  const confirmed = mode === "lost";
  const setup = fixture("check-reply-" + mode), result = setup.run();
  expect(result.exitCode).toBe(confirmed ? 0 : 1);
  expect(JSON.parse(readFileSync(join(setup.temp, "result.json"), "utf8"))).toMatchObject({
    status: confirmed ? "completed" : "failed", published: confirmed,
  });
  const calls = readFileSync(join(setup.temp, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  const patches = calls.filter(args => args[1] === "repos/owner/repo/check-runs/10" && args.includes("PATCH"));
  expect(patches.filter(args => args.includes("--input"))).toHaveLength(1);
  expect(patches.some(args => args.includes("conclusion=neutral"))).toBe(mode === "rejected");
  expect(calls.filter(args => args[1] === "repos/owner/repo/check-runs/10/annotations")).toHaveLength(mode === "lost" || mode === "unverified" ? 1 : 0);
  if (confirmed) expect(JSON.parse(readFileSync(join(setup.temp, "reviews"), "utf8"))).toMatchObject({ event: "REQUEST_CHANGES", commit_id: setup.head });
  else expect(existsSync(join(setup.temp, "reviews"))).toBe(false);
});

test("hosted draft release waits for a persisted session and preserves failed releases", () => {
  const setup=fixture(), pending=join(setup.state,"sessions/.github-pending-drafts");
  mkdirSync(join(setup.state,"sessions"));
  writeFileSync(pending,"https://github.com/owner/repo/pull/8\nhttps://github.com/owner/repo/pull/9\n");
  const bin=join(setup.temp,"bin"); mkdirSync(bin);
  const gh=join(bin,"gh");
  writeFileSync(join(bin,"sleep"),"#!/bin/sh\nexit 0\n"); chmodSync(join(bin,"sleep"),0o755);
  writeFileSync(gh,`#!/bin/sh\nif [ "$2" = view ]; then echo true; elif [ "$3" = https://github.com/owner/repo/pull/9 ]; then exit 1; fi\n`); chmodSync(gh,0o755);
  const result=Bun.spawnSync(["bash",join(root,"scripts/finish-hosted-review.sh")],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GITHUB_ACTION_PATH:root,CODEX_HOME:setup.state,GH_CONFIG_DIR:setup.temp,GITHUB_REPOSITORY:"owner/repo"}});
  expect(result.exitCode).toBe(0);
  expect(readFileSync(pending,"utf8")).toBe("https://github.com/owner/repo/pull/9\n");
});

test.each(["merge", "merge-fails"])("hosted %s waits for persistence and preserves the completed review", mode => {
  const setup=fixture(mode);
  expect(setup.run().exitCode).toBe(0);
  const calls=()=>readFileSync(join(setup.temp,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(calls().some(args=>args[0]==="pr"&&args[1]==="merge")).toBe(false);
  const finish=Bun.spawnSync(["bash",join(root,"scripts/finish-hosted-review.sh")],{env:setup.env});
  expect(finish.exitCode).toBe(0);
  expect(calls().filter(args=>args[0]==="pr"&&args[1]==="merge").length).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"completed",published:true});
  if (mode==="merge-fails") expect(finish.stdout.toString()).toContain("::warning::");
});

test("a consumed delivery preserves the existing published check", () => {
  const setup=fixture();
  mkdirSync(join(setup.state,"sessions"));
  writeFileSync(join(setup.state,"sessions/.github-published-head"),setup.head+"\n");
  writeFileSync(join(setup.state,"sessions/.github-deliveries.json"),'["delivery"]');
  const result=setup.run({CHECK_ID:"42"});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"skipped",checkId:"42"});
  const calls=readFileSync(join(setup.temp,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(["api","repos/owner/repo/pulls/7"]);
  expect(calls[1]).toEqual(["api","repos/owner/repo/check-runs/42","--jq",".status"]);
});

test.each(["queued", "in_progress", "completed"])("early supersession finalizes only unfinished supplied checks (%s)", status => {
  const setup=fixture("initial-moved"), result=setup.run({CHECK_ID:"42",TEST_CHECK_STATUS:status});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"superseded",currentHead:"new-head",checkId:"42",published:false});
  const calls=readFileSync(join(setup.temp,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const patches=calls.filter(args=>args.includes("PATCH"));
  expect(patches).toHaveLength(status==="completed"?0:1);
  if (patches.length) {
    expect(patches[0][1]).toBe("repos/owner/repo/check-runs/42");
    expect(patches[0]).toContain("status=completed");
    expect(patches[0]).toContain("conclusion=neutral");
  }
  expect(calls).toHaveLength(status==="completed"?2:3);
});

test.each(["opened", "reopened"])("a published %s delivery is skipped when replayed", action => {
  const setup=fixture();
  writeFileSync(setup.env.GITHUB_EVENT_PATH,JSON.stringify({action,sender:{login:"author",type:"User"},pull_request:{number:7,head:{sha:setup.head}}}));
  expect(setup.run().exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.state,"sessions/.github-deliveries.json"),"utf8"))).toContain("delivery");
  expect(setup.run().exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"skipped"});
});

test("a hosted run without SSE lets the CI waiter poll completed checks", () => {
  const tail=Bun.which("tail")!, setup=fixture();
  expect(setup.run({EVENTS_URL:""}).exitCode).toBe(0);
  writeFileSync(join(setup.bin,"tail"),`#!/bin/sh\nexec '${tail}' "$@"\n`);
  writeFileSync(join(setup.bin,"gh"),`#!${process.execPath}
if (process.argv[3].includes("/actions/runs?")) { console.log('{"workflow_runs":[]}'); process.exit(0); }
if (!process.argv[3].includes("/check-runs?")) process.exit(1);
const path=process.env.RUNNER_TEMP+'/poll-count', count=await Bun.file(path).exists()?Number(await Bun.file(path).text()):0;
await Bun.write(path,String(count+1));
console.log(JSON.stringify({check_runs:[{id:99,name:'format',status:count?'completed':'in_progress',conclusion:count?'success':null,app:{slug:'ci'}}]}));
`);
  const result=Bun.spawnSync(["bash",join(root,"scripts/wait-ci.sh"),setup.head,"format","pass"],{env:{...setup.env,REVIEW_HOSTED:"true",GITHUB_RUN_ID:"job-id",GITHUB_WORKFLOW_REF:"owner/repo/.github/workflows/agent.yml@refs/heads/main",CHECK_ID:"10",WAIT_CI_TIMEOUT:"4"},timeout:6000});
  expect(result.exitCode).toBe(0);
  expect(Number(readFileSync(join(setup.temp,"poll-count"),"utf8"))).toBeGreaterThan(1);
});


test("initial lookup failures leave supplied published checks untouched", () => {
  const setup=fixture("initial-read-fails");
  mkdirSync(join(setup.state,"sessions"));
  writeFileSync(join(setup.state,"sessions/.github-published-head"),setup.head+"\n");
  writeFileSync(join(setup.state,"sessions/.github-deliveries.json"),'["delivery"]');
  const result=setup.run({CHECK_ID:"42"});
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"failed",checkId:"42",published:false});
  const calls=readFileSync(join(setup.temp,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(args=>args[0]==="api"&&args[1]==="repos/owner/repo/pulls/7")).toBe(true);
});

test("the optional hosted step index points into the combined process log", () => {
  const setup = fixture(), started = Date.now();
  const { result, output, index } = runIndexed(setup);
  const finished = Date.now();
  expect(result.exitCode).toBe(0);
  const rows = readFileSync(index, "utf8").trim().split("\n").map(line => line.split(" "));
  const log = readFileSync(output);
  expect(rows.map(([step]) => step)).toEqual(["resolve", "open-check", "configure", "review", "publish-check", "publish-commits", "publish-pr", "checkpoint"]);
  const offsets = rows.map(([, value]) => Number(value));
  expect(offsets).toEqual([...new Set(offsets)].sort((a, b) => a - b));
  expect(offsets.every(offset => log[offset - 1] === 10)).toBe(true);
  const times = rows.map(([, , value]) => Number(value));
  expect(times.every(value => Number.isSafeInteger(value) && value >= started && value <= finished)).toBe(true);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  const review = rows.findIndex(([step]) => step === "review");
  expect(log.subarray(offsets[review], offsets[review + 1]).length).toBeGreaterThan(1);
});

function runIndexed(setup: ReturnType<typeof fixture>, env = setup.env) {
  const output = join(setup.temp, "output.log"), index = join(setup.temp, "steps");
  const fd = openSync(output, "w");
  try {
    const result = Bun.spawnSync(["bash", join(root, "scripts/hosted-review.sh")], {
      cwd: setup.checkout, env: { ...env, REVIEW_OUTPUT_LOG: output, REVIEW_STEP_INDEX: index }, stdout: fd, stderr: fd, timeout: 15000,
    });
    return { result, output, index };
  } finally {
    closeSync(fd);
  }
}
