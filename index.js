require('dotenv').config()
const express = require('express')
const cors = require('cors')
const Groq = require('groq-sdk')
const mongoose = require('mongoose')
const http = require('http')
const { Server } = require('socket.io')
const Razorpay = require('razorpay')
const twilio = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const app = express()
const server = http.createServer(app)

// ─── CORS CONFIGURATION ──────────────────────────────────────────────────────
// WHY: Browser security blocks cross-origin requests unless the server
// explicitly allows the requesting origin. Without this, every API call
// from your Vercel frontend will fail with "CORS error" in the console.
//
// Replace YOUR_VERCEL_APP_URL with your actual Vercel deployment URL.
// You can add multiple URLs (e.g. preview deployments) to the array.
const ALLOWED_ORIGINS = [
  'https://getserveai.vercel.app',          // Production frontend (always allowed)
  process.env.FRONTEND_URL,                 // Optional: set in Render env for preview deployments
  'http://localhost:5173',                  // Vite default dev port
  'http://localhost:5174',                  // Vite alternate dev port
  'http://localhost:3000',                  // In case frontend and backend run on same machine
].filter(Boolean)                           // Remove undefined if FRONTEND_URL is not set

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin header (Twilio webhooks, curl, Postman)
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    console.warn(`[CORS] Blocked origin: ${origin}`)
    callback(new Error(`CORS policy: origin ${origin} is not allowed`))
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}

// Apply CORS to all Express routes
app.use(cors(corsOptions))

// Socket.IO with the same CORS rules
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  }
})

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
})

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err))

const orderSchema = new mongoose.Schema({
  customerNumber: String,
  items: String,
  total: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
})
const menuSchema = new mongoose.Schema({
  name: String,
  price: Number,
  available: { type: Boolean, default: true }
})

const MenuItem = mongoose.model('MenuItem', menuSchema)
const seedMenu = async () => {
  const count = await MenuItem.countDocuments()
  if (count === 0) {
    await MenuItem.insertMany([
      { name: 'Butter Chicken', price: 280, available: true },
      { name: 'Paneer Tikka', price: 240, available: true },
      { name: 'Dal Makhani', price: 180, available: true },
      { name: 'Naan', price: 40, available: true },
      { name: 'Rice', price: 60, available: true },
      { name: 'Lassi', price: 80, available: true },
    ])
    console.log('Menu seeded!')
  }
}
seedMenu()
const Order = mongoose.model('Order', orderSchema)

// const menu = `
// Sharma's Kitchen Menu:
// - Butter Chicken - Rs 280
// - Paneer Tikka - Rs 240
// - Dal Makhani - Rs 180
// - Naan - Rs 40
// - Rice - Rs 60
// - Lassi - Rs 80
// `

const sessions = {}

