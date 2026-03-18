#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const querystring = require("querystring");

const OUTPUT_DIR = path.resolve(process.cwd(), "consultant-review");
const DATA_PATH = path.join(OUTPUT_DIR, "data.json");
const BOOKING_PATH = path.join(OUTPUT_DIR, "booking-report.csv");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function request({ method, hostname, pathName, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname,
        path: pathName,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            resolve(data);
            return;
          }
          reject(new Error(`HTTP ${status} ${method} ${hostname}${pathName}: ${data}`));
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(tenantId, clientId, clientSecret) {
  const formBody = querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const raw = await request({
    method: "POST",
    hostname: "login.microsoftonline.com",
    pathName: `/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(formBody),
    },
    body: formBody,
  });

  const json = JSON.parse(raw);
  if (!json.access_token) {
    throw new Error(`Token response missing access_token: ${raw}`);
  }
  return json.access_token;
}

function formatUkDateTime(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

function buildRecipients(rawTo) {
  return rawTo
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((address) => ({
      emailAddress: { address },
    }));
}

async function sendMail(accessToken, senderUser, mailPayload) {
  await request({
    method: "POST",
    hostname: "graph.microsoft.com",
    pathName: `/v1.0/users/${encodeURIComponent(senderUser)}/sendMail`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(mailPayload),
  });
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }
}

async function main() {
  ensureFile(DATA_PATH);
  ensureFile(BOOKING_PATH);

  const tenantId = requiredEnv("GRAPH_TENANT_ID");
  const clientId = requiredEnv("GRAPH_CLIENT_ID");
  const clientSecret = requiredEnv("GRAPH_CLIENT_SECRET");
  const senderUser = requiredEnv("GRAPH_SENDER_USER");
  const recipients = buildRecipients(process.env.GRAPH_TO || "chris.gowland@nuffieldhealth.com");
  if (recipients.length === 0) {
    throw new Error("No recipients resolved from GRAPH_TO");
  }

  const reportUrl = (process.env.REPORT_URL || "").trim();
  const repoUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : "";

  const payload = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const summary = payload.summary || {};
  const generatedAt = summary.generatedAt || new Date().toISOString();
  const generatedAtUk = formatUkDateTime(generatedAt);
  const failRate = `${(100 - parseFloat(String(summary.overallPassRate || "0").replace("%", ""))).toFixed(1)}%`;

  const bookingCsvBytes = fs.readFileSync(BOOKING_PATH);
  const summaryJson = JSON.stringify(
    {
      generatedAt: summary.generatedAt,
      totalIncluded: summary.totalIncluded,
      totalExcluded: summary.totalExcluded,
      overallPassRate: summary.overallPassRate,
      overallFailRate: failRate,
      criteriaRates: summary.criteriaRates,
      bookingRates: summary.bookingRates,
    },
    null,
    2
  );

  const subject = `NH Profile Tracker Weekly Report - ${generatedAtUk}`;
  const reportLinkHtml = reportUrl
    ? `<p><strong>Live report:</strong> <a href="${reportUrl}">${reportUrl}</a></p>`
    : "";
  const repoLinkHtml = repoUrl
    ? `<p><strong>Repository:</strong> <a href="${repoUrl}">${repoUrl}</a></p>`
    : "";

  const bodyHtml = [
    "<p>Weekly NH consultant profile tracker refresh completed.</p>",
    "<ul>",
    `<li>Profiles reviewed: <strong>${summary.totalIncluded ?? "N/A"}</strong></li>`,
    `<li>Overall pass rate: <strong>${summary.overallPassRate ?? "N/A"}</strong></li>`,
    `<li>Overall fail rate: <strong>${failRate}</strong></li>`,
    `<li>No appointments in next 7 days: <strong>${summary.bookingRates?.noAppointmentsNext7DaysRate ?? "N/A"}</strong></li>`,
    `<li>Less than 12 appointments (4 weeks): <strong>${summary.bookingRates?.lessThan12In4WeeksRate ?? "N/A"}</strong></li>`,
    `<li>Generated at (UK): <strong>${generatedAtUk}</strong></li>`,
    "</ul>",
    reportLinkHtml,
    repoLinkHtml,
    "<p>Attachments: booking report CSV and weekly summary JSON.</p>",
  ].join("");

  const mailPayload = {
    message: {
      subject,
      body: {
        contentType: "HTML",
        content: bodyHtml,
      },
      toRecipients: recipients,
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "booking-report.csv",
          contentType: "text/csv",
          contentBytes: bookingCsvBytes.toString("base64"),
        },
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "weekly-summary.json",
          contentType: "application/json",
          contentBytes: Buffer.from(summaryJson, "utf8").toString("base64"),
        },
      ],
    },
    saveToSentItems: false,
  };

  const accessToken = await getAccessToken(tenantId, clientId, clientSecret);
  await sendMail(accessToken, senderUser, mailPayload);
  console.log(`Weekly report email sent to: ${recipients.map((r) => r.emailAddress.address).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
