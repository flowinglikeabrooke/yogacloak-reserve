import { spawnSync } from 'node:child_process';

const checks = [
  ['scripts/api-dispatcher-check.js'],
  ['scripts/api-dispatcher-smoke-check.js'],
  ['scripts/final-balance-readiness-check.js'],
  ['scripts/final-balance-workflow-check.js'],
  ['scripts/final-balance-runbook-check.js'],
  ['scripts/private-crm-workflow-check.js'],
  ['scripts/security-check.js']
];

for (const [script] of checks) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('Predeploy check passed.');
