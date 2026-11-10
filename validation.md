# Project validation


### npm install
status: ok
npm warn install-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   better-sqlite3@13.0.3 (install: node-gyp rebuild)
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
npm warn install-scripts   fsevents@2.3.3 (install: (install scripts present))
npm warn install-scripts
npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.


### npm run typecheck
status: ok

> career-firm@1.0.0 typecheck
> tsc -p tsconfig.json --noEmit



### npm run build
status: ok

> career-firm@1.0.0 build
> tsc -p tsconfig.json



### npm run test
status: ok

> career-firm@1.0.0 test
> vitest run


 RUN  v3.2.7 /Users/levg/Workspace/career-firm

 ✓ tests/agents_md.test.ts (6 tests) 9ms
 ✓ tests/models.test.ts (3 tests) 7ms
 ✓ tests/agent_runtime.test.ts (5 tests) 64ms
 ✓ tests/heuristics.test.ts (7 tests) 41ms
 ✓ tests/db.test.ts (2 tests) 332ms
   ✓ repository > round-trips every durable record  313ms
 ✓ tests/setup.test.ts (10 tests) 314ms
 ✓ tests/documents.test.ts (3 tests) 634ms
   ✓ documents > renders matching PDF and DOCX files  487ms
 ✓ tests/firm_pipeline.test.ts (3 tests) 686ms
   ✓ firm pipeline > runs import → analyse → write → render end to end  513ms
 ✓ tests/api.test.ts (4 tests) 477ms
   ✓ web app > imports a CV and tailors a job through uploads  325ms

 Test Files  9 passed (9)
      Tests  43 passed (43)
   Start at  15:40:00
   Duration  2.33s (transform 816ms, setup 0ms, collect 8.51s, tests 2.57s, environment 1ms, prepare 695ms)

