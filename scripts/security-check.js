import fs from 'fs';
import path from 'path';

const root = process.cwd();
const publicExtensions = new Set(['.html', '.js', '.css']);
const excludedDirs = new Set(['api', 'lib', 'private', 'scripts', '.git', 'node_modules']);
const publicHtml = [];
const publicFiles = [];
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludedDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!publicExtensions.has(ext)) continue;
    publicFiles.push(fullPath);
    if (ext === '.html') publicHtml.push(fullPath);
  }
}

function rel(file) {
  return path.relative(root, file);
}

function fail(message) {
  failures.push(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

walk(root);

const secretPatterns = [
  /sk_live_[A-Za-z0-9_]+/g,
  /sk_test_[A-Za-z0-9_]+/g,
  /rk_live_[A-Za-z0-9_]+/g,
  /whsec_[A-Za-z0-9_]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /SUPABASE_SERVICE_ROLE_KEY/g,
  /STRIPE_SECRET_KEY/g,
  /RESERVE_STRIPE_SECRET_KEY/g,
  /TWILIO_AUTH_TOKEN/g,
  /AIRTABLE_PAT/g,
  /ADMIN_TOKEN/g,
  /FINAL_CHARGE_ADMIN_TOKEN/g
];

for (const file of publicFiles) {
  const text = read(file);
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) fail(`${rel(file)} contains a secret-looking value or private env name: ${pattern}`);
    pattern.lastIndex = 0;
  }
}

for (const file of publicHtml) {
  const text = read(file);
  if (/yogacloak-admin\.html|\/api\/admin-page|private\/admin-hub/i.test(text)) {
    fail(`${rel(file)} appears to link or refer to the private admin area.`);
  }
  const mainCount = (text.match(/<main\b/gi) || []).length;
  if (mainCount !== 1) fail(`${rel(file)} should have exactly one <main> landmark, found ${mainCount}.`);
  const imgTags = text.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    if (!/\salt\s*=/i.test(tag)) fail(`${rel(file)} has an <img> without alt text: ${tag.slice(0, 120)}`);
  }
}

const vercelPath = path.join(root, 'vercel.json');
if (!fs.existsSync(vercelPath)) {
  fail('vercel.json is missing.');
} else {
  const vercel = JSON.parse(read(vercelPath));
  const rewrites = JSON.stringify(vercel.rewrites || []);
  const headers = JSON.stringify(vercel.headers || []);
  if (!rewrites.includes('/yogacloak-admin.html') || !rewrites.includes('/api/admin-page')) {
    fail('vercel.json must route /yogacloak-admin.html through /api/admin-page.');
  }
  if (!headers.includes('X-Robots-Tag') || !headers.includes('noindex') || !headers.includes('Cache-Control') || !headers.includes('no-store')) {
    fail('vercel.json is missing no-store/noindex headers for protected routes.');
  }
}

if (!fs.existsSync(path.join(root, 'supabase-rls.sql'))) {
  fail('supabase-rls.sql is missing.');
}

if (failures.length) {
  console.error('Security check failed:');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log(`Security check passed. Scanned ${publicFiles.length} public files and ${publicHtml.length} HTML pages.`);
