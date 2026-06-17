require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");

const SENT_LOG_PATH = path.join(__dirname, "sent-log.json");

const CONFIG = {
  batchSize: Number(process.env.BATCH_SIZE || 25),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS || 30000),
  retryLimit: Number(process.env.EMAIL_RETRY_LIMIT || 3),
  retryDelayMs: Number(process.env.EMAIL_RETRY_DELAY_MS || 5000),
  passwordLength: Number(process.env.PASSWORD_LENGTH || 10),
};

async function sendEmails() {
  validateEnvironment();

  const supabase = createSupabaseClient();
  const students = await fetchStudents(supabase);
  const sentLog = await loadSentLog();
  const transporter = createTransport();

  await sendEmailBatch({
    supabase,
    students,
    sentLog,
    transporter,
  });
}

function validateEnvironment() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "MAIL_FROM",
    "PORTAL_URL",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function createSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

async function fetchStudents(supabase) {
  const { data, error } = await supabase
    .from("students")
    .select("id, name, email, admission_number, password_hash, day, slot, room")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Could not fetch students: ${error.message}`);
  }

  return data.map((student) => ({
    ...student,
    plainPassword: generatePassword(CONFIG.passwordLength),
  }));
}

function generatePassword(length = 10) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "@#$%";
  const all = upper + lower + digits + symbols;

  const requiredChars = [
    randomChar(upper),
    randomChar(lower),
    randomChar(digits),
    randomChar(symbols),
  ];

  while (requiredChars.length < length) {
    requiredChars.push(randomChar(all));
  }

  return shuffle(requiredChars).join("");
}

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
    if (error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

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

async function sendEmailBatch({ supabase, students, sentLog, transporter }) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < students.length; index += CONFIG.batchSize) {
    const batch = students.slice(index, index + CONFIG.batchSize);

    for (const student of batch) {
      if (sentLog.has(student.id)) {
        skipped += 1;
        console.log(`Skipping ${student.email}; already sent.`);
        continue;
      }

      try {
        const qrBuffer = await generateQRBuffer(student);
        const html = generateEmailHTML(student);

        await sendEmailWithRetry({
          transporter,
          student,
          html,
          qrBuffer,
        });

        await updateStudentPassword(supabase, student);

        sentLog.set(student.id, {
          id: student.id,
          name: student.name,
          email: student.email,
          sent_at: new Date().toISOString(),
        });
        await saveSentLog(sentLog);

        sent += 1;
        console.log(`Sent login email to ${student.email}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed for ${student.email}: ${error.message}`);
      }
    }

    const hasMoreBatches = index + CONFIG.batchSize < students.length;
    if (hasMoreBatches) {
      await delay(CONFIG.batchDelayMs);
    }
  }

  console.log("Email summary");
  console.log(`Sent: ${sent}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total processed: ${sent + failed + skipped}`);
}

async function generateQRBuffer(student) {
  const loginUrl = new URL(process.env.PORTAL_URL);
  loginUrl.searchParams.set("admission_number", student.admission_number);

  return QRCode.toBuffer(loginUrl.toString(), {
    type: "png",
    margin: 2,
    width: 240,
  });
}

function generateEmailHTML(student) {
  return `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2>Your student portal login</h2>
      <p>Hello ${escapeHTML(student.name)},</p>
      <p>Your login credentials are ready.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td><strong>Admission Number</strong></td>
          <td>${escapeHTML(student.admission_number)}</td>
        </tr>
        <tr>
          <td><strong>Password</strong></td>
          <td>${escapeHTML(student.plainPassword)}</td>
        </tr>
        <tr>
          <td><strong>Quiz Day</strong></td>
          <td>${escapeHTML(student.day)}</td>
        </tr>
        <tr>
          <td><strong>Quiz Slot</strong></td>
          <td>${escapeHTML(student.slot)}</td>
        </tr>
        <tr>
          <td><strong>Quiz Room</strong></td>
          <td>${escapeHTML(student.room)}</td>
        </tr>
      </table>
      <p>You can log in here: <a href="${process.env.PORTAL_URL}">${process.env.PORTAL_URL}</a></p>
      <p>The QR code attached to this email also opens your login page.</p>
      <p>Please change your password after your first login.</p>
    </div>
  `;
}

async function sendEmailWithRetry({ transporter, student, html, qrBuffer }) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.retryLimit; attempt += 1) {
    try {
      return await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: student.email,
        subject: "Your Student Portal Login Details",
        html,
        attachments: [
          {
            filename: "login-qr.png",
            content: qrBuffer,
            contentType: "image/png",
          },
        ],
      });
    } catch (error) {
      lastError = error;
      console.warn(
        `Email attempt ${attempt} failed for ${student.email}: ${error.message}`
      );

      if (attempt < CONFIG.retryLimit) {
        await delay(CONFIG.retryDelayMs);
      }
    }
  }

  throw lastError;
}

async function updateStudentPassword(supabase, student) {
  const passwordHash = await bcrypt.hash(student.plainPassword, 12);

  const { error } = await supabase
    .from("students")
    .update({
      password_hash: passwordHash,
      password_updated_at: new Date().toISOString(),
    })
    .eq("id", student.id);

  if (error) {
    throw new Error(`Could not update password for ${student.email}: ${error.message}`);
  }
}

async function saveSentLog(sentLog) {
  const sentEntries = [...sentLog.values()];
  await fs.writeFile(SENT_LOG_PATH, JSON.stringify(sentEntries, null, 2));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomChar(source) {
  return source[Math.floor(Math.random() * source.length)];
}

function shuffle(items) {
  return items
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

sendEmails().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
