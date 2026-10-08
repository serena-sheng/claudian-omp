#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const manifestPath = path.join(__dirname, '..', 'manifest.json');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifestJson.version = packageJson.version;

fs.writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n');

// Obsidian resolves which plugin version a given app version may install from
// versions.json, so keep it in step with every release.
const versionsPath = path.join(__dirname, '..', 'versions.json');
let versions = {};
try {
  versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
} catch {
  versions = {};
}
versions[packageJson.version] = manifestJson.minAppVersion;
const ordered = Object.fromEntries(
  Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
);
fs.writeFileSync(versionsPath, JSON.stringify(ordered, null, 2) + '\n');

console.log(`Synced version to ${packageJson.version}`);
