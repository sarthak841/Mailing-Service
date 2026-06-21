require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
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
    "SCANNER_URL",
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
    .select("id, name, branch, email, roll_number, password_hash, day, slot, room, qr_token")
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
      const logEntry = sentLog.get(student.id);

      if (logEntry?.status === "Yes") {
        skipped += 1;
        console.log(`Skipping ${student.email}; already sent.`);
        continue;
      }

      try {
              const studentWithQrToken = await ensureStudentQrToken(supabase, student);
              const qrbuffer = await generateQRBuffer(studentWithQrToken);
              const html = generateEmailHTML(studentWithQrToken);

          await sendEmailWithRetry({
            transporter,
            student: studentWithQrToken,
            html,
            qrbuffer,
          });

        await updateStudentPassword(supabase, studentWithQrToken);

        sentLog.set(studentWithQrToken.id, {
          id: studentWithQrToken.id,
          name: studentWithQrToken.name,
          email: studentWithQrToken.email,
          status: "Yes",
        });
        await saveSentLog(sentLog);

        sent += 1;
        console.log(`Sent login email to ${studentWithQrToken.email}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed for ${student.email}: ${error.message}`);
        sentLog.set(student.id, {
        id: student.id,
        name: student.name,
        email: student.email,
        status: "No",
      });

await saveSentLog(sentLog);
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
  const scannerUrl = new URL(process.env.SCANNER_URL);
  scannerUrl.searchParams.set("qr_token", student.qr_token);

  return QRCode.toBuffer(scannerUrl.toString(), {
    margin: 2,
    width: 240,
  });
}

