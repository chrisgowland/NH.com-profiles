#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.resolve(process.cwd(), "consultant-review");
const DATA_PATH = path.join(OUTPUT_DIR, "data.json");
const BOOKING_PATH = path.join(OUTPUT_DIR, "booking-report.csv");
const HISTORY_DIR = path.join(OUTPUT_DIR, "history");

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }
}

function safeStamp(iso) {
  return iso.replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function main() {
  ensureFile(DATA_PATH);
  ensureFile(BOOKING_PATH);

  const payload = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const sourceGeneratedAt = payload.summary && payload.summary.generatedAt
    ? payload.summary.generatedAt
    : new Date().toISOString();
  const runIso = new Date(sourceGeneratedAt).toISOString();
  const stamp = safeStamp(runIso);
  const datePart = stamp.slice(0, 10);

  const bookingSnapshotName = `booking-report-${stamp}.csv`;
  const summarySnapshotName = `summary-${stamp}.json`;
  const targetDir = path.join(HISTORY_DIR, datePart);
  const bookingSnapshotPath = path.join(targetDir, bookingSnapshotName);
  const summarySnapshotPath = path.join(targetDir, summarySnapshotName);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(BOOKING_PATH, bookingSnapshotPath);

  const summary = payload.summary || {};
  const totalIncluded = Number(summary.totalIncluded || 0);
  const overallPassCount = Number(summary.overallPassCount || 0);
  const overallFailCount = Math.max(0, totalIncluded - overallPassCount);

  const snapshot = {
    snapshotCreatedAt: new Date().toISOString(),
    sourceGeneratedAt: runIso,
    totals: {
      included: totalIncluded,
      excluded: Number(summary.totalExcluded || 0),
      passCount: overallPassCount,
      failCount: overallFailCount,
      passRate: summary.overallPassRate || "0.0%",
    },
    criteriaRates: summary.criteriaRates || {},
    bookingRates: summary.bookingRates || {},
    files: {
      bookingCsv: path.relative(OUTPUT_DIR, bookingSnapshotPath).replace(/\\/g, "/"),
    },
  };

  fs.writeFileSync(summarySnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Snapshot saved: ${path.relative(process.cwd(), summarySnapshotPath)}`);
  console.log(`Booking snapshot: ${path.relative(process.cwd(), bookingSnapshotPath)}`);
}

main();
