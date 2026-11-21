#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoDir = path.resolve(process.argv[2] || process.cwd());
const manifestPath = path.join(repoDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Missing manifest.json in ${repoDir}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (!manifest.name || manifest.name.length > 45) errors.push("name missing or > 45 chars");
if (!manifest.description || manifest.description.length > 132) errors.push(`description missing or > 132 chars (${manifest.description?.length})`);
if (!manifest.version) errors.push("version missing");

// Check icons
for (const [sz, rel] of Object.entries(manifest.icons || {})) {
  const full = path.join(repoDir, rel);
  if (!fs.existsSync(full)) errors.push(`Missing icon ${sz}: ${rel}`);
}

// Check forbidden permissions
const perms = manifest.permissions || [];
if (perms.includes("debugger")) errors.push("Forbidden heavyweight permission: debugger");

// Walk extension source files (excluding dist, .git, tests, server, store-assets, node_modules)
const skipDirs = new Set([".git", "dist", "tests", "server", "store-assets", "node_modules"]);
const extFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else extFiles.push(full);
  }
}
walk(repoDir);

let totalExtBytes = 0;
let foundStripeLink = false;
for (const file of extFiles) {
  const rel = path.relative(repoDir, file);
  if (rel === "README.md" || rel === "LICENSE" || rel === ".gitignore") continue;
  totalExtBytes += fs.statSync(file).size;

  if (file.endsWith(".js")) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      errors.push(`JS syntax error in ${rel}: ${e.stderr?.toString() || e.message}`);
    }
    const content = fs.readFileSync(file, "utf8");
    if (content.includes("https://buy.stripe.com/")) foundStripeLink = true;
    if (/\beval\s*\(/.test(content)) errors.push(`Disallowed eval() in ${rel}`);
  }

  if (file.endsWith(".html")) {
    const html = fs.readFileSync(file, "utf8");
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      errors.push(`MV3 CSP violation: inline <script> found in ${rel}`);
    }
    if (/\son[a-z]+\s*=/i.test(html)) {
      errors.push(`MV3 CSP violation: inline event handler found in ${rel}`);
    }
  }
}

if (!foundStripeLink) errors.push("No live https://buy.stripe.com/ payment link found in extension JS!");

if (errors.length > 0) {
  console.error(`FAIL ${path.basename(repoDir)}:\n - ${errors.join("\n - ")}`);
  process.exit(1);
}

// Package Chrome Web Store zip cleanly
const distDir = path.join(repoDir, "dist");
fs.mkdirSync(distDir, { recursive: true });
const zipName = `${path.basename(repoDir)}-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const packItems = fs.readdirSync(repoDir).filter(name =>
  !skipDirs.has(name) && !["README.md", "LICENSE", ".gitignore", ".DS_Store"].includes(name)
);
execFileSync("zip", ["-rq", zipPath, ...packItems], { cwd: repoDir });

const zipBytes = fs.statSync(zipPath).size;
console.log(`PASS ${path.basename(repoDir)} v${manifest.version} | ${(totalExtBytes / 1024).toFixed(1)}KB unpacked | ${(zipBytes / 1024).toFixed(1)}KB zip | perms=[${perms.join(",")}]`);