app.post('/webhook', async (req, res) => {
  const menuItems = await MenuItem.find({ available: true })
const dynamicMenu = menuItems
  .map(item => `- ${item.name} - Rs ${item.price}`)
  .join('\n')
  const message = req.body.Body
  const from = req.body.From

  if (!sessions[from]) {
    sessions[from] = { messages: [] }
  }

  sessions[from].messages.push({ role: 'user', content: message })
  console.log(`Message from ${from}: ${message}`)

  const aiReply = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
     content: `You are a friendly ordering assistant for Sharma's Kitchen.
${dynamicMenu}

STRICT RULES:
- ONLY accept orders for items listed above
- If customer asks for item NOT in the list, say it's unavailable
- Never accept order for unavailable item even if customer insists
- Reply in Hinglish
- Keep replies short and friendly

HANDLING SPECIAL INSTRUCTIONS (spice level, no onion, etc.):
- Track special instructions separately from the item itself
- If customer says "no coriander" then later says "keep coriander" 
  or "don't remove coriander" — the LATEST instruction always wins
- Never argue with the customer about what they can or cannot have
- Simply acknowledge their latest preference and move on
- Example: Customer says "no onion" then "actually keep onion" 
  → Final order has onion, don't mention the earlier "no onion" again

HANDLING CONFUSING OR CONTRADICTORY MESSAGES:
- If a customer message has multiple instructions in one line, 
  process them in order, left to right
- If genuinely unclear, ask ONE simple clarifying question
- Never say an instruction is impossible — just confirm what 
  you understood

ORDER SUMMARY FORMAT (use this when showing the current order 
or before final confirmation):
Aapka order:
- [Item name] x[quantity] - Rs [price]
  Instructions: [special instructions if any, else skip this line]
Total: Rs [amount]

When customer says "confirm" or "order confirm karo", reply with 
EXACTLY this format:
ORDER_CONFIRMED
Items: [item name with instructions in brackets if any]
Total: Rs [amount]

Example: 
ORDER_CONFIRMED
Items: Paneer Tikka (medium spicy, extra coriander), Naan x3
Total: Rs 360`
      },
      ...sessions[from].messages
    ]
  })

  const reply = aiReply.choices[0].message.content
  sessions[from].messages.push({ role: 'assistant', content: reply })

  if (reply.includes('ORDER_CONFIRMED')) {
    const itemsMatch = reply.match(/Items:\s*(.+?)(?=Total:)/s)
    const itemsText = itemsMatch ? itemsMatch[1].trim() : 'Order'
    const totalMatch = reply.match(/Total:\s*Rs\s*(\d+)/)
    const totalAmount = totalMatch ? totalMatch[1] : '0'

    // MongoDB mein save karo
    const newOrder = new Order({
      customerNumber: from,
      items: itemsText,
      total: totalAmount,
      status: 'pending'
    })
    await newOrder.save()
    console.log('Order saved to MongoDB!')

    // Dashboard ko notify karo
    // NOTE: items must be an array of objects with 'name' and 'qty' keys
    // to match the shape returned by GET /api/orders and expected by OrderCard
    io.emit('new_order', {
      _id: newOrder._id,
      customerPhone: from.replace('whatsapp:', ''),
      items: [{ name: itemsText, qty: 1 }],
      totalAmount: parseInt(totalAmount) || 0,
      status: 'pending',
      createdAt: newOrder.createdAt
    })

    // Razorpay payment link banao
    const paymentLink = await razorpay.paymentLink.create({
      amount: parseInt(totalAmount) * 100,
      currency: 'INR',
      description: `Sharma's Kitchen Order`,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { customerNumber: from, items: itemsText }
    })
    console.log('Payment link created:', paymentLink.short_url)

    // Payment link WhatsApp pe bhejo
    await twilio.messages.create({
      from: 'whatsapp:+14155238886',
      to: from,
      body: `💳 Payment link:\n${paymentLink.short_url}\n\nTotal: Rs ${totalAmount}`
    })
    console.log('Payment link sent!')
  }

  const cleanReply = reply.replace('ORDER_CONFIRMED', '✅ Order Confirmed!')
  console.log(`AI Reply: ${reply}`)

  res.set('Content-Type', 'text/xml')
  res.send(`<Response><Message>${cleanReply}</Message></Response>`)
})

// Helper: format a raw Order document into the shape the dashboard expects
const formatOrder = (order) => ({
  _id: order._id,
  customerPhone: order.customerNumber
    ? order.customerNumber.replace('whatsapp:', '')
    : 'Unknown',
  items: order.items
    ? [{ name: order.items, qty: 1 }]
    : [],
  totalAmount: parseInt(order.total) || 0,
  status: order.status || 'pending',
  createdAt: order.createdAt || order._id.getTimestamp()
})

app.get('/api/orders', async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 })
  res.json(orders.map(formatOrder))
})

app.patch('/api/orders/:id/status', async (req, res) => {
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true }  // returnDocument:'after' is Mongoose 6+ syntax; 'new:true' works in all versions
  )
  // Return the same formatted shape as GET /api/orders
  // so the frontend always gets items as an array, never a raw string
  res.json(formatOrder(order))
})

// GET /menu
app.get('/api/menu', async (req, res) => {
  const items = await MenuItem.find()
  res.json(items)
})

// PATCH /menu/:id — toggle available
app.patch('/api/menu/:id', async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(
    req.params.id,
    { available: req.body.available },
    { returnDocument: 'after' }
  )
  res.json(item)
})

// POST /menu — add item
app.post('/api/menu', async (req, res) => {
  const item = new MenuItem({
    name: req.body.name,
    price: req.body.price,
    available: true
  })
  await item.save()
  res.json(item)
})

// DELETE /menu/:id
app.delete('/api/menu/:id', async (req, res) => {
  await MenuItem.findByIdAndDelete(req.params.id)
  res.json({ success: true })
})

app.get('/api/analytics', async (req, res) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const todayOrders = await Order.find({ createdAt: { $gte: today } })
  
  // total field directly number hai — Rs nahi likha
  const totalRevenue = todayOrders.reduce((sum, order) => {
    return sum + (parseInt(order.total) || 0)
  }, 0)

  res.json({
    ordersToday: todayOrders.length,
    revenueToday: totalRevenue,
    mostOrdered: 'Butter Chicken',
    avgOrderValue: todayOrders.length ? Math.round(totalRevenue / todayOrders.length) : 0
  })
})

server.listen(3000, () => {
  console.log('server is running on port 3000')
})