// server.js — Aivoryx GST Reply Express Backend
// Handles PDF upload, text extraction, credit verification, and AI response.

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const Razorpay = require('razorpay')
const crypto = require('crypto')
const { pool, initSchema } = require('./db')

// ================================================================
//  Credit Packs (must match frontend)
// ================================================================
const CREDIT_PACKS = {
  starter: { credits: 5, amountPaise: 19900, label: 'Starter' },
  professional: { credits: 30, amountPaise: 99900, label: 'Professional' },
  agency: { credits: 100, amountPaise: 249900, label: 'Agency' },
}

// ================================================================
//  Razorpay client (keys from .env)
// ================================================================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
})

// ================================================================
//  App & Middleware Setup
// ================================================================
const app = express()
const PORT = process.env.PORT || 5000

// CORS — allow only listed origins (from .env), protecting against
// cross-origin requests from unauthorised domains.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no Origin header) and listed origins.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      callback(new Error(`CORS policy: origin "${origin}" is not allowed.`))
    },
    credentials: true,
  }),
)

app.use(express.json())

// ================================================================
//  Multer — in-memory storage for uploaded PDFs
//  Files are never written to disk; raw buffer goes to pdf-parse.
// ================================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files are accepted.'))
    }
  },
})

// ================================================================
//  Gemini AI Helper
// ================================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

/**
 * generateGSTResponse(text, mode)
 *
 * mode: 'summary'  → returns a structured free summary (demand amount,
 *                    section, due date) without consuming a credit.
 * mode: 'draft'    → returns a full legal rebuttal citing the CGST Act 2017;
 *                    this call consumes 1 credit.
 *
 * @param {string} text   - Plain text extracted from the GST notice PDF.
 * @param {'summary'|'draft'} mode
 * @returns {Promise<string>} AI-generated response text.
 */
