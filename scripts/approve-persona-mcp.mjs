#!/usr/bin/env node
// Explicit, machine-local approval of a reviewed persona MCP declaration.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [name,action]=process.argv.slice(2);
if(!name || ['.','..'].includes(name) || /[/\\\0]/.test(name) || !['--inspect','--approve','--revoke'].includes(action)) {
  console.error('Usage: node scripts/approve-persona-mcp.mjs <persona> --inspect|--approve|--revoke');process.exit(1);
}
const file=path.join(root,'data/personas',name,'runtime-mcp.json');
const raw=fs.readFileSync(file);
const hash=createHash('sha256').update(raw).digest('hex');
const trustPath=path.join(root,'data/mcp-trust.json');
const previous=fs.existsSync(trustPath) ? fs.readFileSync(trustPath) : Buffer.alloc(0);
const trust=previous.length ? JSON.parse(previous.toString('utf8').replace(/^\uFEFF/,'')) : {};
if(!trust || typeof trust!=='object' || Array.isArray(trust)) throw new Error('Invalid trust store: not overwriting');
if(action==='--inspect') {
  console.log(JSON.stringify({persona:name,hash,approved:Object.hasOwn(trust,name)&&trust[name]===hash,manifest:JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''))},null,2));
} else {
  if(action==='--approve') Object.defineProperty(trust,name,{value:hash,enumerable:true,configurable:true,writable:true}); else delete trust[name];
  const bom=previous.subarray(0,3).equals(Buffer.from([239,187,191]));
  const next=Buffer.from(`${bom?'\uFEFF':''}${JSON.stringify(trust,null,2)}\n`,'utf8');
  const temp=`${trustPath}.${process.pid}.tmp`;fs.writeFileSync(temp,next);fs.renameSync(temp,trustPath);
  console.log(`${name}: ${action==='--approve'?'approved':'revoked'} (${hash})`);
}
