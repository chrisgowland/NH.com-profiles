#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE_URL = "https://www.nuffieldhealth.com";
const BOOKING_MICROSITE_URL = "https://nh-booking-microsite.nuffieldhealth.com";
const BOOKING_APIM_BASE_URL = "https://api.nuffieldhealth.com/booking/consultant/";
const LIST_PATH = "/consultants?size=n_5_n&sort-field=availabilityRank&sort-direction=availabilityRank";
const MAX_PAGES = 500;
const PROFILE_CONCURRENCY = 12;
const OUTPUT_DIR = path.resolve(process.cwd(), "consultant-review");

const EXCLUSION_PATTERN = /\b(radiolog(?:y|ist|ical)|anaesthe(?:tics?|tist|sia)|anesthe(?:tics?|tist|sia))\b/i;
const PLACEHOLDER_PHOTO_PATTERN = /\b(placeholder|default|avatar|blank|no[-_ ]?image)\b/i;

const CLINICAL_TERMS = [
  "surgery",
  "surgical",
  "procedure",
  "clinic",
  "diagnosis",
  "treatment",
  "consultation",
  "intervention",
  "laparoscopic",
  "arthroscopy",
  "endoscopy",
  "oncology",
  "cardiology",
  "orthopaedic",
  "orthopedic",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchText(url, retries = 3, headers = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      https
        .get(
          url,
          {
            headers: {
              "user-agent": "Mozilla/5.0 (compatible; NH-Consultant-Review/1.0)",
              accept: "text/html",
              ...headers,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", async () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(data);
                return;
              }
              if (remaining > 0) {
                await sleep(350);
                attempt(remaining - 1);
                return;
              }
              reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            });
          }
        )
        .on("error", async (err) => {
          if (remaining > 0) {
            await sleep(350);
            attempt(remaining - 1);
            return;
          }
          reject(err);
        });
    };
    attempt(retries);
  });
}

async function fetchJson(url, retries = 3, headers = {}) {
  const raw = await fetchText(url, retries, headers);
  return JSON.parse(raw);
}

function formatDateUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetweenUTC(startDateYmd, endDateYmd) {
  const start = new Date(`${startDateYmd}T00:00:00Z`);
  const end = new Date(`${endDateYmd}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([:@a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = m[2] != null ? m[2] : m[3];
  }
  return attrs;
}

function extractSwiftype(html) {
  const out = {};
  const re = /<meta\b[^>]*class="[^"]*swiftype[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttributes(m[0]);
    const key = attrs.name;
    if (!key) continue;
    if (!out[key]) out[key] = [];
    out[key].push(attrs.content || "");
  }
  return out;
}

function extractProfileLinks(listHtml) {
  const links = new Set();
  const re = /href=["']([^"']*\/consultants\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(listHtml)) !== null) {
    let href = m[1];
    if (!href.startsWith("/consultants/")) continue;
    href = href.split("?")[0].split("#")[0];
    links.add(href);
  }
  return [...links];
}

function extractAboutText(html) {
  const m = html.match(/id="consultant-profile"[\s\S]*?<div class="body-content">([\s\S]*?)<\/div>/i);
  if (!m) return "";
  return stripTags(m[1]);
}

function countSyllables(word) {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 0;
  if (clean.length <= 3) return 1;
  const vowelGroups = clean.match(/[aeiouy]+/g);
  let count = vowelGroups ? vowelGroups.length : 1;
  if (clean.endsWith("e")) count -= 1;
  return Math.max(1, count);
}

function readingEase(text) {
  const words = (text.match(/[A-Za-z]+/g) || []).map((w) => w.toLowerCase());
  if (words.length === 0) return 0;
  const sentenceCount = Math.max(1, (text.match(/[.!?]+/g) || []).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wps = words.length / sentenceCount;
  const spw = syllables / words.length;
  return 206.835 - 1.015 * wps - 84.6 * spw;
}

function plainEnglishScore(aboutText) {
  if (!aboutText) return 0;
  const ease = readingEase(aboutText);
  const words = aboutText.match(/[A-Za-z]+/g) || [];
  const avgWordLength =
    words.length === 0 ? 0 : words.reduce((sum, w) => sum + w.length, 0) / words.length;
  const hasExplainer = /\b(also known as|which means|for example|such as|this helps|so that)\b/i.test(
    aboutText
  );

  let score = 0;
  if (ease >= 60) score += 3;
  else if (ease >= 45) score += 2;
  else if (ease >= 30) score += 1;

  if (avgWordLength > 0 && avgWordLength <= 5.8) score += 1;
  if (hasExplainer) score += 1;

  return Math.max(0, Math.min(5, score));
}

function containsClinicalTerms(text) {
  const hay = text.toLowerCase();
  return CLINICAL_TERMS.some((term) => hay.includes(term));
}

function parseImageOriginalUrl(imageMeta) {
  if (!imageMeta) return "";
  const m = imageMeta.match(/[?&]url=([^&]+)/i);
  if (!m) return imageMeta;
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return m[1];
  }
}

function parseHospitalIds(hospitalMetaValues) {
  if (!Array.isArray(hospitalMetaValues)) return [];
  const ids = [];
  for (const val of hospitalMetaValues) {
    if (!val || typeof val !== "string") continue;
    try {
      const parsed = JSON.parse(val);
      const id = parsed && parsed.id ? String(parsed.id).trim() : "";
      if (id) ids.push(id);
    } catch (_) {
      // Ignore malformed hospital metadata entries.
    }
  }
  return ids;
}

async function discoverApimSubscriptionKey() {
  const micrositeHtml = await fetchText(BOOKING_MICROSITE_URL);
  const scriptMatch = micrositeHtml.match(/<script[^>]+src="([^"]*\/static\/js\/main\.[^"]+\.js)"/i);
  if (!scriptMatch) return null;
  const scriptUrl = scriptMatch[1].startsWith("http")
    ? scriptMatch[1]
    : `${BOOKING_MICROSITE_URL}${scriptMatch[1]}`;
  const bundle = await fetchText(scriptUrl, 2);
  const keyMatch = bundle.match(/APIM_SUBSCRIPTION_KEY:"([a-z0-9]+)"/i);
  return keyMatch ? keyMatch[1] : null;
}

async function fetchBookingMetrics(gmcCode, hospitalId, fromDateYmd, apimKey) {
  if (!gmcCode || !hospitalId || !apimKey) return null;
  const query =
    `1.0/slots?uid=${encodeURIComponent(Date.now().toString(36))}` +
    `&fromDate=${encodeURIComponent(fromDateYmd)}` +
    `&gmcCode=${encodeURIComponent(gmcCode)}` +
    `&hospitalId=${encodeURIComponent(hospitalId)}` +
    `&sessionDays=28`;
  const url = `${BOOKING_APIM_BASE_URL}${query}`;
  const payload = await fetchJson(url, 2, {
    accept: "application/json",
    "content-type": "application/json",
    "ocp-apim-subscription-key": apimKey,
    "x-transaction-id": `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });

  const details =
    payload &&
    payload.response &&
    payload.response.responseData &&
    Array.isArray(payload.response.responseData.bookingDetails)
      ? payload.response.responseData.bookingDetails
      : [];

  const firstDate = details.length > 0 && details[0].slotDate ? String(details[0].slotDate) : null;
  return {
    appointmentsNext4Weeks: details.length,
    firstAvailableDaysAway: firstDate ? daysBetweenUTC(fromDateYmd, firstDate) : null,
  };
}

function boolBadge(value) {
  return value
    ? '<span class="badge badge-pass">Pass</span>'
    : '<span class="badge badge-fail">Fail</span>';
}

