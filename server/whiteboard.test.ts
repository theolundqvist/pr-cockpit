import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("whiteboard API preserves conflicted and malformed documents and does not revive evicted completed PRs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-whiteboard-test-"));
  try {
    const process = Bun.spawn(["bun", "--eval", `
      import assert from 'node:assert/strict';
      import { db, getSetting, setSetting } from './server/db.ts';
      import { handleWhiteboard } from './server/whiteboard.ts';
      import { emptyBoard, reconcileBoard } from './shared/whiteboard.js';
      const url = 'http://localhost/api/whiteboard';
      const get = () => handleWhiteboard(new Request(url));
      const put = (revision, document) => handleWhiteboard(new Request(url, {method:'PUT', body:JSON.stringify({revision,document})}));
      setSetting('whiteboard_enabled','true');
      const pr = {repo:'example/cockpit',number:1,title:'Review migration',author:'octocat',state:'OPEN',headSha:'a'.repeat(40),updatedAt:'2026-09-29T10:00:00Z'};
      const document = reconcileBoard(emptyBoard(),[pr]);
      document.snapshots['example/cockpit#1'] = {...pr,state:'CLOSED',updatedAt:'2026-09-29T11:00:00Z'};
      assert.equal((await put(0,document)).status,200);
      const original = getSetting('personal_whiteboard_v1');
      const conflicting = structuredClone(document); conflicting.nodes[1].note = 'unsaved in another window';
      assert.equal((await put(0,conflicting)).status,409);
      assert.equal(getSetting('personal_whiteboard_v1'),original);
      db.query("INSERT INTO pr_index(repo,number,title,state,is_draft,author,updated_at,involves_me) VALUES(?,?,?,?,?,?,?,?)").run('example/cockpit',1,'Old index title','OPEN',0,'octocat','2026-09-29T09:00:00Z',1);
      const loaded = await (await get()).json();
      assert.equal(loaded.document.snapshots['example/cockpit#1'].state,'CLOSED');
      assert.equal(loaded.prs.some(pr=>pr.repo==='example/cockpit' && pr.number===1),false);
      const invalid = structuredClone(document); invalid.nodes.push(invalid.nodes[1]);
      assert.equal((await put(1,invalid)).status,400);
      assert.equal(getSetting('personal_whiteboard_v1'),original);
      setSetting('personal_whiteboard_v1','{broken');
      assert.equal((await get()).status,422);
      assert.equal((await put(0,document)).status,400);
      assert.equal(getSetting('personal_whiteboard_v1'),'{broken');
      setSetting('whiteboard_enabled','false');
      assert.equal((await get()).status,404);
      assert.equal(getSetting('personal_whiteboard_v1'),'{broken');
      console.log('CAS conflict, historical regression, validation, malformed-data retention and disabled-data retention passed');
    `], { cwd: join(import.meta.dir, ".."), env: { ...Bun.env, COCKPIT_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(exitCode).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real cache drafts save through HTTP and disabling rejects an already-streaming save", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-whiteboard-http-"));
  try {
    const process = Bun.spawn(["bun", "--eval", `
      import assert from 'node:assert/strict';
      import { upsertPr, getSetting, setSetting } from './server/db.ts';
      import { handleWhiteboard } from './server/whiteboard.ts';
      import { writeSettings } from './server/settings.ts';
      import { emptyBoard, reconcileBoard } from './shared/whiteboard.js';
      upsertPr({repo:'example/cockpit',number:1,state:'draft',is_draft:1,title:'Draft migration',author:'octocat',
        base_ref:'main',head_ref:'draft',head_sha:'a'.repeat(40),updated_at:'2026-09-29T10:00:00Z',
        additions:1,deletions:0,changed_files:1,commit_count:1,mergeable:'UNKNOWN',merge_state_status:'DRAFT',
        auto_merge_enabled:0,viewer_is_author:1,viewer_review_requested:0,viewer_review_state:null,
        ci_status:'PENDING',review_decision:null,unresolved_count:0,needs_me_rank:0,greptile_confidence:null,
        greptile_reviewed_sha:null,greptile_unresolved_count:0,detail_json:'{}',fetched_at:'2026-09-29T10:01:00Z'});
      writeSettings({whiteboard_enabled:true});
      let entered = null;
      const server = Bun.serve({port:0,fetch(req) { entered?.(); return handleWhiteboard(req); }});
      try {
        const url = 'http://127.0.0.1:' + server.port + '/api/whiteboard';
        const initial = await (await fetch(url)).json();
        assert.equal(initial.prs[0].state,'OPEN');
        assert.equal(initial.prs[0].isDraft,true);
        const document = reconcileBoard(emptyBoard(),initial.prs);
        const card = document.nodes.find(n=>n.type==='pr');
        card.note = 'Draft notes survive'; card.x = 2048;
        assert.equal((await fetch(url,{method:'PUT',body:JSON.stringify({revision:0,document})})).status,200);
        const saved = await (await fetch(url)).json();
        assert.equal(saved.document.nodes.find(n=>n.type==='pr').note,'Draft notes survive');
        assert.equal(saved.document.nodes.find(n=>n.type==='pr').x,2048);
        const original = getSetting('personal_whiteboard_v1');
        const started = Promise.withResolvers();
        entered = started.resolve;
        let stream;
        const payload = JSON.stringify({revision:1,document});
        const body = new ReadableStream({start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(payload.slice(0,16))); }});
        const pending = fetch(url,{method:'PUT',body,duplex:'half'});
        await started.promise;
        writeSettings({whiteboard_enabled:false});
        stream.enqueue(new TextEncoder().encode(payload.slice(16))); stream.close();
        assert.equal((await pending).status,404);
        assert.equal(getSetting('personal_whiteboard_v1'),original);
        console.log('Real draft arrival, durable notes/geometry, and in-flight disable boundary passed');
      } finally { server.stop(true); }
    `], { cwd: join(import.meta.dir, ".."), env: { ...Bun.env, COCKPIT_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(exitCode).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 10000);
