const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

async function sendPasswordResetEmail(to, resetUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn("SMTP is not configured, skipping password reset email. Reset URL:", resetUrl);
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await t.sendMail({
    from,
    to,
    subject: "Reset your Master Table password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #2b2b2b;">
        <h2 style="margin-bottom: 8px;">Reset your password</h2>
        <p>We received a request to reset the password for your Master Table account.</p>
        <p>This link will expire in 30 minutes.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="display:inline-block;padding:12px 22px;background:#e0a526;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">
            Reset Password
          </a>
        </p>
        <p style="color:#777;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
        <p style="color:#aaa;font-size:12px;word-break:break-all;">${resetUrl}</p>
      </div>
    `,
  });
}

module.exports = { sendPasswordResetEmail };