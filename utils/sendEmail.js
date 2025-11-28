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
    from: from || `"LMS" <${process.env.SMTP_USER}>`,
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
  role,
  mobile,
  loginUrl = process.env.APP_BASE_URL
    ? `${process.env.APP_BASE_URL}/login`
    : "http://localhost:3000/login",
}) {
  const subject = "Welcome to Learning Management System";
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <title>Welcome to Learning Management System</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: Arial, Helvetica, sans-serif;
          line-height: 1.6;
          color: #333333;
          background-color: #f4f4f4;
        }
        .email-wrapper {
          width: 100%;
          background-color: #f4f4f4;
          padding: 20px 0;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%);
          color: #ffffff;
          padding: 40px 30px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 600;
        }
        .content {
          padding: 40px 30px;
        }
        .greeting {
          font-size: 20px;
          font-weight: 600;
          color: #1F2937;
          margin: 0 0 20px;
        }
        .message {
          font-size: 16px;
          color: #4B5563;
          margin: 0 0 20px;
        }
        .info-box {
          background-color: #F9FAFB;
          border: 1px solid #E5E7EB;
          border-radius: 6px;
          padding: 20px;
          margin: 25px 0;
        }
        .info-row {
          display: flex;
          padding: 10px 0;
          border-bottom: 1px solid #E5E7EB;
        }
        .info-row:last-child {
          border-bottom: none;
        }
        .info-label {
          font-weight: 600;
          color: #4F46E5;
          min-width: 140px;
        }
        .info-value {
          color: #1F2937;
          flex: 1;
        }
        .button-container {
          text-align: center;
          margin: 30px 0;
        }
        .button {
          display: inline-block;
          padding: 14px 32px;
          background-color: #4F46E5;
          color: #ffffff !important;
          text-decoration: none;
          border-radius: 6px;
          font-weight: 600;
          font-size: 16px;
          transition: background-color 0.3s ease;
        }
        .button:hover {
          background-color: #4338CA;
        }
        .footer {
          background-color: #F9FAFB;
          padding: 30px;
          text-align: center;
          border-top: 1px solid #E5E7EB;
        }
        .footer p {
          margin: 5px 0;
          font-size: 14px;
          color: #6B7280;
        }
        .divider {
          height: 1px;
          background-color: #E5E7EB;
          margin: 25px 0;
        }
        @media only screen and (max-width: 600px) {
          .email-container {
            width: 100% !important;
            margin: 0 !important;
            border-radius: 0 !important;
          }
          .header h1 {
            font-size: 24px;
          }
          .content {
            padding: 30px 20px;
          }
          .info-row {
            flex-direction: column;
          }
          .info-label {
            margin-bottom: 5px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td align="center">
              <div class="email-container">
                <!-- Header -->
                <div class="header">
                  <h1>Welcome to Learning Management System</h1>
                </div>
                
                <!-- Content -->
                <div class="content">
                  <p class="greeting">Hello ${fullName || "there"},</p>
                  
                  <p class="message">
                    We're excited to have you on board! Your account has been successfully created, 
                    and you're now ready to start your journey with our Learning Management System.
                  </p>
                  
                  <!-- Account Details -->
                  <div class="info-box">
                    <div class="info-row">
                      <span class="info-label">Name:</span>
                      <span class="info-value">${fullName || "N/A"}</span>
                    </div>
                    <div class="info-row">
                      <span class="info-label">Email:</span>
                      <span class="info-value">${to}</span>
                    </div>
                    ${role ? `
                    <div class="info-row">
                      <span class="info-label">Role:</span>
                      <span class="info-value">${role.toUpperCase()}</span>
                    </div>
                    ` : ''}
                    ${mobile ? `
                    <div class="info-row">
                      <span class="info-label">Mobile:</span>
                      <span class="info-value">${mobile}</span>
                    </div>
                    ` : ''}
                  </div>
                  
                  <div class="divider"></div>
                  
                  <!-- CTA Button -->
                  <div class="button-container">
                    <a href="${loginUrl}" class="button">
                      Access Your Account
                    </a>
                  </div>
                  
                  <p class="message" style="text-align: center; margin-top: 20px;">
                    Or copy and paste this link into your browser:<br>
                    <a href="${loginUrl}" style="color: #4F46E5; word-break: break-all;">${loginUrl}</a>
                  </p>
                  
                  <div class="divider"></div>
                  
                  <p class="message" style="font-size: 14px;">
                    If you have any questions or need assistance getting started, our support team is here to help. 
                    Feel free to reach out anytime.
                  </p>
                  
                  <p class="message" style="font-size: 14px; margin-top: 20px;">
                    Best regards,<br>
                    <strong>Learning Management System Team</strong>
                  </p>
                </div>
                
                <!-- Footer -->
                <div class="footer">
                  <p>© ${new Date().getFullYear()} Learning Management System. All rights reserved.</p>
                  <p>This is an automated message. Please do not reply to this email.</p>
                  <p style="margin-top: 15px; font-size: 12px;">
                    If you didn't request this account, please ignore this email or contact our support team.
                  </p>
                </div>
              </div>
            </td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `.trim();

  // Plain text version for email clients that don't support HTML
  const text = `
Welcome to Learning Management System

Hello ${fullName || "there"},

We're excited to have you on board! Your account has been successfully created.

Account Details:
━━━━━━━━━━━━━━━━━━━━━━
Name: ${fullName || "N/A"}
Email: ${to}
${role ? `Role: ${role.toUpperCase()}` : ''}
${mobile ? `Mobile: ${mobile}` : ''}
━━━━━━━━━━━━━━━━━━━━━━

Access your account here: ${loginUrl}

If you have any questions or need assistance, our support team is here to help.

Best regards,
Learning Management System Team

━━━━━━━━━━━━━━━━━━━━━━
© ${new Date().getFullYear()} Learning Management System. All rights reserved.
This is an automated message. Please do not reply to this email.

If you didn't request this account, please ignore this email or contact our support team.
  `.trim();

  return sendEmail({ to, subject, html, text });
}


export async function sendSuperAdminRegistrationEmail({
  email,
  fullName,
  role,
  password,
  mobile,
  loginUrl = process.env.APP_BASE_URL
    ? `${process.env.APP_BASE_URL}/login`
    : "http://localhost:5173/login",
}) {
  const subject =
    "Welcome to Learning Management System - Registration Successful";

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
        .content { background-color: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; }
        .info-box { background-color: white; padding: 15px; margin: 15px 0; border-left: 4px solid #4F46E5; }
        .info-row { margin: 10px 0; }
        .info-label { font-weight: bold; color: #4F46E5; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #6b7280; }
        .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .warning { background-color: #FEF3C7; padding: 15px; border-left: 4px solid #F59E0B; margin: 15px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to Learning Management System</h1>
        </div>
        <div class="content">
          <h2>Hello ${fullName},</h2>
          <p>You are registered on the Learning Management System!</p>
          
          <div class="info-box">
            <div class="info-row">
              <span class="info-label">Name:</span> ${fullName}
            </div>
            <div class="info-row">
              <span class="info-label">Email:</span> ${email}
            </div>
            <div class="info-row">
              <span class="info-label">Role:</span> ${role.toUpperCase()}
            </div>
            <div class="info-row">
              <span class="info-label">Password:</span> ${password}
            </div>
            ${
              mobile
                ? `<div class="info-row"><span class="info-label">Mobile:</span> ${mobile}</div>`
                : ""
            }
          </div>
          
          <div class="warning">
            <p style="margin: 0;"><strong>⚠️ Important Security Note:</strong></p>
            <p style="margin: 5px 0 0;">Please change your password immediately after your first login for security purposes.</p>
          </div>
          
          <div style="text-align: center;">
            <a href="${loginUrl}" class="button">
              Login Now
            </a>
          </div>
          
          <p>If you have any questions or need assistance, please don't hesitate to contact our support team.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} Learning Management System. All rights reserved.</p>
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    </body>
    </html>
  `.trim();

  const text = `
Hello ${fullName},

You are registered on the Learning Management System!

Your Registration Details:
━━━━━━━━━━━━━━━━━━━━━━
Name: ${fullName}
Email: ${email}
Role: ${role.toUpperCase()}
Password: ${password}
Mobile: ${mobile || "Not provided"}
━━━━━━━━━━━━━━━━━━━━━━

⚠️ IMPORTANT: Please change your password immediately after your first login for security purposes.

Login here: ${loginUrl}

If you have any questions, please contact our support team.

Best regards,
Learning Management System Team

© ${new Date().getFullYear()} Learning Management System. All rights reserved.
  `.trim();

  return sendEmail({ to: email, subject, html, text });
}

// also provide default for convenience
export default sendEmail;
