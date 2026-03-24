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
// QR Code no longer needs local package for terminal

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

const PORT = process.env.PORT || 3000
const CLEAR_AUTH = process.env.CLEAR_AUTH === 'true'
console.log(`[INIT] --- DEBUG MODE ---`)
console.log(`[INIT] Port: ${PORT}`)
console.log(`[INIT] Webhook: ${WEBHOOK_URL ? 'Set' : 'NOT SET'}`)

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
            <h2>${connected ? '✅ Terhubung!' : `⏳ Menghubungkan... (tunggu sebentar)`}</h2>
            <p>Jika sudah terhubung, Anda tidak perlu scan lagi.</p>
            <script>setTimeout(()=>location.reload(),5000)</script>
        </body></html>`)
    }
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQR)}`
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h3>Pindai QR ini di WhatsApp</h3>
        <p>Settings > Linked Devices > Link a Device</p>
        <div style="margin:20px 0;">
            <img src="${qrApiUrl}" alt="QR Code" style="border:10px solid white; box-shadow:0 0 10px rgba(0,0,0,0.1);">
        </div>
        <p>Halaman ini akan refresh otomatis saat tersambung.</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`)
})

app.post('/send', async (req, res) => {
    if (!sock || !connected) return res.status(503).json({ error: 'not connected' })
    const { to, message, type, audio_base64 } = req.body
    try {
        const jid = `${to}@s.whatsapp.net`
        if (type === 'ptt') {
            const audioData = audio_base64
                ? { audio: Buffer.from(audio_base64, 'base64') }
                : { audio: { url: req.body.url } }
            await sock.sendMessage(jid, {
                ...audioData,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            })
        } else if (type === 'image') {
            const imageData = req.body.image_base64
                ? { image: Buffer.from(req.body.image_base64, 'base64') }
                : { image: { url: req.body.url } }
            await sock.sendMessage(jid, { ...imageData, caption: message })
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
            browser: ['Desktop', 'Chrome', '124.0.6367.60'], // Versi Chrome terbaru (April 2024)
            logger: { level: 'silent', trace() { }, debug() { }, info() { }, warn() { }, error: console.error, child() { return this } },
            markOnlineOnConnect: false,
            linkPreviewImageThumbnailWidth: 192,
            shouldSyncHistoryMessage: () => false // Mempercepat koneksi awal
        })
        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                lastQR = qr
                console.log('[QR] Update: Silakan akses domain Anda di link /qr untuk pindai.')
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
            console.log(`[EVENT] messages.upsert | type=${type} | count=${messages.length}`)
            if (type !== 'notify') return
            for (const msg of messages) {
                // Jangan abaikan fromMe jika user chat ke diri sendiri
                const fromRaw = msg.key.remoteJid ?? ''
                const fromMe = msg.key.fromMe
                const from = fromRaw.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '')

                const myID = sock.user?.id?.split(':')[0]?.split('@')[0] ?? ''
                const myLid = sock.user?.lid?.split('@')[0] ?? ''

                const msgType = Object.keys(msg.message || {})[0] ?? ''
                console.log(`[MSG] Dari: ${fromRaw} (Me: ${fromMe}) | Tipe: ${msgType}`)

                // Normalisasi nomor MY_NUMBER (hanya angka)
                const myNumberClean = MY_NUMBER.replace(/[^0-9]/g, '')
                const fromNumberClean = from.replace(/[^0-9]/g, '')

                // Syarat: Pengirim adalah owner (berdasarkan nomor HP, LID, atau self-chat)
                const ownerLid = process.env.OWNER_LID ?? ''
                const isOwner = (fromNumberClean === myNumberClean) ||
                    (from === myID) ||
                    (from === myLid) ||
                    (from === ownerLid) ||
                    (fromRaw === MY_NUMBER);

                if (!isOwner) {
                    console.log(`[MSG] Diabaikan: ${from} bukan Owner (${myNumberClean}/${myID}/${myLid}/${ownerLid})`)
                    continue
                }

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
                    // Gunakan nomor HP asli untuk Webhook jika pengirim adalah owner (biar PHP tidak bingung dengan LID)
                    const webhookSender = isOwner ? MY_NUMBER : from;

                    const r = await axios.post(WEBHOOK_URL, {
                        sender: webhookSender, pengirim: webhookSender, message: text, pesan: text,
                        type: isVoice ? 'ptt' : 'text', is_voice: isVoice,
                        name: msg.pushName ?? '', timestamp: msg.messageTimestamp, id: msg.key.id
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 })
                    console.log(`[WEBHOOK] Success to ${webhookSender}:`, JSON.stringify(r.data))
                } catch (e) {
                    console.error('[WEBHOOK] Error:', e.message)
                    if (e.response) console.error('[WEBHOOK] Response Status:', e.response.status)
                }
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
