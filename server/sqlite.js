// The one place `node:sqlite` is loaded (db.js, backup.js and everything that opens a database take DatabaseSync from here).
// node:sqlite prints an ExperimentalWarning the first time it is loaded; that one message is muted — and ONLY that one, and only while the
// import runs: process.emitWarning is put back exactly as it was found, so no other warning is ever swallowed.
// (The `export` comes first on purpose: a folder without package.json — the backup.cmd test "install" — still sees this file is an ES module.)
export let DatabaseSync;

const origEmit = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  const name = typeof warning === 'object' && warning ? warning.name : type;
  const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (name === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  return origEmit.call(process, warning, ...rest);
};
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} finally {
  process.emitWarning = origEmit;
}