function pct(part, total) {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await iterator(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function discoverConsultantLinks() {
  const all = new Set();
  let page = 1;

  while (page <= MAX_PAGES) {
    const url =
      page === 1 ? `${BASE_URL}${LIST_PATH}` : `${BASE_URL}/consultants?page=${page}`;
    const html = await fetchText(url);
    const links = extractProfileLinks(html);
    if (links.length === 0) break;

    for (const link of links) all.add(link);

    const hasNext = /rel=['"]next['"]/i.test(html);
    if (!hasNext) break;
    page += 1;
  }

  return [...all].sort();
}

async function evaluateConsultant(urlPath, html, swiftype, bookingContext) {
  const name = (swiftype.fullname && swiftype.fullname[0]) || "";
  const specialties = swiftype.specialties || [];
  const treatments = swiftype.treatments || [];
  const insurers = swiftype.insurers || [];
  const qualifications = swiftype.professionalQualifications || [];
  const hospitals = swiftype.locations || [];
  const gmc = (swiftype.gmcNumber && swiftype.gmcNumber[0]) || "";
  const bookableMeta = ((swiftype.bookable && swiftype.bookable[0]) || "").toLowerCase() === "true";
  const upcomingAppointmentsRaw =
    (swiftype.upcomingAppointments && swiftype.upcomingAppointments[0]) || "";
  const daysUntilNextAppointmentRaw =
    (swiftype.daysUntilNextAppointment && swiftype.daysUntilNextAppointment[0]) || "";
  const upcomingAppointments = Number.parseInt(upcomingAppointmentsRaw, 10);
  const daysUntilNextAppointment = Number.parseInt(daysUntilNextAppointmentRaw, 10);
  const gmcCode = gmc.trim();
  const hospitalIds = parseHospitalIds(swiftype.hospitals || []);
  const imageMeta = (swiftype.image && swiftype.image[0]) || "";
  const sourceImage = parseImageOriginalUrl(imageMeta);
  const aboutText = extractAboutText(html);
  const aboutForTerms = [aboutText, ...treatments, ...specialties].join(" ").trim();

  const excluded = EXCLUSION_PATTERN.test(specialties.join(" "));
  const photoPass = !!sourceImage && !PLACEHOLDER_PHOTO_PATTERN.test(sourceImage);
  const clinicalTermsPass = containsClinicalTerms(aboutForTerms) || treatments.length > 0;
  const plainScore = plainEnglishScore(aboutText);
  const specialtyPass = specialties.length > 0;
  const proceduresPass = treatments.length > 0;
  const insurersPass = insurers.length > 0;
  const qualificationsPass = qualifications.length > 0;
  const gmcPass = gmc.trim().length > 0;
  const bookOnlinePass = bookableMeta || /href="#book"|Book online today|>\s*Book online\s*</i.test(html);

  const fixes = [];
  if (!photoPass) fixes.push("Add a high-quality consultant profile photo.");
  if (!clinicalTermsPass) fixes.push("Add clear clinical terminology describing conditions/treatments.");
  if (plainScore < 3) fixes.push("Rewrite About section in plainer patient-facing English.");
  if (!specialtyPass) fixes.push("Add specialty information.");
  if (!proceduresPass) fixes.push("Add specific procedures/treatments offered.");
  if (!insurersPass) fixes.push("Add insurers accepted.");
  if (!qualificationsPass) fixes.push("Add consultant qualifications.");
  if (!gmcPass) fixes.push("Add GMC number.");
  if (!bookOnlinePass) fixes.push("Add or fix Book online link.");

  const overallPass =
    photoPass &&
    clinicalTermsPass &&
    plainScore >= 3 &&
    specialtyPass &&
    proceduresPass &&
    insurersPass &&
    qualificationsPass &&
    gmcPass &&
    bookOnlinePass;

  let liveBooking = null;
  if (bookingContext && bookingContext.apimKey && gmcCode && hospitalIds.length > 0) {
    try {
      liveBooking = await fetchBookingMetrics(
        gmcCode,
        hospitalIds[0],
        bookingContext.fromDateYmd,
        bookingContext.apimKey
      );
    } catch (_) {
      liveBooking = null;
    }
  }

  const resolvedAppointmentsNext4Weeks =
    liveBooking && liveBooking.appointmentsNext4Weeks != null
      ? liveBooking.appointmentsNext4Weeks
      : Number.isNaN(upcomingAppointments)
        ? null
        : upcomingAppointments;
  const resolvedFirstAvailableDaysAway =
    liveBooking && liveBooking.firstAvailableDaysAway != null
      ? liveBooking.firstAvailableDaysAway
      : Number.isNaN(daysUntilNextAppointment)
        ? null
        : daysUntilNextAppointment;
  const normalizedFirstAvailableDaysAway =
    resolvedFirstAvailableDaysAway == null ? null : Math.max(0, resolvedFirstAvailableDaysAway);

  return {
    name,
    url: `${BASE_URL}${urlPath}`,
    specialties,
    hospitals,
    treatments,
    insurers,
    qualifications,
    gmcNumber: gmc,
    aboutText,
    criteria: {
      photoPass,
      clinicalTermsPass,
      plainEnglishScore: plainScore,
      specialtyPass,
      proceduresPass,
      insurersPass,
      qualificationsPass,
      gmcPass,
      bookOnlinePass,
    },
    booking: {
      bookable: bookableMeta || bookOnlinePass,
      appointmentsNext4Weeks: resolvedAppointmentsNext4Weeks,
      firstAvailableDaysAway: normalizedFirstAvailableDaysAway,
    },
    overallPass,
    fixes,
    excluded,
  };
}

function createSummary(records, excludedCount) {
  const total = records.length;
  const passedOverall = records.filter((r) => r.overallPass).length;
  const noAppointmentsNext5Days = records.filter((r) => {
    if (!r.booking || r.booking.firstAvailableDaysAway == null) return true;
    return r.booking.firstAvailableDaysAway > 5;
  }).length;
  const lessThan12In4Weeks = records.filter((r) => {
    if (!r.booking || r.booking.appointmentsNext4Weeks == null) return true;
    return r.booking.appointmentsNext4Weeks < 12;
  }).length;
  const c = {
    photoPass: records.filter((r) => r.criteria.photoPass).length,
    clinicalTermsPass: records.filter((r) => r.criteria.clinicalTermsPass).length,
    specialtyPass: records.filter((r) => r.criteria.specialtyPass).length,
    proceduresPass: records.filter((r) => r.criteria.proceduresPass).length,
    insurersPass: records.filter((r) => r.criteria.insurersPass).length,
    qualificationsPass: records.filter((r) => r.criteria.qualificationsPass).length,
    gmcPass: records.filter((r) => r.criteria.gmcPass).length,
    bookOnlinePass: records.filter((r) => r.criteria.bookOnlinePass).length,
  };
  const avgPlain =
    total === 0
      ? 0
      : records.reduce((sum, r) => sum + r.criteria.plainEnglishScore, 0) / total;

  return {
    totalIncluded: total,
    totalExcluded: excludedCount,
    overallPassCount: passedOverall,
    overallPassRate: pct(passedOverall, total),
    avgPlainEnglishScore: Number(avgPlain.toFixed(2)),
    criteriaCounts: c,
    criteriaRates: {
      photoPass: pct(c.photoPass, total),
      clinicalTermsPass: pct(c.clinicalTermsPass, total),
      specialtyPass: pct(c.specialtyPass, total),
      proceduresPass: pct(c.proceduresPass, total),
      insurersPass: pct(c.insurersPass, total),
      qualificationsPass: pct(c.qualificationsPass, total),
      gmcPass: pct(c.gmcPass, total),
      bookOnlinePass: pct(c.bookOnlinePass, total),
    },
    bookingRates: {
      noAppointmentsNext5DaysCount: noAppointmentsNext5Days,
      noAppointmentsNext5DaysRate: pct(noAppointmentsNext5Days, total),
      lessThan12In4WeeksCount: lessThan12In4Weeks,
      lessThan12In4WeeksRate: pct(lessThan12In4Weeks, total),
    },
    generatedAt: new Date().toISOString(),
  };
}

function uniqueSortedValues(records, key) {
  const s = new Set();
  for (const r of records) {
    for (const val of r[key]) {
      if (val && val.trim()) s.add(val.trim());
    }
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(payload) {
  const specialties = uniqueSortedValues(payload.records, "specialties");
  const hospitals = uniqueSortedValues(payload.records, "hospitals");

  const specialtyOptions = specialties
    .map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`)
    .join("");
  const hospitalOptions = hospitals
    .map((h) => `<option value="${escHtml(h)}">${escHtml(h)}</option>`)
    .join("");

  const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nuffield Health Consultant Profile Review</title>
  <style>
    :root {
      --nh-green: #0f6f57;
      --nh-green-dark: #0a4f3e;
      --nh-mint: #dff4ec;
      --nh-ink: #14312a;
      --nh-grey: #eef3f1;
      --pass: #0f6f57;
      --fail: #b00020;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--nh-ink);
      background: linear-gradient(160deg, #f7fbf9 0%, #e8f5ef 100%);
      font-family: "Poppins", "Segoe UI", Arial, sans-serif;
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .hero {
      background: linear-gradient(135deg, var(--nh-green-dark), var(--nh-green));
      color: white;
      padding: 24px;
      border-radius: 16px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.12);
    }
    .hero h1 { margin: 0 0 8px 0; font-size: 1.8rem; }
    .hero p { margin: 0; opacity: 0.95; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 16px 0 24px;
    }
    .card {
      background: white;
      border: 1px solid #d5e3de;
      border-radius: 12px;
      padding: 14px;
    }
    .card .label { font-size: 0.82rem; color: #49635a; margin-bottom: 6px; }
    .card .value { font-size: 1.35rem; font-weight: 700; color: var(--nh-green-dark); }
    .filters {
      display: grid;
      gap: 10px;
      grid-template-columns: 1.2fr 1fr 1fr 0.7fr 1fr 1fr;
      margin-bottom: 14px;
    }
    .filter-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .action-btn {
      border: 1px solid #b9d2c8;
      background: #ffffff;
      color: #184236;
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 0.9rem;
      cursor: pointer;
    }
    .action-btn.primary {
      background: #0f6f57;
      color: #fff;
      border-color: #0f6f57;
    }
    @media (max-width: 960px) {
      .filters { grid-template-columns: 1fr; }
    }
    .input, select {
      width: 100%;
      border: 1px solid #c7d9d2;
      background: white;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 0.95rem;
    }
    .desktop-table {
      position: relative;
      background: white;
      border-radius: 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.06);
      border: 1px solid #d9e6e1;
    }
    .table-scroll {
      overflow: auto;
      max-height: 70vh;
      border-radius: 12px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      background: white;
    }
    thead { position: sticky; top: 0; z-index: 4; }
    thead th {
      position: sticky;
      top: 0;
      background: #e7f3ee;
      color: #174237;
      text-align: left;
      font-size: 0.8rem;
      letter-spacing: 0.02em;
      padding: 10px;
      border-bottom: 1px solid #cde0d9;
      z-index: 5;
      box-shadow: inset 0 -1px 0 #cde0d9;
    }
    tbody td {
      font-size: 0.88rem;
      vertical-align: top;
      padding: 10px;
      border-bottom: 1px solid #edf3f0;
    }
    tbody tr:hover { background: #f7fcfa; }
    .badge {
      display: inline-block;
      min-width: 46px;
      text-align: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-pass { background: #e2f7ef; color: var(--pass); }
    .badge-fail { background: #ffe7eb; color: var(--fail); }
    .badge-rag-green { background: #dff4ec; color: #0f6f57; }
    .badge-rag-amber { background: #fff1d6; color: #8a5a00; }
    .badge-rag-red { background: #ffe7eb; color: #b00020; }
    .link { color: var(--nh-green-dark); text-decoration: none; font-weight: 600; }
    .muted { color: #5f7a70; }
    .fixes { margin: 0; padding-left: 16px; }
    .footer { margin-top: 14px; color: #486258; font-size: 0.82rem; }
    .mobile-list { display: none; }
    .mobile-card {
      background: white;
      border: 1px solid #d5e3de;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .mobile-card h3 { margin: 0 0 6px 0; font-size: 1rem; }
    .mobile-meta { font-size: 0.84rem; margin: 2px 0; color: #34564b; }
    .mobile-fixes { margin: 8px 0 0 16px; }
    .section-title { margin: 20px 0 10px 0; color: var(--nh-green-dark); }
    @media (max-width: 840px) {
      .desktop-table { display: none; }
      .mobile-list { display: block; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>Nuffield Health Consultant Profile Review</h1>
      <p>Scope: all consultants on Nuffield Health profile listings, excluding radiology and anaesthetics profiles.</p>
      <p class="muted">Generated: ${escHtml(payload.summary.generatedAt)}</p>
    </section>

    <section class="cards">
      <article class="card"><div class="label">Profiles Reviewed</div><div class="value">${payload.summary.totalIncluded}</div></article>
      <article class="card"><div class="label">Profiles Excluded</div><div class="value">${payload.summary.totalExcluded}</div></article>
      <article class="card"><div class="label">Overall Pass Rate</div><div class="value">${payload.summary.overallPassRate}</div></article>
      <article class="card"><div class="label">Photo Quality Pass</div><div class="value">${payload.summary.criteriaRates.photoPass}</div></article>
      <article class="card"><div class="label">Clinical Terms Pass</div><div class="value">${payload.summary.criteriaRates.clinicalTermsPass}</div></article>
      <article class="card"><div class="label">Specialty Pass</div><div class="value">${payload.summary.criteriaRates.specialtyPass}</div></article>
      <article class="card"><div class="label">Procedures Pass</div><div class="value">${payload.summary.criteriaRates.proceduresPass}</div></article>
      <article class="card"><div class="label">Insurers Pass</div><div class="value">${payload.summary.criteriaRates.insurersPass}</div></article>
      <article class="card"><div class="label">Qualifications Pass</div><div class="value">${payload.summary.criteriaRates.qualificationsPass}</div></article>
      <article class="card"><div class="label">GMC Number Pass</div><div class="value">${payload.summary.criteriaRates.gmcPass}</div></article>
      <article class="card"><div class="label">Book Online Pass</div><div class="value">${payload.summary.criteriaRates.bookOnlinePass}</div></article>
      <article class="card"><div class="label">Avg Plain English Score</div><div class="value">${payload.summary.avgPlainEnglishScore}/5</div></article>
      <article class="card"><div class="label">No Appointments in Next 5 Days</div><div class="value">${payload.summary.bookingRates.noAppointmentsNext5DaysRate}</div></article>
      <article class="card"><div class="label">Less Than 12 Appointments (4 Weeks)</div><div class="value">${payload.summary.bookingRates.lessThan12In4WeeksRate}</div></article>
    </section>

    <section class="filters">
      <input id="searchInput" class="input" placeholder="Search consultant, specialty, hospital...">
      <select id="specialtyFilter"><option value="">All specialties</option>${specialtyOptions}</select>
      <select id="hospitalFilter"><option value="">All hospitals</option>${hospitalOptions}</select>
      <select id="overallFilter">
        <option value="">All results</option>
        <option value="pass">Overall pass</option>
        <option value="fail">Overall fail</option>
      </select>
      <select id="next5DaysFilter">
        <option value="">No appts next 5 days: All</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      <select id="lt12Filter">
        <option value="">Under 12 appts (4w): All</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </section>
    <section class="filter-actions">
      <button id="highRiskPreset" class="action-btn primary" type="button">Show High-Risk Access Consultants</button>
      <button id="clearPreset" class="action-btn" type="button">Clear Preset</button>
    </section>

    <h2 class="section-title">Consultant Review</h2>
    <div class="desktop-table">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Consultant</th>
              <th>Specialty</th>
              <th>Hospital</th>
              <th>Overall</th>
              <th>Able to Book</th>
              <th>Appointments in Next 4 Weeks</th>
              <th>First Available (Days Away)</th>
              <th>Photo</th>
              <th>Clinical Terms</th>
              <th>Plain English</th>
              <th>Specialty</th>
              <th>Procedures</th>
              <th>Insurers</th>
              <th>Qualifications</th>
              <th>GMC</th>
              <th>Book Online</th>
              <th>Fixes Required</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
    <div id="mobileRows" class="mobile-list"></div>

    <div class="footer">
      Plain English is scored 0-5 using a readability heuristic (Flesch-style readability, average word length, and explainer phrases). Validate borderline results with editorial review.
    </div>
  </div>

  <script>
    const REVIEW_DATA = ${dataJson};
    const rowsEl = document.getElementById("rows");
    const mobileRowsEl = document.getElementById("mobileRows");
    const searchInput = document.getElementById("searchInput");
    const specialtyFilter = document.getElementById("specialtyFilter");
    const hospitalFilter = document.getElementById("hospitalFilter");
    const overallFilter = document.getElementById("overallFilter");
    const next5DaysFilter = document.getElementById("next5DaysFilter");
    const lt12Filter = document.getElementById("lt12Filter");
    const highRiskPreset = document.getElementById("highRiskPreset");
    const clearPreset = document.getElementById("clearPreset");

    function badge(pass) {
      return pass
        ? '<span class="badge badge-pass">Pass</span>'
        : '<span class="badge badge-fail">Fail</span>';
    }

    function bookingRagBadge(r) {
      if (!r.booking || r.booking.bookable == null) {
        return '<span class="badge badge-rag-amber">Amber</span>';
      }
      if (r.booking.bookable) {
        return '<span class="badge badge-rag-green">Green</span>';
      }
      return '<span class="badge badge-rag-red">Red</span>';
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderTable(records) {
      rowsEl.innerHTML = records.map((r) => {
        const specialty = r.specialties.join(", ");
        const hospital = r.hospitals.join(", ");
        const appointments = !r.booking || r.booking.appointmentsNext4Weeks == null ? "N/A" : String(r.booking.appointmentsNext4Weeks);
        const first = !r.booking || r.booking.firstAvailableDaysAway == null ? "N/A" : String(r.booking.firstAvailableDaysAway);
        const ableToBook = !r.booking || r.booking.bookable == null ? "Unknown" : (r.booking.bookable ? "Yes" : "No");
        const ableToBookRag = bookingRagBadge(r);
        const fixes = r.fixes.length ? '<ul class="fixes">' + r.fixes.map(f => '<li>' + esc(f) + '</li>').join("") + '</ul>' : '<span class="muted">None</span>';
        return '<tr>' +
          '<td><a class="link" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name || r.url) + '</a></td>' +
          '<td>' + esc(specialty) + '</td>' +
          '<td>' + esc(hospital) + '</td>' +
          '<td>' + badge(r.overallPass) + '</td>' +
          '<td>' + ableToBookRag + ' <span class="muted">' + esc(ableToBook) + '</span></td>' +
          '<td>' + esc(appointments) + '</td>' +
          '<td>' + esc(first) + '</td>' +
          '<td>' + badge(r.criteria.photoPass) + '</td>' +
          '<td>' + badge(r.criteria.clinicalTermsPass) + '</td>' +
          '<td>' + esc(String(r.criteria.plainEnglishScore)) + '/5</td>' +
          '<td>' + badge(r.criteria.specialtyPass) + '</td>' +
          '<td>' + badge(r.criteria.proceduresPass) + '</td>' +
          '<td>' + badge(r.criteria.insurersPass) + '</td>' +
          '<td>' + badge(r.criteria.qualificationsPass) + '</td>' +
          '<td>' + badge(r.criteria.gmcPass) + '</td>' +
          '<td>' + badge(r.criteria.bookOnlinePass) + '</td>' +
          '<td>' + fixes + '</td>' +
        '</tr>';
      }).join("");

      mobileRowsEl.innerHTML = records.map((r) => {
        const specialty = r.specialties.join(", ");
        const hospital = r.hospitals.join(", ");
        const appointments = !r.booking || r.booking.appointmentsNext4Weeks == null ? "N/A" : String(r.booking.appointmentsNext4Weeks);
        const first = !r.booking || r.booking.firstAvailableDaysAway == null ? "N/A" : String(r.booking.firstAvailableDaysAway);
        const ableToBook = !r.booking || r.booking.bookable == null ? "Unknown" : (r.booking.bookable ? "Yes" : "No");
        const ableToBookRag = bookingRagBadge(r);
        const fixes = r.fixes.length
          ? '<ul class="mobile-fixes">' + r.fixes.map(f => '<li>' + esc(f) + '</li>').join("") + '</ul>'
          : '<span class="muted">No fixes required</span>';
        return '<article class="mobile-card">' +
          '<h3><a class="link" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name || r.url) + '</a></h3>' +
          '<div class="mobile-meta"><strong>Specialty:</strong> ' + esc(specialty || "N/A") + '</div>' +
          '<div class="mobile-meta"><strong>Hospital:</strong> ' + esc(hospital || "N/A") + '</div>' +
          '<div class="mobile-meta"><strong>Able to book:</strong> ' + ableToBookRag + ' <span class="muted">' + esc(ableToBook) + '</span></div>' +
          '<div class="mobile-meta"><strong>Appointments (4w):</strong> ' + esc(appointments) + '</div>' +
          '<div class="mobile-meta"><strong>First Available:</strong> ' + esc(first) + ' day(s) away</div>' +
          '<div class="mobile-meta"><strong>Overall:</strong> ' + badge(r.overallPass) + '</div>' +
          '<div class="mobile-meta"><strong>Photo:</strong> ' + badge(r.criteria.photoPass) + ' | <strong>Clinical:</strong> ' + badge(r.criteria.clinicalTermsPass) + '</div>' +
          '<div class="mobile-meta"><strong>Plain English:</strong> ' + esc(String(r.criteria.plainEnglishScore)) + '/5</div>' +
          '<div class="mobile-meta"><strong>Fixes:</strong> ' + fixes + '</div>' +
        '</article>';
      }).join("");
    }

    function applyFilters() {
      const q = searchInput.value.trim().toLowerCase();
      const specialty = specialtyFilter.value;
      const hospital = hospitalFilter.value;
      const overall = overallFilter.value;
      const no5 = next5DaysFilter.value;
      const lt12 = lt12Filter.value;

      const filtered = REVIEW_DATA.records.filter((r) => {
        const hay = [r.name, r.url, ...r.specialties, ...r.hospitals].join(" ").toLowerCase();
        const noAppointments5 =
          !r.booking || r.booking.firstAvailableDaysAway == null || r.booking.firstAvailableDaysAway > 5;
        const lessThan12 =
          !r.booking || r.booking.appointmentsNext4Weeks == null || r.booking.appointmentsNext4Weeks < 12;
        if (q && !hay.includes(q)) return false;
        if (specialty && !r.specialties.includes(specialty)) return false;
        if (hospital && !r.hospitals.includes(hospital)) return false;
        if (overall === "pass" && !r.overallPass) return false;
        if (overall === "fail" && r.overallPass) return false;
        if (no5 === "yes" && !noAppointments5) return false;
        if (no5 === "no" && noAppointments5) return false;
        if (lt12 === "yes" && !lessThan12) return false;
        if (lt12 === "no" && lessThan12) return false;
        return true;
      });

      renderTable(filtered);
    }

    searchInput.addEventListener("input", applyFilters);
    specialtyFilter.addEventListener("change", applyFilters);
    hospitalFilter.addEventListener("change", applyFilters);
    overallFilter.addEventListener("change", applyFilters);
    next5DaysFilter.addEventListener("change", applyFilters);
    lt12Filter.addEventListener("change", applyFilters);
    highRiskPreset.addEventListener("click", () => {
      next5DaysFilter.value = "yes";
      lt12Filter.value = "yes";
      applyFilters();
    });
    clearPreset.addEventListener("click", () => {
      next5DaysFilter.value = "";
      lt12Filter.value = "";
      applyFilters();
    });

    renderTable(REVIEW_DATA.records);
  </script>
</body>
</html>`;
}

async function main() {
  const bookingFromDateYmd = formatDateUTC(new Date());
  let apimKey = process.env.NH_APIM_SUBSCRIPTION_KEY || null;
  if (!apimKey) {
    try {
      apimKey = await discoverApimSubscriptionKey();
      if (apimKey) {
        console.log("Discovered booking APIM key from booking microsite bundle.");
      } else {
        console.log("Booking APIM key not found. Falling back to profile metadata for booking fields.");
      }
    } catch (_) {
      console.log("Could not discover booking APIM key. Falling back to profile metadata for booking fields.");
    }
  }

  console.log("Discovering consultant profile links...");
  const links = await discoverConsultantLinks();
  console.log(`Found ${links.length} consultant profile URLs.`);

  console.log("Evaluating profiles...");
  const profiles = await mapLimit(links, PROFILE_CONCURRENCY, async (link, idx) => {
    if ((idx + 1) % 100 === 0 || idx === links.length - 1) {
      console.log(`Processed ${idx + 1}/${links.length} profiles...`);
    }
    try {
      const html = await fetchText(`${BASE_URL}${link}`);
      const swiftype = extractSwiftype(html);
      return evaluateConsultant(link, html, swiftype, {
        apimKey,
        fromDateYmd: bookingFromDateYmd,
      });
    } catch (err) {
      return {
        name: link,
        url: `${BASE_URL}${link}`,
        specialties: [],
        hospitals: [],
        treatments: [],
        insurers: [],
        qualifications: [],
        gmcNumber: "",
        aboutText: "",
        criteria: {
          photoPass: false,
          clinicalTermsPass: false,
          plainEnglishScore: 0,
          specialtyPass: false,
          proceduresPass: false,
          insurersPass: false,
          qualificationsPass: false,
          gmcPass: false,
          bookOnlinePass: false,
        },
        booking: {
          bookable: null,
          appointmentsNext4Weeks: null,
          firstAvailableDaysAway: null,
        },
        overallPass: false,
        fixes: [`Profile could not be fully evaluated (${err.message}).`],
        excluded: false,
      };
    }
  });

  const included = profiles.filter((p) => !p.excluded);
  const excludedCount = profiles.length - included.length;
  const summary = createSummary(included, excludedCount);
  const payload = {
    scope: {
      listUrl: `${BASE_URL}${LIST_PATH}`,
      exclusions: ["Radiology", "Anaesthetics"],
    },
    summary,
    records: included.sort((a, b) => a.name.localeCompare(b.name)),
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "data.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.html"), renderHtml(payload), "utf8");
  const bookingCsvHeader = [
    "name",
    "url",
    "specialties",
    "hospitals",
    "able_to_book",
    "appointments_next_4_weeks",
    "first_available_days_away",
  ];
  const bookingCsvRows = payload.records
    .map((r) => {
      const cols = [
        r.name,
        r.url,
        r.specialties.join("; "),
        r.hospitals.join("; "),
        !r.booking || r.booking.bookable == null ? "Unknown" : (r.booking.bookable ? "Yes" : "No"),
        !r.booking || r.booking.appointmentsNext4Weeks == null ? "" : String(r.booking.appointmentsNext4Weeks),
        !r.booking || r.booking.firstAvailableDaysAway == null ? "" : String(r.booking.firstAvailableDaysAway),
      ];
      return cols
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",");
    });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "booking-report.csv"),
    `${bookingCsvHeader.join(",")}\n${bookingCsvRows.join("\n")}\n`,
    "utf8"
  );

  console.log("Done.");
  console.log(`Website: ${path.join(OUTPUT_DIR, "index.html")}`);
  console.log(`Data: ${path.join(OUTPUT_DIR, "data.json")}`);
  console.log(`Included: ${summary.totalIncluded} | Excluded: ${summary.totalExcluded}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
