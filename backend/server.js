// ═══════════════════════════════════════════════════════
//  IITP HYBRID NAVIGATOR - Backend Server v2
//  New: Demo Lectures CRUD + Chat System + Profile Photos
// ═══════════════════════════════════════════════════════
require("dotenv").config();
const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");
const crypto     = require("crypto");
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");
const Razorpay   = require("razorpay");
const { google } = require("googleapis");

const app = express();
app.use("/api/razorpay-webhook", express.raw({ type: "application/json" }));
app.use(cors({
  origin: ["https://animated-unicorn-616a3a.netlify.app", "http://localhost:5000"],
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));

// ── MongoDB ──────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected!"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schemas ──────────────────────────────────────────────
const mentorSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  email:          { type: String, required: true, unique: true },
  whatsapp:       { type: String, required: true },
  photo:          { type: String, default: "" },  // base64 image
  college:        { type: String, default: "IIT Patna BS AICS" },
  year:           { type: String, required: true },
  specialization: { type: String, required: true },
  courses:        [String],
  rating:         { type: Number, default: 5.0 },
  totalSessions:  { type: Number, default: 0 },
  bio:            { type: String, default: "" },
  isAvailable:    { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now },
});

const bookingSchema = new mongoose.Schema({
  bookingId:         { type: String, default: () => uuidv4().slice(0,8).toUpperCase() },
  mentorId:          { type: mongoose.Schema.Types.ObjectId, ref: "Mentor", required: true },
  studentName:       { type: String, required: true },
  studentEmail:      { type: String, required: true },
  studentWhatsapp:   { type: String, required: true },
  query:             { type: String, default: "" },
  status:            { type: String, enum: ["pending_payment","confirmed","completed","cancelled"], default: "pending_payment" },
  paymentConfirmed:  { type: Boolean, default: false },
  razorpayOrderId:   { type: String, default: "" },
  razorpayPaymentId: { type: String, default: "" },
  meetLink:          { type: String, default: "" },
  calendarEventId:   { type: String, default: "" },
  chatRoomId:        { type: String, default: "" },
  createdAt:         { type: Date, default: Date.now },
});

const demoSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  instructor: { type: String, default: "" },
  youtubeUrl: { type: String, required: true },
  youtubeId:  { type: String, default: "" },
  tags:       [String],
  tagColors:  [String],
  isActive:   { type: Boolean, default: true },
  order:      { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
});

const messageSchema = new mongoose.Schema({
  chatRoomId:  { type: String, required: true, index: true },
  bookingId:   { type: String, required: true },
  senderType:  { type: String, enum: ["student","mentor"], required: true },
  senderName:  { type: String, required: true },
  message:     { type: String, required: true },
  isRead:      { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});

const Mentor  = mongoose.model("Mentor",  mentorSchema);
const Booking = mongoose.model("Booking", bookingSchema);
const Demo    = mongoose.model("Demo",    demoSchema);
const Message = mongoose.model("Message", messageSchema);

// ── Razorpay ──────────────────────────────────────────────
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

// ── Google Calendar ───────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ── Nodemailer ────────────────────────────────────────────
const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });

// ── Helper: YouTube ID extractor ──────────────────────────
function extractYoutubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : "";
}

