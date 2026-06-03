require('dotenv').config()
const express = require('express')
const Groq = require('groq-sdk')

const app = express()
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const menu = `
Sharma's Kitchen Menu:
- Butter Chicken - Rs 280
- Paneer Tikka - Rs 240
- Dal Makhani - Rs 180
- Naan - Rs 40
- Rice - Rs 60
- Lassi - Rs 80
`

const sessions = {}

app.post('/webhook', async (req, res) => {
  const message = req.body.Body
  const from = req.body.From

  if (!sessions[from]) {
    sessions[from] = { messages: [] }
  }

  sessions[from].messages.push({
    role: 'user',
    content: message
  })

  console.log(`Message from ${from}: ${message}`)

  const aiReply = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You are a friendly ordering assistant for Sharma's Kitchen.
${menu}
Rules:
- Greet customers warmly
- Take their order and remember it throughout conversation
- If customer changes item, update the order
- When customer confirms, show final order with total
- Reply in Hinglish
- Keep replies short and friendly
- Add food emojis`
      },
      ...sessions[from].messages
    ]
  })

  const reply = aiReply.choices[0].message.content

  sessions[from].messages.push({
    role: 'assistant',
    content: reply
  })

  console.log(`AI Reply: ${reply}`)

  res.set('Content-Type', 'text/xml')
  res.send(`<Response><Message>${reply}</Message></Response>`)
})

app.listen(3000, () => {
  console.log('Server chal raha hai port 3000 pe')
})