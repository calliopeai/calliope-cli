/** A packaged public-interface fixture; emitting this data never writes or executes it. */
export function migrationExample() {
  const source = `let values;
try { values = JSON.parse(process.argv[2]); }
catch { process.stderr.write('Invalid JSON.\\n'); process.exit(2); }
if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value))) {
  process.stderr.write('Expected an array of safe integers.\\n'); process.exit(2);
}
process.stdout.write(JSON.stringify({ sum: values.reduce((total, value) => total + value, 0), count: values.length }) + '\\n');
`;
  const target = source.replace('let values;', 'let values: unknown;').replace('values.reduce(', '(values as number[]).reduce(');
  return {
    adapter: 'javascript-to-typescript-cli/v1', verifier: 'byte-parity-v1',
    files: { 'source.mjs': source, 'candidate.mts': target,
      'negative.mts': target.replace('total + value', 'total + value + 1'),
      'RULES.md': 'Preserve stdout bytes, stderr bytes and exit status for the declared CLI cases. Inputs are one JSON argument. Changing this contract requires independent review.\n' },
    cases: [
      { id: 'positive', argument: '[1,2,3]', expected: { exitCode: 0, stdout: '{"sum":6,"count":3}\n', stderr: '' } },
      { id: 'empty', argument: '[]', expected: { exitCode: 0, stdout: '{"sum":0,"count":0}\n', stderr: '' } },
      { id: 'negative-values', argument: '[-2,5]', expected: { exitCode: 0, stdout: '{"sum":3,"count":2}\n', stderr: '' } },
      { id: 'invalid-type', argument: '["1"]', expected: { exitCode: 2, stdout: '', stderr: 'Expected an array of safe integers.\n' } },
      { id: 'invalid-json', argument: 'not-json', expected: { exitCode: 2, stdout: '', stderr: 'Invalid JSON.\n' } },
    ],
    negativeControl: { caseId: 'positive', expected: { exitCode: 0, stdout: '{"sum":9,"count":3}\n', stderr: '' } },
    limits: { commandTimeoutMs: 10000, totalMs: 120000 },
  };
}
