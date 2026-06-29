require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const { createClient } = require("@libsql/client");

const SENT_LOG_PATH = path.join(__dirname, "sent-log.json");

const CONFIG = {
  batchSize: Number(process.env.BATCH_SIZE || 25),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS || 30000),
  retryLimit: Number(process.env.EMAIL_RETRY_LIMIT || 3),
  retryDelayMs: Number(process.env.EMAIL_RETRY_DELAY_MS || 5000),
};

// ── Turso client ───────────────────────────────────────────────────────────────

function createDb() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
  }
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

// ── Env validation ─────────────────────────────────────────────────────────────

function validateEnvironment() {
  const required = [
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "MAIL_FROM",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// ── Fetch candidates from Turso ────────────────────────────────────────────────
// Joins all 4 tables to get everything needed for the email in one query.

async function fetchCandidates(db) {
  const result = await db.execute(`
    SELECT
      cp.id,
      cp.full_name,
      cp.email,
      cp.application_number,
      cp.date_of_birth,
      cf.primary_department,
      cf.secondary_department,
      cs.application_status,
      cs.slot_id,
      cq.qr_token,
      s.slot_day,
      s.slot_number,
      s.slot_venue,
      sdd.slot_date,
      sts.start_time
    FROM candidate_profiles cp
    LEFT JOIN candidate_form   cf  ON cf.candidate_id  = cp.id
    LEFT JOIN candidate_status cs  ON cs.candidate_id  = cp.id
    LEFT JOIN candidate_quiz   cq  ON cq.candidate_id  = cp.id
    LEFT JOIN slots            s   ON s.id             = cs.slot_id
    LEFT JOIN slot_day_dates   sdd ON sdd.day_number   = s.slot_day
    LEFT JOIN slot_time_schedules sts ON sts.slot_number = s.slot_number
    WHERE cs.application_status = 'Shortlisted'
    ORDER BY cp.id ASC
  `);

  return result.rows;
}

// ── Sent log ───────────────────────────────────────────────────────────────────

async function loadSentLog() {
  try {
    const raw = await fs.readFile(SENT_LOG_PATH, "utf8");
    return new Map(
      JSON.parse(raw).map((entry) => {
        if (typeof entry === "object" && entry !== null) {
          return [entry.id, entry];
        }
        return [entry, { id: entry }];
      })
    );
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

async function saveSentLog(sentLog) {
  const entries = [...sentLog.values()];
  await fs.writeFile(SENT_LOG_PATH, JSON.stringify(entries, null, 2));
}

// ── Transport ──────────────────────────────────────────────────────────────────

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── QR code ────────────────────────────────────────────────────────────────────
// Uses the qr_token already stored in candidate_quiz — same token the portal
// uses for QR scanning, so attendance is correctly linked.

async function generateQRBuffer(qrToken) {
  // Encode the raw token — admin scanner reads it directly
  return QRCode.toBuffer(qrToken, { margin: 2, width: 240 });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSlotDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function formatSlotTime(timeStr) {
  if (!timeStr) return null;
  const [hh, mm] = timeStr.split(":");
  const h = Number(hh);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${mm} ${ampm}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Email HTML ─────────────────────────────────────────────────────────────────

function generateEmailHTML(candidate) {
  const dateLabel = formatSlotDate(candidate.slot_date) ?? "To be announced";
  const timeLabel = formatSlotTime(candidate.start_time) ?? "To be announced";
  const venueLabel = escapeHTML(candidate.slot_venue ?? "To be announced");
  const dayLabel = candidate.slot_day ? `Day ${candidate.slot_day}` : "To be announced";
  const slotLabel = candidate.slot_number ? `Slot ${candidate.slot_number}` : "To be announced";

  return `
<div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;width:100%;max-width:600px;margin:0 auto;background:#0F1924;color:#f5f6fa;border-radius:16px;overflow:hidden;box-sizing:border-box;">

  <div style="background:linear-gradient(135deg,#0d2650 0%,#173a7a 100%);padding:28px 20px;text-align:center;">
    <img src="https://res.cloudinary.com/dljpfochn/image/upload/v1745520987/mlsclogo_wbhck3.png" alt="MLSC Logo" height="80" style="display:block;margin:0 auto 12px auto;border:0;">
    <h1 style="margin:0;font-size:24px;color:#ffffff;font-weight:700;">Quiz Slot Assigned</h1>
    <p style="margin:8px 0 0 0;color:#b9d3ff;font-size:13px;">Microsoft Learn Student Chapter • TIET</p>
  </div>

  <div style="padding:24px 20px;">

    <p style="font-size:15px;line-height:1.7;color:#ffffff;margin-top:0;">
      Dear <b>${escapeHTML(candidate.full_name)}</b>,
    </p>
    <p style="font-size:14px;line-height:1.7;color:#d6e4ff;margin-bottom:20px;">
      Congratulations! Your recruitment quiz slot for the <b>Microsoft Learn Student Chapter (MLSC)</b> has been scheduled. Please review the details below.
    </p>

    <!-- Registration Details -->
    <div style="background:#152434;border:1px solid #29466b;border-radius:14px;padding:20px;margin-bottom:16px;">
      <h3 style="margin:0 0 14px 0;color:#90caf9;font-size:16px;font-weight:600;">👤 Registration Details</h3>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:8px 0;color:#90caf9;font-size:13px;font-weight:600;width:140px;vertical-align:top;">Student Name</td>
          <td style="padding:8px 0;color:#ffffff;font-size:13px;">${escapeHTML(candidate.full_name)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#90caf9;font-size:13px;font-weight:600;vertical-align:top;">Application No.</td>
          <td style="padding:8px 0;color:#ffffff;font-size:13px;">${escapeHTML(candidate.application_number)}</td>
        </tr>
      </table>
    </div>

    <!-- Exam Schedule -->
    <div style="background:#12263f;border:1px solid #204b7d;border-radius:14px;padding:20px;margin-bottom:16px;">
      <h3 style="margin:0 0 14px 0;color:#4fc3f7;font-size:16px;font-weight:600;">📅 Exam Schedule</h3>

      <div style="background:#17335f;border-radius:10px;padding:12px 16px;margin-bottom:10px;">
        <div style="color:#90caf9;font-size:10px;letter-spacing:1px;font-weight:600;text-transform:uppercase;">Day</div>
        <div style="color:#ffffff;font-size:15px;font-weight:500;margin-top:4px;">${escapeHTML(dayLabel)}</div>
      </div>

      <div style="background:#17335f;border-radius:10px;padding:12px 16px;margin-bottom:10px;">
        <div style="color:#90caf9;font-size:10px;letter-spacing:1px;font-weight:600;text-transform:uppercase;">Date</div>
        <div style="color:#ffffff;font-size:15px;font-weight:500;margin-top:4px;">${escapeHTML(dateLabel)}</div>
      </div>

      <div style="background:#17335f;border-radius:10px;padding:12px 16px;margin-bottom:10px;">
        <div style="color:#90caf9;font-size:10px;letter-spacing:1px;font-weight:600;text-transform:uppercase;">Time Slot</div>
        <div style="color:#ffffff;font-size:15px;font-weight:500;margin-top:4px;">${escapeHTML(slotLabel)} — ${escapeHTML(timeLabel)}</div>
      </div>

      <div style="background:#17335f;border-radius:10px;padding:12px 16px;">
        <div style="color:#90caf9;font-size:10px;letter-spacing:1px;font-weight:600;text-transform:uppercase;">Venue</div>
        <div style="color:#ffffff;font-size:15px;font-weight:500;margin-top:4px;">${venueLabel}</div>
      </div>
    </div>

    <!-- Instructions -->
    <div style="background:#2a2413;border:1px solid #5f4f1f;border-radius:14px;padding:20px;margin-bottom:16px;">
      <h3 style="margin:0 0 12px 0;color:#ffca28;font-size:16px;font-weight:600;">⚠️ Important Instructions</h3>
      <div style="color:#ffffff;font-size:13px;line-height:1.9;">
        <div>🕒 Report to <b>${venueLabel}</b> at least 15 minutes before your slot.</div>
        <div>🪪 Bring your <b>College ID Card</b>.</div>
        <div>📱 Keep this email accessible — you'll need the QR code below for attendance.</div>
      </div>
    </div>

    <!-- QR Code -->
    <div style="background:#152434;border:1px solid #29466b;border-radius:14px;padding:20px;text-align:center;">
      <h3 style="margin:0 0 10px 0;color:#4fc3f7;font-size:16px;font-weight:600;">QR Verification</h3>
      <p style="color:#d6e4ff;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
        Present this QR code at the venue to mark your attendance.
      </p>
      <img
        src="cid:student-qr"
        alt="QR Code"
        width="180"
        height="180"
        style="display:block;margin:0 auto;background:#ffffff;padding:8px;border-radius:10px;"
      />
    </div>

    <!-- Footer -->
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #24384d;text-align:center;">
      <p style="margin:0;color:#ffffff;font-size:15px;">Best of luck!</p>
      <p style="margin-top:8px;color:#4fc3f7;font-size:16px;font-weight:600;">Team MLSC</p>
    </div>

  </div>
</div>
`;
}


// ── Send with retry ────────────────────────────────────────────────────────────

async function sendEmailWithRetry({ transporter, candidate, html, qrBuffer }) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.retryLimit; attempt++) {
    try {
      return await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: candidate.email,
        subject: "MLSC Recruitment Quiz Slot Assigned",
        html,
        attachments: [
          {
            filename: "qr.png",
            content: qrBuffer,
            cid: "student-qr",
            disposition: "inline",
          },
        ],
      });
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.retryLimit) await delay(CONFIG.retryDelayMs);
    }
  }
  throw lastError;
}

// ── Main batch sender ──────────────────────────────────────────────────────────

async function sendEmailBatch({ candidates, sentLog, transporter }) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += CONFIG.batchSize) {
    const batch = candidates.slice(i, i + CONFIG.batchSize);

    for (const candidate of batch) {
      const logEntry = sentLog.get(candidate.id);

      if (logEntry?.status === "Yes") {
        skipped += 1;
        console.log(`Skipping ${candidate.email} — already sent.`);
        continue;
      }

      // Skip candidates with no slot assigned yet
      if (!candidate.slot_id) {
        console.log(`Skipping ${candidate.email} — no slot assigned.`);
        skipped += 1;
        continue;
      }

      // Skip candidates with no qr_token
      if (!candidate.qr_token) {
        console.log(`Skipping ${candidate.email} — no QR token.`);
        skipped += 1;
        continue;
      }

      try {
        const qrBuffer = await generateQRBuffer(candidate.qr_token);
        const html = generateEmailHTML(candidate);

        await sendEmailWithRetry({ transporter, candidate, html, qrBuffer });

        sentLog.set(candidate.id, {
          id: candidate.id,
          full_name: candidate.full_name,
          email: candidate.email,
          status: "Yes",
        });
        await saveSentLog(sentLog);

        sent += 1;
        console.log(`✓ Sent to ${candidate.email}`);
      } catch (error) {
        failed += 1;
        console.error(`✗ Failed for ${candidate.email}: ${error.message}`);
        sentLog.set(candidate.id, {
          id: candidate.id,
          full_name: candidate.full_name,
          email: candidate.email,
          status: "No",
        });
        await saveSentLog(sentLog);
      }
    }

    const hasMoreBatches = i + CONFIG.batchSize < candidates.length;
    if (hasMoreBatches) {
      console.log(`Batch done. Waiting ${CONFIG.batchDelayMs / 1000}s before next batch…`);
      await delay(CONFIG.batchDelayMs);
    }
  }

  console.log("\n── Email Summary ──────────────────────");
  console.log(`Sent:    ${sent}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total:   ${sent + failed + skipped}`);
  console.log("───────────────────────────────────────");
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function sendEmails() {
  validateEnvironment();

  const db = createDb();
  const candidates = await fetchCandidates(db);
  console.log(`Fetched ${candidates.length} candidates from Turso.`);

  const sentLog = await loadSentLog();
  const transporter = createTransport();

  await sendEmailBatch({ candidates, sentLog, transporter });
}

sendEmails().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});