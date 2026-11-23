#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXPECTED_LOCALES = [
  "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el",
  "en", "en_AU", "en_GB", "en_US", "es", "es_419", "et",
  "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu",
  "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr",
  "ms", "nl", "no", "pl", "pt", "pt_BR", "pt_PT", "ro",
  "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th",
  "tr", "uk", "vi", "zh_CN", "zh_TW",
];

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
if (manifest.default_locale !== "en") errors.push("default_locale must be 'en'");
if (!String(manifest.name).startsWith("__MSG_") || !String(manifest.description).startsWith("__MSG_")) {
  errors.push("manifest.name and manifest.description must reference __MSG_*__ placeholders");
}

// Check _locales
const localesRoot = path.join(repoDir, "_locales");
if (!fs.existsSync(localesRoot)) {
  errors.push("Missing _locales directory");
} else {
  for (const loc of EXPECTED_LOCALES) {
    const msgFile = path.join(localesRoot, loc, "messages.json");
    if (!fs.existsSync(msgFile)) {
      errors.push(`Missing locale file _locales/${loc}/messages.json`);
      continue;
    }
    try {
      const msgs = JSON.parse(fs.readFileSync(msgFile, "utf8"));
      const appName = msgs?.appName?.message || "";
      const appShortName = msgs?.appShortName?.message || "";
      const appDescription = msgs?.appDescription?.message || "";
      if (!appName || appName.length > 45) errors.push(`_locales/${loc}: appName invalid/len=${appName.length}`);
      if (!appShortName || appShortName.length > 12) errors.push(`_locales/${loc}: appShortName invalid/len=${appShortName.length}`);
      if (!appDescription || appDescription.length > 132) errors.push(`_locales/${loc}: appDescription invalid/len=${appDescription.length}`);
    } catch (e) {
      errors.push(`_locales/${loc}/messages.json invalid JSON: ${e.message}`);
    }
  }
}

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
for (const oldZip of fs.readdirSync(distDir)) {
  if (oldZip.endsWith(".zip")) fs.unlinkSync(path.join(distDir, oldZip));
}
const zipName = `${path.basename(repoDir)}-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

const packItems = fs.readdirSync(repoDir).filter(name =>
  !skipDirs.has(name) && !["README.md", "LICENSE", ".gitignore", ".DS_Store"].includes(name)
);
execFileSync("zip", ["-rq", zipPath, ...packItems], { cwd: repoDir });

const zipBytes = fs.statSync(zipPath).size;
console.log(`PASS ${path.basename(repoDir)} v${manifest.version} | ${EXPECTED_LOCALES.length} locales | ${(totalExtBytes / 1024).toFixed(1)}KB unpacked | ${(zipBytes / 1024).toFixed(1)}KB zip | perms=[${perms.join(",")}]`);