// ── Helper: Generate Meet link ────────────────────────────
async function generateMeetLink(booking, mentor) {
  try {
    const startTime = new Date(); startTime.setHours(startTime.getHours() + 2);
    const endTime = new Date(startTime); endTime.setHours(endTime.getHours() + 1);
    const event = await calendar.events.insert({
      calendarId: "primary", conferenceDataVersion: 1,
      requestBody: {
        summary: `IITP Navigator — ${booking.studentName} x ${mentor.name}`,
        description: `Booking: ${booking.bookingId}\nQuery: ${booking.query||"General"}`,
        start: { dateTime: startTime.toISOString(), timeZone: "Asia/Kolkata" },
        end:   { dateTime: endTime.toISOString(),   timeZone: "Asia/Kolkata" },
        attendees: [{ email: booking.studentEmail }, { email: mentor.email }],
        conferenceData: { createRequest: { requestId: booking.bookingId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: { useDefault: false, overrides: [{ method:"email",minutes:30 },{ method:"popup",minutes:10 }] },
      },
    });
    return { meetLink: event.data.hangoutLink, eventId: event.data.id };
  } catch (err) { console.error("❌ Meet failed:", err.message); return { meetLink: null, eventId: null }; }
}

// ── Helper: Send confirmation emails ─────────────────────
async function sendConfirmationEmails(booking, mentor) {
  const base = process.env.FRONTEND_URL || "http://localhost:3000";
  const chatUrl = `${base}?chat=${booking.chatRoomId}&role=student&name=${encodeURIComponent(booking.studentName)}`;
  const mentorChatUrl = `${base}?chat=${booking.chatRoomId}&role=mentor&name=${encodeURIComponent(mentor.name)}`;

  await transporter.sendMail({
    from: `"IITP Navigator" <${process.env.EMAIL_USER}>`, to: booking.studentEmail,
    subject: `✅ Confirmed! Meet + Chat Ready — #${booking.bookingId}`,
    html: `<div style="font-family:Arial;max-width:500px;margin:auto;background:#0a0f1e;color:#fff;padding:30px;border-radius:16px">
      <h2 style="color:#4ade80">Payment Confirmed! 🎉</h2>
      <p>Hi <b>${booking.studentName}</b></p>
      <div style="background:#1e293b;padding:16px;border-radius:12px;margin:16px 0">
        <p>🎓 Mentor: <b>${mentor.name}</b> (${mentor.year})</p>
        <p>🔖 Booking ID: <b>${booking.bookingId}</b></p>
      </div>
      <a href="${booking.meetLink}" style="display:block;background:#2563eb;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:bold;margin-bottom:10px">🎥 Join Google Meet</a>
      <a href="${chatUrl}" style="display:block;background:#7c3aed;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:bold">💬 Chat with Mentor on Platform</a>
    </div>`,
  });

  await transporter.sendMail({
    from: `"IITP Navigator" <${process.env.EMAIL_USER}>`, to: mentor.email,
    subject: `🔔 New Student Booked! #${booking.bookingId}`,
    html: `<div style="font-family:Arial;max-width:500px;margin:auto;background:#0a0f1e;color:#fff;padding:30px;border-radius:16px">
      <h2 style="color:#facc15">New Booking! 📅</h2>
      <div style="background:#1e293b;padding:16px;border-radius:12px;margin:16px 0">
        <p>👤 <b>${booking.studentName}</b></p>
        <p>📱 +91${booking.studentWhatsapp}</p>
        <p>❓ ${booking.query||"General guidance"}</p>
      </div>
      <a href="${booking.meetLink}" style="display:block;background:#2563eb;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:bold;margin-bottom:10px">🎥 Join Google Meet</a>
      <a href="${mentorChatUrl}" style="display:block;background:#7c3aed;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:bold">💬 Chat with Student</a>
    </div>`,
  });
  console.log("✅ Emails sent!");
}

// ════════════════════════════════════════════════════════
//  MENTOR ROUTES
// ════════════════════════════════════════════════════════
app.get("/api/mentors", async (req, res) => {
  try { res.json({ success: true, data: await Mentor.find({ isAvailable: true }).sort({ totalSessions: -1 }) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/mentors/register", async (req, res) => {
  try {
    const mentor = new Mentor(req.body);
    await mentor.save();
    await transporter.sendMail({ from: `"IITP Navigator" <${process.env.EMAIL_USER}>`, to: mentor.email, subject: "🎓 Profile Live!", html: `<div style="background:#0a0f1e;color:#fff;padding:30px;border-radius:16px;font-family:Arial"><h2 style="color:#facc15">Welcome, ${mentor.name}! 🚀</h2><p>Tumhara profile <b style="color:#4ade80">LIVE</b> ho gaya!</p></div>` });
    res.json({ success: true, data: mentor });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: "Email already registered!" });
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  BOOKING ROUTES
// ════════════════════════════════════════════════════════
app.post("/api/bookings", async (req, res) => {
  try {
    const { mentorId, studentName, studentEmail, studentWhatsapp, query } = req.body;
    const mentor = await Mentor.findById(mentorId);
    if (!mentor) return res.status(404).json({ success: false, message: "Mentor not found" });

    const chatRoomId = uuidv4().slice(0, 12);
    const booking = new Booking({ mentorId, studentName, studentEmail, studentWhatsapp, query, chatRoomId });
    await booking.save();

    const order = await razorpay.orders.create({ amount: 5000, currency: "INR", receipt: booking.bookingId });
    booking.razorpayOrderId = order.id;
    await booking.save();

    await transporter.sendMail({ from: `"IITP Navigator" <${process.env.EMAIL_USER}>`, to: process.env.ADMIN_EMAIL, subject: `💰 New Booking #${booking.bookingId}`, html: `<p>Student: ${studentName} | Mentor: ${mentor.name} | Pending payment</p>` });

    res.json({ success: true, bookingId: booking.bookingId, mongoId: booking._id, razorpayOrderId: order.id, amount: 5000, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/razorpay-webhook", async (req, res) => {
  try {
    const sig = req.headers["x-razorpay-signature"];
    const exp = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
    if (sig !== exp) return res.status(400).json({ message: "Invalid" });

    const event = JSON.parse(req.body);
    if (event.event === "payment.captured") {
      const booking = await Booking.findOne({ razorpayOrderId: event.payload.payment.entity.order_id }).populate("mentorId");
      if (!booking || booking.paymentConfirmed) return res.json({ received: true });

      const { meetLink, eventId } = await generateMeetLink(booking, booking.mentorId);
      booking.paymentConfirmed = true; booking.status = "confirmed";
      booking.meetLink = meetLink || "https://meet.google.com"; booking.calendarEventId = eventId || "";
      await booking.save();
      await Mentor.findByIdAndUpdate(booking.mentorId._id, { $inc: { totalSessions: 1 } });
      await sendConfirmationEmails(booking, booking.mentorId);
    }
    res.json({ received: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/bookings/:id/status", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id).populate("mentorId","whatsapp name");
    if (!b) return res.status(404).json({ success: false });
    res.json({ success: true, confirmed: b.paymentConfirmed, meetLink: b.paymentConfirmed ? b.meetLink : null, chatRoomId: b.paymentConfirmed ? b.chatRoomId : null, mentorWhatsapp: b.paymentConfirmed ? b.mentorId?.whatsapp : null, mentorName: b.mentorId?.name });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ════════════════════════════════════════════════════════
//  CHAT ROUTES
// ════════════════════════════════════════════════════════
app.get("/api/chat/:roomId", async (req, res) => {
  try {
    const b = await Booking.findOne({ chatRoomId: req.params.roomId, paymentConfirmed: true }).populate("mentorId","name photo year specialization");
    if (!b) return res.status(404).json({ success: false, message: "Room not found" });
    res.json({ success: true, chatRoomId: b.chatRoomId, bookingId: b.bookingId, studentName: b.studentName, mentor: b.mentorId });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/chat/:roomId/messages", async (req, res) => {
  try {
    const b = await Booking.findOne({ chatRoomId: req.params.roomId, paymentConfirmed: true });
    if (!b) return res.status(403).json({ success: false });
    const msgs = await Message.find({ chatRoomId: req.params.roomId }).sort({ createdAt: 1 }).limit(300);
    res.json({ success: true, data: msgs });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/chat/:roomId/messages", async (req, res) => {
  try {
    const { senderType, senderName, message } = req.body;
    const b = await Booking.findOne({ chatRoomId: req.params.roomId, paymentConfirmed: true });
    if (!b) return res.status(403).json({ success: false });
    const msg = new Message({ chatRoomId: req.params.roomId, bookingId: b.bookingId, senderType, senderName, message });
    await msg.save();
    res.json({ success: true, data: msg });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.put("/api/chat/:roomId/read", async (req, res) => {
  try {
    const other = req.body.readerType === "student" ? "mentor" : "student";
    await Message.updateMany({ chatRoomId: req.params.roomId, senderType: other }, { isRead: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ════════════════════════════════════════════════════════
//  DEMO LECTURE ROUTES
// ════════════════════════════════════════════════════════
app.get("/api/demos", async (req, res) => {
  try { res.json({ success: true, data: await Demo.find({ isActive: true }).sort({ order: 1, createdAt: -1 }) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/admin/demos", async (req, res) => {
  try { res.json({ success: true, data: await Demo.find().sort({ order: 1, createdAt: -1 }) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/admin/demos", async (req, res) => {
  try {
    const { title, instructor, youtubeUrl, tags, tagColors, order } = req.body;
    const youtubeId = extractYoutubeId(youtubeUrl);
    if (!youtubeId) return res.status(400).json({ success: false, message: "Invalid YouTube URL!" });
    const demo = new Demo({ title, instructor, youtubeUrl, youtubeId, tags: tags||[], tagColors: tagColors||[], order: order||0 });
    await demo.save();
    res.json({ success: true, data: demo });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put("/api/admin/demos/:id", async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.youtubeUrl) { update.youtubeId = extractYoutubeId(update.youtubeUrl); if (!update.youtubeId) return res.status(400).json({ success: false, message: "Invalid URL" }); }
    res.json({ success: true, data: await Demo.findByIdAndUpdate(req.params.id, update, { new: true }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/admin/demos/:id", async (req, res) => {
  try { await Demo.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false }); }
});

// ════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════
app.get("/api/admin/bookings", async (req, res) => {
  try { res.json({ success: true, data: await Booking.find().populate("mentorId","name email whatsapp").sort({ createdAt: -1 }) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/admin/bookings/:id/confirm", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate("mentorId");
    if (!booking) return res.status(404).json({ success: false });
    if (booking.paymentConfirmed) return res.json({ success: true, message: "Already confirmed" });
    const { meetLink, eventId } = await generateMeetLink(booking, booking.mentorId);
    booking.paymentConfirmed = true; booking.status = "confirmed";
    booking.meetLink = meetLink || "https://meet.google.com"; booking.calendarEventId = eventId || "";
    await booking.save();
    await Mentor.findByIdAndUpdate(booking.mentorId._id, { $inc: { totalSessions: 1 } });
    await sendConfirmationEmails(booking, booking.mentorId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/admin/mentors", async (req, res) => {
  try { res.json({ success: true, data: await Mentor.find().sort({ createdAt: -1 }) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/admin/mentors/:id", async (req, res) => {
  try { await Mentor.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server → http://localhost:${PORT}`));