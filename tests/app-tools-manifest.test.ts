import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('app tool manifest has unique routes and includes guarded backlog tools',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../bittrees.tools.json',import.meta.url),'utf8'));
 const routes=manifest.connections.map((c:any)=>`${c.transport}:${c.endpoint}`);
 assert.equal(new Set(routes).size,routes.length);
 const source=manifest.connections.find((c:any)=>c.transport==='mcp'&&c.endpoint==='https://crm.bittrees.org/api/integrations/datasets/mcp');
 assert.ok(source.operations.read.includes('tasks.import_source_status'));
 assert.ok(source.operations.sync.includes('tasks.import_source'));
 assert.match(source.boundary,/Dataset and current project grants required/);
 assert.match(source.boundary,/separately approved per-project source-site mapping/);
});
