// utils/sendEmail.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  // change to your SMTP; gmail works with an app password
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Low-level generic email sender
 */
export async function sendEmail({ to, subject, html, text, from }) {
  return transporter.sendMail({
    from: from || `"Admin" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
  });
}

/**
 * High-level helper for “account created” emails
 */
export async function sendAccountCreatedEmail({
  to,
  fullName,
  loginUrl = process.env.FRONTEND_URL
    ? `${process.env.FRONTEND_URL}/login`
    : "http://localhost:5173/login",
  tempPassword, // optional; if you set passwords manually, omit this
}) {
  const subject = "Your account is ready";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 12px">Hi ${fullName || ""},</h2>
      <p>Your account has been created successfully.</p>
      ${
        tempPassword
          ? `<p><strong>Temporary password:</strong> ${tempPassword}</p>`
          : ""
      }
      <p>You can sign in here: <a href="${loginUrl}">${loginUrl}</a></p>
      <p style="margin-top:16px">If you didn’t expect this, please ignore this email.</p>
    </div>
  `.trim();

  return sendEmail({ to, subject, html });
}

// also provide default for convenience
export default sendEmail;
