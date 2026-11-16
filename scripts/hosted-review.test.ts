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
 if(args.includes('--jq')) {console.log(mode==='moved' ? 'new-head' : process.env.HEAD_SHA); process.exit(0);}
 console.log(JSON.stringify({head:{sha:process.env.HEAD_SHA,ref:'feature',repo:{full_name:'owner/repo'}},base:{ref:'main'},user:{login:'author'},draft:false}));
} else if(path?.startsWith('repos/') && path.includes('/pulls/7/reviews')) {
 if(args.includes('--input')) { const body=readFileSync(args[args.indexOf('--input')+1],'utf8'); appendFileSync(process.env.RUNNER_TEMP+'/reviews',body); if(mode==='publish-fails') process.exit(1); }
 else console.log('[]');
} else if(path?.includes('/files?')) console.log('{}');
else if(path==='graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else if(path?.includes('/reactions?')) console.log('[]');
else if(path?.endsWith('/reactions')) console.log('9');
else if(path?.endsWith('/check-runs') && args.includes('--jq')) console.log('10');
else if(args.includes('--input') && args[args.indexOf('--input')+1]==='-') await Bun.stdin.text();
`);
  executable("codex", `#!${process.execPath}
if(process.argv.includes('--version')) {console.log('codex 0.169.0'); process.exit(0);}
if(process.env.TEST_MODE==='codex-fails') process.exit(1);
const verdict={conclusion:'success',summary:'',reactions:['+1'],commits:[{sha:process.env.HEAD_SHA,conclusion:'success'}],merge:null,annotations:[]};
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
    CODEX_CONFIG_FILE:config,CODEX_AUTH_FILE:auth,REVIEW_RUN_ID:"job-id",EVENT_NAME:"pull_request"};
  return {head,state,temp, run:()=>Bun.spawnSync(["bash",join(root,"scripts/hosted-review.sh")],{cwd:checkout,env,timeout:15000})};
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