function generateEmailHTML(student, qrDataUrl) {

  const qrSection = `
  <img
    src="cid:student-qr"
    alt="QR Code"
    style="
      display:block;
      width:100%;
      max-width:200px;
      height:auto;
      margin:0 auto;
      background:#ffffff;
      padding:10px;
      border-radius:12px;
      box-sizing:border-box;
    "
  />
`;

  return `
<div style="
font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
width:100%;
max-width:700px;
margin:0 auto;
background:#0F1924;
color:#f5f6fa;
border-radius:24px;
overflow:hidden;
box-sizing:border-box;
">

  <div style="
  background:#173a7a;
  background-image:linear-gradient(135deg,#0d2650 0%,#173a7a 100%);
  padding:35px 25px;
  text-align:center;
  ">

    <img
      src="https://res.cloudinary.com/dljpfochn/image/upload/v1745520987/mlsclogo_wbhck3.png"
      alt="MLSC Logo"
      height="95"
      style="display:block;margin:0 auto 15px auto;border:0;"
    >

    <h1 style="
    margin:0;
    font-size:32px;
    color:#ffffff;
    font-weight:700;
    ">
      Quiz Slot Assigned
    </h1>

    <p style="
    margin:10px 0 0 0;
    color:#b9d3ff;
    font-size:15px;
    ">
      Microsoft Learn Student Chapter • TIET
    </p>

  </div>

  <div style="padding:30px;">

    <p style="
    font-size:16px;
    line-height:1.7;
    color:#ffffff;
    margin-top:0;
    ">
      Dear <b>${student.name}</b>,
    </p>

    <p style="
    font-size:15px;
    line-height:1.7;
    color:#d6e4ff;
    ">
      Congratulations! Your recruitment quiz slot for the
      <b>Microsoft Learn Student Chapter (MLSC)</b>
      has been scheduled. Please review the details below and ensure that you are available during your assigned slot.
    </p>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
      margin-top:25px;
      background:#152434;
      border:1px solid #29466b;
      border-radius:20px;
      "
    >
      <tr>
        <td style="padding:24px;">

          <h3 style="
          margin:0 0 18px 0;
          color:#90caf9;
          font-size:20px;
          font-weight:600;
          ">
            👤 Registration Details
          </h3>

          <table
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="color:#ffffff;"
          >

            <tr>
              <td style="
              padding:10px 0;
              color:#90caf9;
              width:180px;
              font-weight:600;
              vertical-align:top;
              ">
                Student Name
              </td>

              <td style="
              padding:10px 0;
              color:#ffffff;
              ">
                ${student.name}
              </td>
            </tr>

            <tr>
              <td style="
              padding:12px 0;
              color:#90caf9;
              ">
                Roll Number
              </td>

              <td style="
              padding:10px 0;
              color:#ffffff;
              ">
                ${student.roll_number}
              </td>
            </tr>

            <tr>
              <td style="
              padding:12px 0;
              color:#90caf9;
              ">
                Branch
              </td>

              <td style="
              padding:10px 0;
              color:#ffffff;
              ">
                ${student.branch}
              </td>
            </tr>

            <tr>
              <td style="
              padding:12px 0;
              color:#90caf9;
              ">
                Access Password
              </td>

              <td style="padding:12px 0;">
                <span style="
              font-family:monospace;
              font-weight:600;
              font-size:15px;
              color:#ff8d8d;
              letter-spacing:0.5px;
              text-transform:none;
              ">
                ${student.plainPassword}
              </span>
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
      margin-top:25px;
      background:#12263f;
      border:1px solid #204b7d;
      border-radius:20px;
      "
    >
      <tr>
        <td style="padding:24px;">

          <h3 style="
          margin:0 0 18px 0;
          color:#4fc3f7;
          font-size:20px;
          font-weight:600;
          ">
            📅 Exam Schedule
          </h3>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#17335f;border-radius:16px;margin-bottom:12px;">
            <tr>
              <td style="padding:16px;">
                <div style="
                color:#90caf9;
                font-size:11px;
                letter-spacing:1px;
                font-weight:600;
                ">
                DAY
                </div>

                <div style="
                color:#ffffff;
                font-size:16px;
                font-weight:500;
                margin-top:6px;
                ">
                  Day ${student.day}
                </div>
              </td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#17335f;border-radius:16px;margin-bottom:12px;">
            <tr>
              <td style="padding:16px;">
                <div style="
                color:#90caf9;
                font-size:11px;
                letter-spacing:1px;
                font-weight:600;
                ">
                  TIME SLOT
                </div>

                <div style="
                color:#ffffff;
                font-size:16px;
                font-weight:500;
                margin-top:6px;
                ">
                  ${student.slot}
                </div>
              </td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#17335f;border-radius:16px;">
            <tr>
              <td style="padding:16px;">
                <div style="
                color:#90caf9;
                font-size:11px;
                letter-spacing:1px;
                font-weight:600;
                ">
                  ROOM
                </div>
                <div style="color:#ffffff;font-size:16px;font-weight:500;margin-top:6px;">
                  ${student.room}
                </div>
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
      margin-top:25px;
      background:#2a2413;
      border:1px solid #5f4f1f;
      border-radius:20px;
      "
    >
      <tr>
        <td style="padding:24px;">

          <h3 style="
          margin:0 0 18px 0;
          color:#ffca28;
          font-size:20px;
          font-weight:600;
          ">
            ⚠️ Important Instructions
          </h3>

          <div style="
          color:#ffffff;
          line-height:1.9;
          ">
            <div>🕒 Report to <b>${student.room}</b> at least 15 minutes before your assigned slot.</div>
            <div>🪪 Bring your <b>Registration ID</b>.</div>
            <div>🔐 Keep your <b>Password</b> accessible during verification.</div>
          </div>

        </td>
      </tr>
    </table>

    <div style="
margin-top:30px;
padding:28px;
background:#152434;
border:1px solid #29466b;
border-radius:20px;
text-align:center;
">

  <h3 style="
  margin:0 0 18px 0;
  color:#4fc3f7;
  font-size:20px;
  font-weight:600;
  ">
    QR Verification
  </h3>

  <p style="
  color:#d6e4ff;
  font-size:14px;
  line-height:1.6;
  margin:0 0 20px 0;
  ">
    Present this QR code during verification.
  </p>

  ${qrSection}

  </div>

    <div style="
    margin-top:35px;
    padding-top:25px;
    border-top:1px solid #24384d;
    text-align:center;
    ">

      <p style="
      margin:0;
      color:#ffffff;
      font-size:16px;
      ">
        Best of luck!
      </p>

      <p style="
      margin-top:10px;
      color:#4fc3f7;
      font-size:18px;
      font-weight:600;
      ">
        Team MLSC
      </p>

    </div>
    </div>
  </div>
`;
}

async function ensureStudentQrToken(supabase, student) {
  if (student.qr_token) {
    return student;
  }

  const qrToken = crypto.randomUUID();
  const { data, error } = await supabase
    .from("students")
    .update({ qr_token: qrToken })
    .eq("id", student.id)
    .select("id, name, branch, email, roll_number, password_hash, day, slot, room, qr_token")
    .single();

  if (error) {
    throw new Error(`Could not create QR token for ${student.email}: ${error.message}`);
  }

  return data;
}

async function sendEmailWithRetry({
  transporter,
  student,
  html,
  qrbuffer,
}) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.retryLimit; attempt++) {
    try {
      return await transporter.sendMail({
  from: process.env.MAIL_FROM,
  to: student.email,
  subject: "MLSC Recruitment Quiz Slot Assigned",
  html,

  attachments: [
    {
      filename: "qr.png",
      content: qrbuffer,
      cid: "student-qr",
      disposition: "inline",
    },
  ],
});
    } catch (error) {
      lastError = error;

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
