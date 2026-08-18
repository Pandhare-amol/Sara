// Test: Verify tamper detection
"use strict";
const { verifyManifest, computeHmac, loadOrCreateKey } = require('../scripts/sign-manifest.cjs');
const path = require('path');
const fs = require('fs');
const root = process.cwd();
const manifestPath = path.join(root, 'data', 'security', 'integrity-manifest.json');

// Test 1: valid manifest — should pass
const r1 = verifyManifest(manifestPath, root);
console.log('[TEST 1] Valid manifest verified:', r1.ok, '|', r1.reason);
if (!r1.ok) { console.error('FAIL: Valid manifest should pass'); process.exit(1); }

// Test 2: tamper the manifest JSON — change a file hash and keep original signature
// The HMAC should now NOT match because the body changed but signature didn't
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tempPath = path.join(root, 'data', 'security', '_tampered.json');
// Keep original signature but alter the body
const originalSig = manifest.signature;
manifest.files[0].hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// Write back with the ORIGINAL (now invalid) signature
fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));

const r2 = verifyManifest(tempPath, root);
console.log('[TEST 2] Tampered body with stale signature detected:', !r2.ok, '|', r2.reason);
if (r2.ok) { console.error('FAIL: Tampered manifest should fail'); fs.unlinkSync(tempPath); process.exit(1); }
fs.unlinkSync(tempPath);

// Test 3: no manifest file
const r3 = verifyManifest('/nonexistent/path.json', root);
console.log('[TEST 3] Missing manifest handled:', !r3.ok, '|', r3.reason);

console.log('\n[PASS] All tamper detection tests passed!');
