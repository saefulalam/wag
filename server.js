import makeWASocket, { useMultiFileAuthState, downloadMediaMessage, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import axios from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import { createRequire } from 'module'

const app = express()
app.use(express.json())

const WEBHOOK_URL = process.env.WEBHOOK_URL
const GROQ_KEY    = process.env.GROQ_KEY
const MY_NUMBER   = process.env.MY_NUMBER
const PORT        = process.env.PORT || 3000

let sock = null

async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['AI Assistant', 'Chrome', '1.0.0'],
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) console.log('[QR] Scan QR ini di WhatsApp kamu!')
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = code !== DisconnectReason.loggedOut
            console.log(`[WA] Disconnected (code=${code}), reconnect=${shouldReconnect}`)
            if (shouldReconnect) setTimeout(connectWA, 5000)
        }
        if (connection === 'open') console.log('[WA] Connected!')
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (msg.key.fromMe) continue

            const from    = msg.key.remoteJid?.replace('@s.whatsapp.net', '') ?? ''
            const msgType = Object.keys(msg.message || {})[0] ?? ''

            console.log(`[MSG] from=${from} type=${msgType}`)

            if (from !== MY_NUMBER) continue

            let messageText = ''
            let isVoice     = false

            // Teks biasa
            if (msgType === 'conversation') {
                messageText = msg.message.conversation
            } else if (msgType === 'extendedTextMessage') {
                messageText = msg.message.extendedTextMessage?.text ?? ''

            // Voice note
            } else if (msgType === 'audioMessage') {
                isVoice = msg.message.audioMessage?.ptt === true
                console.log('[VOICE] Downloading...')

                try {
                    const buffer  = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: { level: 'silent', trace(){}, debug(){}, info(){}, warn(){}, error: console.error, child(){ return this } },
                        reuploadRequest: sock.updateMediaMessage
                    })

                    const tmpPath = `/tmp/voice_${Date.now()}.ogg`
                    fs.writeFileSync(tmpPath, buffer)
                    console.log(`[VOICE] Downloaded ${buffer.length} bytes`)

                    // Transcribe Groq
                    const form = new FormData()
                    form.append('file', fs.createReadStream(tmpPath), { filename: 'voice.ogg', contentType: 'audio/ogg' })
                    form.append('model', 'whisper-large-v3-turbo')
                    form.append('language', 'id')
                    form.append('response_format', 'json')

                    const groqRes = await axios.post(
                        'https://api.groq.com/openai/v1/audio/transcriptions',
                        form,
                        { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_KEY}` }, timeout: 30000 }
                    )

                    messageText = groqRes.data?.text ?? ''
                    console.log(`[VOICE] Transcribed: ${messageText}`)
                    fs.unlinkSync(tmpPath)

                } catch (err) {
                    console.error('[VOICE] Error:', err.message)
                    await sock.sendMessage(`${MY_NUMBER}@s.whatsapp.net`, {
                        text: 'Voice note tidak berhasil diproses. Coba ketik aja ya.'
                    })
                    continue
                }

            } else {
                console.log(`[SKIP] type=${msgType}`)
                continue
            }

            if (!messageText.trim()) continue

            // Forward ke PHP
            try {
                const res = await axios.post(WEBHOOK_URL, {
                    sender:    from,
                    pengirim:  from,
                    message:   messageText,
                    pesan:     messageText,
                    type:      isVoice ? 'ptt' : 'text',
                    is_voice:  isVoice,
                    name:      msg.pushName ?? 'User',
                    timestamp: msg.messageTimestamp,
                    id:        msg.key.id,
                }, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 })

                console.log('[WEBHOOK] PHP:', res.data)
            } catch (err) {
                console.error('[WEBHOOK] Error:', err.message)
            }
        }
    })
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', connected: !!sock }))

// Endpoint kirim pesan dari PHP
app.post('/send', async (req, res) => {
    const { to, message, type, audio_base64 } = req.body
    if (!sock) return res.status(503).json({ error: 'WA not connected' })

    try {
        const jid = `${to}@s.whatsapp.net`

        if (type === 'ptt' && audio_base64) {
            await sock.sendMessage(jid, {
                audio: Buffer.from(audio_base64, 'base64'),
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            })
        } else {
            await sock.sendMessage(jid, { text: message })
        }

        res.json({ status: true })
    } catch (err) {
        console.error('[SEND]', err.message)
        res.status(500).json({ error: err.message })
    }
})

app.listen(PORT, () => console.log(`[SERVER] Port ${PORT}`))
connectWA()
