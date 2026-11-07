import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, selectionPath, outputPath] = process.argv.slice(2);
if (!inputPath || !selectionPath || !outputPath || new Set([inputPath, selectionPath, outputPath]).size !== 3) {
  throw new Error('Usage: node scripts/prepare-unlimited-message-grants.mjs PRIVATE_CONFIG PRIVATE_SELECTIONS NEW_PRIVATE_CANDIDATE');
}
const config = JSON.parse(await readFile(inputPath, 'utf8'));
const selections = JSON.parse(await readFile(selectionPath, 'utf8'));
if (!Array.isArray(selections) || selections.length === 0 || !Array.isArray(config.sessionMessages?.grants)) {
  throw new Error('Selections and configured message grants are required');
}
const identity = value => JSON.stringify([value.projectId, value.sessionId, value.senderActorId]);
const requested = new Map();
for (const selection of selections) {
  if (typeof selection.projectId !== 'string' || typeof selection.sessionId !== 'string' ||
      typeof selection.senderActorId !== 'string' || typeof selection.receiverActorId !== 'string' ||
      typeof selection.receiverRoleId !== 'string' || typeof selection.cwd !== 'string' ||
      !Number.isSafeInteger(selection.expectedMaxTurns) ||
      selection.expectedMaxTurns < 1 || requested.has(identity(selection))) {
    throw new Error('Each selection needs one distinct exact grant and its expected positive limit');
  }
  requested.set(identity(selection), selection);
}
const matched = new Set();
for (const grant of config.sessionMessages.grants) {
  const key = identity(grant);
  if (!requested.has(key)) continue;
  const expected = requested.get(key);
  if (matched.has(key) || grant.enabled !== true || grant.maxTurns !== expected.expectedMaxTurns ||
      grant.receiverActorId !== expected.receiverActorId || grant.receiverRoleId !== expected.receiverRoleId ||
      grant.cwd !== expected.cwd) {
    throw new Error('Grant identity, enabled state, or expected limit changed; candidate was not written');
  }
  matched.add(key);
  delete grant.maxTurns;
}
if (matched.size !== requested.size) throw new Error('At least one exact grant is missing; candidate was not written');
await writeFile(outputPath, JSON.stringify(config, null, 2) + '\n', {flag:'wx',mode:0o600});
process.stdout.write(`Prepared ${matched.size} exact unlimited grants in a new private candidate.\n`);
