import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(mode = "success") {
  const dir = mkdtempSync(join(tmpdir(), "hosted-review-")); dirs.push(dir);
  const checkout = join(dir, "repo"), bin = join(dir, "bin"), state = join(dir, "state"), temp = join(dir, "temp");
  for (const path of [checkout, bin, state, temp]) mkdirSync(path);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", checkout, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);
  git("init", "-q", "-b", "main"); git("commit", "--allow-empty", "-qm", "base");
  const head = git("rev-parse", "HEAD").stdout.toString().trim(); git("update-ref", "refs/remotes/origin/main", head);
  const executable = (name: string, contents: string) => { const path = join(bin, name); writeFileSync(path, contents); chmodSync(path, 0o755); };
  executable("bun", `#!/usr/bin/env bash\nif [ "$1" = add ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`);
  executable("tail", "#!/bin/sh\nexit 0\n");
  executable("sleep", "#!/bin/sh\nexit 0\n");
  executable("gh", `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
const args=process.argv.slice(2), path=args[1], mode=process.env.TEST_MODE;
appendFileSync(process.env.RUNNER_TEMP+'/calls', JSON.stringify(args)+'\\n');
if(path?.endsWith('/pulls/7') && !args.includes('-X')) {
 if(mode==='initial-read-fails') process.exit(1);
 if(args.includes('--jq')) {const query=args[args.indexOf('--jq')+1];console.log(query==='.user.login'?'author':query.includes('.state')?'open '+process.env.HEAD_SHA:mode==='moved' ? 'new-head' : process.env.HEAD_SHA); process.exit(0);}
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
else if(args.includes('--input') && args[args.indexOf('--input')+1]==='-') await Bun.stdin.text();
`);
  executable("codex", `#!${process.execPath}
if(process.argv.includes('--version')) {console.log('codex 0.169.0'); process.exit(0);}
if(process.env.TEST_MODE==='codex-fails') process.exit(1);
const verdict={conclusion:'success',summary:'',reactions:['+1'],commits:[{sha:process.env.HEAD_SHA,conclusion:'success'}],merge:process.env.TEST_MODE==='merge'?{method:'squash',subject:'Fixture',body:''}:null,annotations:[]};
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
    CODEX_CONFIG_FILE:config,CODEX_AUTH_FILE:auth,REVIEW_RUN_ID:"job-id",EVENT_NAME:"pull_request",EYES_REACTION_ID:"",EYES_REACTION_PATH:""};
  return {head,state,temp,env,bin, run:(extra: Record<string, string> = {})=>Bun.spawnSync(["bash",join(root,"scripts/hosted-review.sh")],{cwd:checkout,env:{...env,...extra},timeout:15000})};
}

test("hosted entry runs shared review, publishes at the exact head and returns refreshed credentials", () => {
  const setup=fixture(), result=setup.run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"completed",headSha:setup.head,published:true});
  expect(JSON.parse(readFileSync(join(setup.temp,"reviews"),"utf8"))).toEqual({event:"APPROVE",commit_id:setup.head});
  expect(readFileSync(join(setup.state,"sessions/.github-published-head"),"utf8")).toBe(setup.head+"\n");
  expect(JSON.parse(readFileSync(join(setup.state,"auth.json"),"utf8"))).toEqual({tokens:{refresh_token:"refreshed"}});
});

test("a head that moves during hosted review is superseded without publishing a review", () => {
  const setup=fixture("moved"), result=setup.run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"superseded",currentHead:"new-head",published:false});
  expect(Bun.file(join(setup.temp,"reviews")).size).toBe(0);
});

test.each(["codex-fails", "publish-fails"])("hosted %s leaves the publication checkpoint uncommitted", mode => {
  const setup=fixture(mode), result=setup.run();
  expect(result.exitCode).not.toBe(0);
  if (mode === "codex-fails") expect(readFileSync(join(setup.state,"last-thread-id"),"utf8")).toBe("");
  expect(JSON.parse(readFileSync(join(setup.temp,"result.json"),"utf8"))).toMatchObject({status:"failed",published:false});
  expect(Bun.file(join(setup.state,"sessions/.github-published-head")).size).toBe(0);
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

test("hosted merge waits for the caller to persist the published session", () => {
  const setup=fixture("merge");
  expect(setup.run().exitCode).toBe(0);
  const calls=()=>readFileSync(join(setup.temp,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(calls().some(args=>args[0]==="pr"&&args[1]==="merge")).toBe(false);
  const finish=Bun.spawnSync(["bash",join(root,"scripts/finish-hosted-review.sh")],{env:setup.env});
  expect(finish.exitCode).toBe(0);
  expect(calls().filter(args=>args[0]==="pr"&&args[1]==="merge")).toHaveLength(1);
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
  writeFileSync(join(setup.bin,"gh"),`#!${process.execPath}\nconst path=process.env.RUNNER_TEMP+'/poll-count';const count=await Bun.file(path).exists()?Number(await Bun.file(path).text()):0;await Bun.write(path,String(count+1));console.log(JSON.stringify({check_runs:[{id:99,name:'format',status:count?'completed':'in_progress',conclusion:count?'success':null,app:{slug:'ci'}}]}));\n`);
  const result=Bun.spawnSync(["bash",join(root,"scripts/wait-ci.sh"),setup.head,"format","pass"],{env:{...setup.env,ACTIONS_TOKEN:"",CHECK_ID:"10",WAIT_CI_TIMEOUT:"4"},timeout:6000});
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
