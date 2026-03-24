import express from 'express'
import axios from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import { createRequire } from 'module'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { webcrypto } from 'node:crypto'

// Polyfill untuk Node < 19 agar crypto tersedia secara global (dibutuhkan Baileys)
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto
}

const require = createRequire(import.meta.url)
const qrcode = require('qrcode-terminal')

const app = express()
app.use(express.json())

const WEBHOOK_URL = process.env.WEBHOOK_URL
const GROQ_KEY = process.env.GROQ_KEY
const MY_NUMBER = process.env.MY_NUMBER
// Global Error Handlers untuk mencegah crash tanpa log
process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught Exception:', err.message)
    console.error(err.stack)
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH] Unhandled Rejection at:', promise, 'reason:', reason)
})

const PORT = process.env.PORT || 8080
const CLEAR_AUTH = process.env.CLEAR_AUTH === 'true'
console.log(`[INIT] Deployment Fingerprint: v${Date.now()}`)
console.log(`[INIT] Port used: ${PORT} (${process.env.PORT ? 'from PORT env var' : 'default fallback'})`)
console.log(`[INIT] Webhook URL: ${WEBHOOK_URL ? 'Set' : 'NOT SET'}`)

if (CLEAR_AUTH && fs.existsSync('./auth')) {
    try {
        fs.rmSync('./auth', { recursive: true, force: true })
        console.log('[AUTH] Cleared')
    } catch (e) {
        console.error('[AUTH] Failed to clear:', e.message)
    }
}

let sock = null
let lastQR = null
let connected = false
let retries = 0

// Start HTTP server - EXPLICIT bind to 0.0.0.0 untuk Railway
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Listening on 0.0.0.0:${PORT}`)
})

server.on('error', (err) => {
    console.error('[HTTP] Server error:', err.message)
})

// Endpoints - Health Check for Railway
app.get('/', (_, res) => {
    res.status(200).json({
        status: 'online',
        connected,
        has_qr: !!lastQR,
        retries,
        timestamp: new Date().toISOString()
    })
})

app.get('/qr', (req, res) => {
    if (!lastQR) {
        return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2>${connected ? '✅ Connected!' : `⏳ Connecting... (retry ${retries})`}</h2>
            <script>setTimeout(()=>location.reload(),5000)</script>
        </body></html>`)
    }
    qrcode.generate(lastQR, { small: false }, qrStr => {
        res.send(`<html><body style="font-family:monospace;padding:20px">
            <h3>Scan dengan WhatsApp → Linked Devices</h3>
            <pre style="font-size:9px;line-height:1.1">${qrStr}</pre>
            <script>setTimeout(()=>location.reload(),20000)</script>
        </body></html>`)
    })
})

app.post('/send', async (req, res) => {
    if (!sock || !connected) return res.status(503).json({ error: 'not connected' })
    const { to, message, type, audio_base64 } = req.body
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
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// Connect WA setelah HTTP server ready
async function connectWA() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth')
        let version = [2, 3000, 1015901307] // Versi fallback yang sangat stabil
        try {
            const v = await fetchLatestBaileysVersion()
            version = v.version
            console.log(`[WA] Using Baileys v${version.join('.')}, isLatest: ${v.isLatest}`)
        } catch (e) {
            console.warn('[WA] Version fetch failed, using fallback:', version.join('.'))
        }

        sock = makeWASocket({
            auth: state,
            version,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            logger: { level: 'silent', trace() { }, debug() { }, info() { }, warn() { }, error: console.error, child() { return this } },
            markOnlineOnConnect: false
        })
        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                lastQR = qr
                console.log('[QR] Ready — open /qr')
                qrcode.generate(qr, { small: true })
            }
            if (connection === 'open') {
                connected = true; lastQR = null; retries = 0
                console.log('[WA] Connected!')
            }
            if (connection === 'close') {
                connected = false
                const code = lastDisconnect?.error?.output?.statusCode
                const reason = lastDisconnect?.error?.message || 'Unknown'
                console.log(`[WA] Closed code=${code} | Reason: ${reason}`)
                if (lastDisconnect?.error) {
                    console.dir(lastDisconnect.error, { depth: null }) // Log objek error lengkap untuk debugging
                }

                // Menangani session invalid/logout (401, 403, 405 dll)
                const shouldClear = [
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    401, 405, 411, 500
                ].includes(code)

                if (shouldClear) {
                    console.warn('[WA] Session invalid, clearing auth directory...')
                    if (fs.existsSync('./auth')) {
                        try {
                            fs.rmSync('./auth', { recursive: true, force: true })
                        } catch (e) { console.error('[AUTH] Clear failed:', e.message) }
                    }
                }
                retries++
                const delay = Math.min(retries * 10000, 60000)
                console.log(`[WA] Retry in ${delay}ms`)
                setTimeout(connectWA, delay)
            }
        })

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return
            for (const msg of messages) {
                if (msg.key.fromMe) continue
                const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') ?? ''
                const msgType = Object.keys(msg.message || {})[0] ?? ''
                if (from !== MY_NUMBER) continue

                let text = ''
                let isVoice = false

                if (msgType === 'conversation') text = msg.message.conversation
                else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text ?? ''
                else if (msgType === 'audioMessage') {
                    isVoice = !!msg.message.audioMessage?.ptt
                    try {
                        const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                            logger: { level: 'silent', trace() { }, debug() { }, info() { }, warn() { }, error: console.error, child() { return this } },
                            reuploadRequest: sock.updateMediaMessage
                        })
                        const tmp = `/tmp/v_${Date.now()}.ogg`
                        fs.writeFileSync(tmp, buf)
                        const fd = new FormData()
                        fd.append('file', fs.createReadStream(tmp), { filename: 'v.ogg', contentType: 'audio/ogg' })
                        fd.append('model', 'whisper-large-v3-turbo')
                        fd.append('language', 'id')
                        fd.append('response_format', 'json')
                        const r = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', fd, {
                            headers: { ...fd.getHeaders(), Authorization: `Bearer ${GROQ_KEY}` }, timeout: 30000
                        })
                        text = r.data?.text ?? ''
                        fs.unlinkSync(tmp)
                        console.log(`[VOICE] ${text}`)
                    } catch (e) {
                        console.error('[VOICE]', e.message)
                        await sock.sendMessage(`${MY_NUMBER}@s.whatsapp.net`, { text: 'Voice note gagal diproses, ketik aja ya.' })
                        continue
                    }
                } else continue

                if (!text.trim()) continue

                try {
                    const r = await axios.post(WEBHOOK_URL, {
                        sender: from, pengirim: from, message: text, pesan: text,
                        type: isVoice ? 'ptt' : 'text', is_voice: isVoice,
                        name: msg.pushName ?? '', timestamp: msg.messageTimestamp, id: msg.key.id
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 })
                    console.log('[WEBHOOK]', r.data)
                } catch (e) { console.error('[WEBHOOK]', e.message) }
            }
        })

    } catch (e) {
        console.error('[CONNECT]', e.message)
        retries++
        setTimeout(connectWA, Math.min(retries * 10000, 60000))
    }
}

// Delay 2 detik setelah HTTP ready baru connect WA
setTimeout(connectWA, 2000)