async function generateGSTResponse(text, mode = 'summary') {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a Senior Indian Chartered Accountant with 20+ years of experience
in GST litigation and compliance. You assist taxpayers in responding to notices
issued under the Central Goods and Services Tax (CGST) Act, 2017.
Always cite the precise section, rule, or circular from the CGST Act 2017
or IGST Act 2017 where applicable. Maintain a formal, professional, and
legally sound tone at all times. Do not fabricate legal provisions.`,
  })

  let prompt

  if (mode === 'summary') {
    prompt = `Analyse the following GST notice and respond ONLY with a JSON object (no markdown fences) with these exact keys:
{
  "notice_type": "<type of notice, e.g. SCN, Demand, Audit>",
  "demand_amount": "<amount in INR, numeric string, or null>",
  "section_invoked": "<CGST/IGST section number(s) cited>",
  "due_date": "<response/compliance due date in DD-MMM-YYYY or null>",
  "summary": "<2-3 sentence plain-English summary of what the notice requires>"
}

GST NOTICE TEXT:
---
${text}
---`
  } else {
    prompt = `Draft a formal, legally-sound rebuttal letter to the following GST notice.
The letter must:
1. Be addressed to the issuing officer.
2. Clearly rebut each allegation point-by-point.
3. Cite relevant sections of the CGST Act 2017 / IGST Act 2017 and applicable judicial precedents.
4. Request a personal hearing if applicable.
5. End with a professional closing paragraph.

GST NOTICE TEXT:
---
${text}
---`
  }

  const result = await model.generateContent(prompt)
  const response = result.response
  return response.text()
}

// ================================================================
//  Helper — extract the real client IP (proxy-aware)
// ================================================================
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; first entry is the client.
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

// ================================================================
//  Helper — upsert user row and return the current record
//  Anti-abuse: we update last_ip on every request so the most
//  recent IP is always stored for monitoring purposes.
// ================================================================
async function upsertUser(email, ip) {
  const query = `
    INSERT INTO users (email, last_ip)
    VALUES ($1, $2)
    ON CONFLICT (email)
    DO UPDATE SET last_ip = EXCLUDED.last_ip
    RETURNING id, email, credits_remaining, last_ip, created_at;
  `
  const { rows } = await pool.query(query, [email, ip])
  return rows[0]
}

// ================================================================
//  Routes
// ================================================================

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Aivoryx GST Reply API' })
})

// ----------------------------------------------------------------
// POST /api/analyze
//
// Pipeline:
//   1. Accept PDF upload via multer.
//   2. Extract text with pdf-parse.
//   3. Log client IP.
//   4. Upsert user; check credits.
//   5a. mode=summary  → call AI, return free summary (no credit deducted).
//   5b. mode=draft    → verify credit > 0, deduct 1, call AI, return draft.
//   6. Log to notice_logs.
// ----------------------------------------------------------------
app.post('/api/analyze', upload.single('notice'), async (req, res) => {
  try {
    // --- 1. Validate inputs ---
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No PDF file uploaded. Use field name "notice".' })
    }

    const { email, mode = 'summary' } = req.body

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid user email is required.' })
    }

    if (!['summary', 'draft'].includes(mode)) {
      return res
        .status(400)
        .json({ error: 'mode must be "summary" or "draft".' })
    }

    // --- 2. Extract text from PDF ---
    let pdfText
    try {
      const data = await pdfParse(req.file.buffer)
      pdfText = data.text?.trim()
    } catch {
      return res.status(422).json({
        error:
          'Failed to extract text from the PDF. Ensure it is not scanned/image-only.',
      })
    }

    if (!pdfText || pdfText.length < 50) {
      return res.status(422).json({
        error:
          'The PDF appears to contain no readable text. Please upload a text-based (not scanned) GST notice.',
      })
    }

    // --- 3. Capture IP for anti-abuse logging ---
    const clientIP = getClientIP(req)

    // --- 4. Upsert user and retrieve current credit balance ---
    const user = await upsertUser(email, clientIP)

    // --- 5a. Free summary — no credit check required ---
    if (mode === 'summary') {
      const aiResponse = await generateGSTResponse(pdfText, 'summary')

      // Best-effort JSON parse; return raw text if it fails.
      let parsedSummary
      try {
        parsedSummary = JSON.parse(aiResponse)
      } catch {
        parsedSummary = { raw: aiResponse }
      }

      return res.json({
        mode: 'summary',
        credits_remaining: user.credits_remaining,
        summary: parsedSummary,
      })
    }

    // --- 5b. Full draft — credit check + deduction ---
    if (user.credits_remaining <= 0) {
      return res.status(402).json({
        error:
          'Insufficient credits. Please purchase more credits to generate the full legal draft.',
        credits_remaining: 0,
      })
    }

    // Deduct 1 credit atomically — use WHERE to guard against a race
    // condition where two concurrent requests both see credits > 0.
    const deductQuery = `
      UPDATE users
      SET credits_remaining = credits_remaining - 1
      WHERE id = $1 AND credits_remaining > 0
      RETURNING credits_remaining;
    `
    const { rows: deductRows } = await pool.query(deductQuery, [user.id])

    if (deductRows.length === 0) {
      // Another concurrent request already consumed the last credit.
      return res.status(402).json({
        error: 'Insufficient credits. Please purchase more credits.',
        credits_remaining: 0,
      })
    }

    const creditsAfter = deductRows[0].credits_remaining

    // --- 6. Generate the full legal draft ---
    const draftText = await generateGSTResponse(pdfText, 'draft')

    // --- 7. Log to notice_logs (best-effort; don't fail the response) ---
    try {
      await pool.query(
        `INSERT INTO notice_logs (user_id, notice_type, demand_amount, section_invoked, draft_text)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          user.id,
          req.body.notice_type || 'GST Notice',
          req.body.demand_amount || null,
          req.body.section_invoked || null,
          draftText,
        ],
      )
    } catch (logErr) {
      console.warn(
        '[DB] notice_logs insert failed (non-fatal):',
        logErr.message,
      )
    }

    return res.json({
      mode: 'draft',
      credits_remaining: creditsAfter,
      draft: draftText,
    })
  } catch (err) {
    console.error('[/api/analyze] Unhandled error:', err)
    // Surface quota/rate-limit errors with a clear user-facing message
    if (err.status === 429) {
      return res.status(429).json({
        error:
          'The AI service is temporarily rate-limited. Please wait a few seconds and try again.',
      })
    }
    res.status(500).json({ error: 'Internal server error. Please try again.' })
  }
})

