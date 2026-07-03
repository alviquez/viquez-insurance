import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Brand palette (matches index.html)
const INK = rgb(0x18 / 255, 0x35 / 255, 0x2e / 255);
const BRASS = rgb(0x97 / 255, 0x65 / 255, 0x1f / 255);
const MUTED = rgb(0x62 / 255, 0x70 / 255, 0x6a / 255);
const LINE = rgb(0.89, 0.88, 0.84);

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let data;
  try {
    data = await req.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  // Honeypot: silently accept and drop suspected bot submissions
  if (data.company_website) {
    return json({ ok: true }, 200);
  }

  const required = ['fullName', 'phone', 'email'];
  for (const field of required) {
    if (!data[field] || !String(data[field]).trim()) {
      return json({ error: `Missing required field: ${field}` }, 400);
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.QUOTE_NOTIFY_EMAIL || 'mviquez@orrandassociates.com';
  const fromEmail = process.env.QUOTE_FROM_EMAIL || 'onboarding@resend.dev';

  if (!resendKey) {
    console.error('RESEND_API_KEY is not set');
    return json({ error: 'Email service is not configured' }, 500);
  }

  try {
    const pdfBytes = await buildPdf(data);
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Viquez Insurance Website <${fromEmail}>`,
        to: [toEmail],
        reply_to: data.email,
        subject: `New Quote Request — ${data.fullName}`,
        html: buildEmailHtml(data),
        attachments: [
          {
            filename: `quote-request-${slugify(data.fullName)}.pdf`,
            content: pdfBase64,
          },
        ],
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend error:', errText);
      return json({ error: 'Failed to send email' }, 502);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error('quote-request function error:', err);
    return json({ error: 'Unexpected server error' }, 500);
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'quote';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildEmailHtml(data) {
  const coverage = Array.isArray(data.coverage) ? data.coverage.join(', ') : (data.coverage || '—');
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; color:#18352E; max-width:520px;">
      <h2 style="margin:0 0 8px; font-weight:600;">New Quote Request</h2>
      <p style="margin:0 0 20px; color:#62706A; font-size:14px;">
        ${escapeHtml(data.fullName)} just submitted a quote request from the website. Full details are attached as a PDF.
      </p>
      <table style="font-size:14px; border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0; color:#62706A;">Name</td><td>${escapeHtml(data.fullName)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#62706A;">Phone</td><td>${escapeHtml(data.phone)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#62706A;">Email</td><td>${escapeHtml(data.email)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#62706A;">Coverage</td><td>${escapeHtml(coverage)}</td></tr>
      </table>
    </div>
  `;
}

async function buildPdf(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const marginX = 56;
  let y = 738;

  page.drawText('Viquez Insurance Services', { x: marginX, y, size: 18, font: fontBold, color: INK });
  y -= 20;
  page.drawText('New Quote Request', { x: marginX, y, size: 12, font: fontRegular, color: BRASS });
  y -= 12;
  page.drawLine({ start: { x: marginX, y }, end: { x: 556, y }, thickness: 1, color: LINE });
  y -= 26;

  const submittedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    dateStyle: 'long',
    timeStyle: 'short',
  });

  const coverage = Array.isArray(data.coverage) && data.coverage.length ? data.coverage.join(', ') : '—';

  const fields = [
    ['Submitted', `${submittedAt} (CT)`],
    ['Full Name', data.fullName],
    ['Business Name', data.businessName],
    ['Phone', data.phone],
    ['Email', data.email],
    ['State', data.state],
    ['Number of Employees', data.employees],
    ['Coverage Interested In', coverage],
    ['Currently Insured?', data.currentlyInsured],
    ['Preferred Contact Method', data.preferredContact],
    ['SMS Consent Given', data.smsConsent ? 'Yes' : 'No'],
  ];

  for (const [label, value] of fields) {
    y = drawField(page, label, value, marginX, y, fontBold, fontRegular);
    if (y < 100) break; // safety guard against overflow
  }

  y -= 8;
  page.drawText('ADDITIONAL DETAILS', { x: marginX, y, size: 8, font: fontBold, color: MUTED });
  y -= 16;
  const notes = wrapText(data.notes || '—', 92);
  for (const line of notes) {
    if (y < 60) break;
    page.drawText(line, { x: marginX, y, size: 10.5, font: fontRegular, color: INK });
    y -= 14;
  }

  return doc.save();
}

function drawField(page, label, value, x, y, fontBold, fontRegular) {
  page.drawText(String(label).toUpperCase(), { x, y, size: 8, font: fontBold, color: MUTED });
  y -= 13;
  page.drawText(String(value || '—'), { x, y, size: 11.5, font: fontRegular, color: INK });
  y -= 20;
  return y;
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
