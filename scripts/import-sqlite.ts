import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { root } from '../backend/src/config/environment';
import { modelNames } from '../backend/src/repositories/clinic.repository';
import { importIntoEmptyDatabase, exportSnapshot, snapshotOrder, type ClinicSnapshot } from '../backend/src/repositories/snapshot.repository';
import { disconnectDatabase } from '../backend/src/config/prisma';
const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
try {
  const folder = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const files = readdirSync(folder).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (!argument('--source') && files.length !== 1) throw new Error('Select exactly one source database.');
  const schema = readFileSync(path.join(root, 'backend/prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)].map(m => ({ name: m[1], dbName: m[2].match(/@@map\("([^"]+)"\)/)?.[1], fields: m[2].split('\n').map(line => { const field = line.trim().match(/^(\w+)\s+(\w+)(?:\?|\[\])?/); return field ? { name: field[1], type: field[2], dbName: line.match(/@map\("([^"]+)"\)/)?.[1] } : null; }).filter((f): f is { name: string; type: string; dbName: string | undefined } => !!f && ['String', 'Int', 'BigInt', 'Boolean', 'Json'].includes(f.type)) }));
  const source = path.resolve(argument('--source') || path.join(folder, files[0]));
  const sqlite = new DatabaseSync(source, { readOnly: true });
  const tables: Record<string, any[]> = {};
  try {
    for (const name of snapshotOrder) {
      const model = models.find(m => m.name[0].toLowerCase() + m.name.slice(1) === modelNames[name])!;
      const fields = model.fields;
      const table = model.dbName || model.name;
      const rows = sqlite.prepare('SELECT * FROM "' + table + '"').all();
      tables[name] = rows.map(row => Object.fromEntries(fields.map(field => {
        let value: any = row[field.dbName || field.name];
        if (field.type === 'Json' && typeof value === 'string') value = JSON.parse(value);
        if (field.type === 'Boolean') value = !!value;
        if (field.type === 'BigInt') { if (!Number.isSafeInteger(Number(value))) throw new Error('A money value exceeds the supported exact range.'); value = Number(value); }
        return [field.name, value];
      })));
    }
  } finally { sqlite.close(); }
  const snapshot: ClinicSnapshot = { format: 'care-record-postgresql-v1', createdAt: new Date().toISOString(), tables };
  const counts = await importIntoEmptyDatabase(snapshot);
  const restored = await exportSnapshot();
  const key = (name: string) => name === 'appSettings' ? 'key' : name === 'staffSessions' ? 'tokenHash' : name === 'visitWorkflow' ? 'visitId' : 'id';
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  for (const name of snapshotOrder) {
    const order = (a: any, b: any) => String(a[key(name)]).localeCompare(String(b[key(name)]));
    if (JSON.stringify(canonical([...tables[name]].sort(order))) !== JSON.stringify(canonical([...restored.tables[name]].sort(order)))) throw new Error('Imported records did not match the source.');
  }
  const output = path.resolve(root, '../care-record-archive-20261102/stack-migration-audit'); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'neon-import-verification.json'), JSON.stringify({ sourceRetained: true, importedIntoEmptyTarget: true, allFieldsVerified: true, counts }, null, 2));
  console.log(JSON.stringify({ imported: true, allFieldsVerified: true, counts }));
} catch (error) { const code = (error as any)?.code; console.error(code ? 'Clinic import failed (' + code + '). No connection values were logged.' : error instanceof Error && /target clinic database is not empty|Imported records did not match|supported exact range|Select exactly one/.test(error.message) ? error.message : 'Clinic import failed. Check the private database configuration.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