// ----------------------------------------------------------------
// GET /api/profile?email=...
// Returns user info, notice history, and purchase history.
// ----------------------------------------------------------------
app.get('/api/profile', async (req, res) => {
  const { email } = req.query
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' })
  }

  try {
    const userResult = await pool.query(
      'SELECT id, email, credits_remaining, created_at FROM users WHERE email = $1',
      [email],
    )
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' })
    }
    const user = userResult.rows[0]

    const noticesResult = await pool.query(
      `SELECT id, notice_type, demand_amount, section_invoked, draft_text, timestamp
       FROM notice_logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 50`,
      [user.id],
    )

    const purchasesResult = await pool.query(
      `SELECT id, razorpay_payment_id, credits_added, amount_paise, pack_label, status, created_at
       FROM purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id],
    )

    res.json({
      user,
      notices: noticesResult.rows,
      purchases: purchasesResult.rows,
    })
  } catch (err) {
    console.error('[/api/profile]', err)
    res.status(500).json({ error: 'Internal server error.' })
  }
})

// ----------------------------------------------------------------
// POST /api/payments/create-order
// Creates a Razorpay order and returns order details to the frontend.
// ----------------------------------------------------------------
app.post('/api/payments/create-order', async (req, res) => {
  const { email, pack } = req.body

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' })
  }

  const packInfo = CREDIT_PACKS[pack]
  if (!packInfo) {
    return res
      .status(400)
      .json({ error: 'Invalid pack. Choose: starter, professional, agency.' })
  }

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return res
      .status(503)
      .json({ error: 'Payment gateway not configured yet.' })
  }

  try {
    const order = await razorpay.orders.create({
      amount: packInfo.amountPaise,
      currency: 'INR',
      notes: { email, pack, credits: packInfo.credits },
    })

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      pack: { ...packInfo, slug: pack },
    })
  } catch (err) {
    console.error('[/api/payments/create-order]', err)
    res.status(500).json({ error: 'Failed to create payment order.' })
  }
})

// ----------------------------------------------------------------
// POST /api/payments/verify
// Verifies Razorpay payment signature and tops up user credits.
// ----------------------------------------------------------------
app.post('/api/payments/verify', async (req, res) => {
  const {
    email,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    pack,
  } = req.body

  if (
    !email ||
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !razorpay_signature ||
    !pack
  ) {
    return res.status(400).json({ error: 'Missing required payment fields.' })
  }

  const packInfo = CREDIT_PACKS[pack]
  if (!packInfo) {
    return res.status(400).json({ error: 'Invalid pack.' })
  }

  // Verify HMAC SHA256 signature — prevents tampered/fake payment confirmations
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex')

  if (expectedSignature !== razorpay_signature) {
    return res
      .status(400)
      .json({ error: 'Payment signature verification failed.' })
  }

  try {
    // Get user
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email],
    )
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' })
    }
    const userId = userResult.rows[0].id

    // Log purchase and add credits in a transaction
    await pool.query('BEGIN')
    try {
      await pool.query(
        `INSERT INTO purchases (user_id, razorpay_order_id, razorpay_payment_id,
           credits_added, amount_paise, pack_label, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'paid')
         ON CONFLICT (razorpay_order_id) DO UPDATE
           SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
               status = 'paid'`,
        [
          userId,
          razorpay_order_id,
          razorpay_payment_id,
          packInfo.credits,
          packInfo.amountPaise,
          packInfo.label,
        ],
      )
      const { rows } = await pool.query(
        `UPDATE users SET credits_remaining = credits_remaining + $1
         WHERE id = $2 RETURNING credits_remaining`,
        [packInfo.credits, userId],
      )
      await pool.query('COMMIT')

      res.json({
        success: true,
        credits_remaining: rows[0].credits_remaining,
        credits_added: packInfo.credits,
      })
    } catch (txErr) {
      await pool.query('ROLLBACK')
      throw txErr
    }
  } catch (err) {
    console.error('[/api/payments/verify]', err)
    res.status(500).json({ error: 'Failed to process payment.' })
  }
})

// ================================================================
//  Global error handler for multer and other middleware errors
// ================================================================
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('Only PDF') || err.message?.startsWith('CORS')) {
    return res.status(400).json({ error: err.message })
  }
  console.error('[Global Error]', err)
  res.status(500).json({ error: 'Unexpected server error.' })
})

// ================================================================
//  Start Server
// ================================================================
;(async () => {
  try {
    await initSchema()
    app.listen(PORT, () => {
      console.log(`[Server] Aivoryx GST Reply API running on port ${PORT}`)
    })
  } catch (err) {
    console.error('[Server] Startup failed:', err.message)
    process.exit(1)
  }
})()
