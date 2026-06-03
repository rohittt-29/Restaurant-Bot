# WhatsApp AI Restaurant Ordering Bot 🍽️

## What is this?
An AI-powered WhatsApp bot that automatically 
takes food orders for restaurants.

## Tech Stack
- Node.js + Express
- Groq AI (Llama 3.3)
- Twilio WhatsApp API

## How it works
Customer messages on WhatsApp →
Twilio receives it →
Groq AI understands the order (Hindi/Hinglish) →
Reply sent back to customer

## What is Session State and why did I build it?
Without session state, the bot forgot everything 
after each message. I built a sessions object where 
each customer's WhatsApp number is the key and their 
full conversation history is the value. Now the bot 
remembers what was ordered, what was changed, 
and confirms the correct final order.


