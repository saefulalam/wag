const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys')
const express = require('express')
const axios   = require('axios')
const fs      = require('fs')
const FormData = require('form-data')

const app = express()
app.use(express.json())

// Config dari environment variables Railway
const WEBHOOK_URL  = process.env.WEBHOOK_URL  // https://desa.pablish.name/ai/webhook/receive.php
const GROQ_KEY     = process.env.GROQ_KEY
const MY_NUMBER    = process.env.MY_NUMBER    // 6285770274922
const PORT         = process.env.PORT || 3000

let sock = null

async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,  // scan QR di Railway logs
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue  // skip pesan dari diri sendiri

            const from     = msg.key.remoteJid.replace('@s.whatsapp.net', '')
            const msgType  = Object.keys(msg.message || {})[0]

            console.log(`[MSG] from=${from} type=${msgType}`)

            // Hanya proses dari nomor kamu sendiri
            if (from !== MY_NUMBER) continue

            let messageText = ''
            let audioUrl    = ''
            let isVoice     = false

            // Handle teks biasa
            if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                messageText = msg.message?.conversation
                           || msg.message?.extendedTextMessage?.text
                           || ''
            }

            // Handle voice note (ptt) dan audio
            else if (msgType === 'audioMessage') {
                isVoice = msg.message.audioMessage?.ptt === true
                console.log('[VOICE] Downloading audio...')

                try {
                    // Download audio dari WA
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: console,
                        reuploadRequest: sock.updateMediaMessage
                    })

                    // Simpan sementara
                    const tmpPath = `/tmp/voice_${Date.now()}.ogg`
                    fs.writeFileSync(tmpPath, buffer)
                    console.log(`[VOICE] Saved to ${tmpPath}, size=${buffer.length}`)

                    // Transcribe via Groq Whisper
                    const form = new FormData()
                    form.append('file', fs.createReadStream(tmpPath), {
                        filename: 'voice.ogg',
                        contentType: 'audio/ogg'
                    })
                    form.append('model', 'whisper-large-v3-turbo')
                    form.append('language', 'id')
                    form.append('response_format', 'json')

                    const groqRes = await axios.post(
                        'https://api.groq.com/openai/v1/audio/transcriptions',
                        form,
                        {
                            headers: {
                                ...form.getHeaders(),
                                'Authorization': `Bearer ${GROQ_KEY}`
                            },
                            timeout: 30000
                        }
                    )

                    messageText = groqRes.data?.text || ''
                    console.log(`[VOICE] Transcribed: ${messageText}`)

                    // Hapus file temp
                    fs.unlinkSync(tmpPath)

                } catch (err) {
                    console.error('[VOICE] Error:', err.message)
                    await sock.sendMessage(`${MY_NUMBER}@s.whatsapp.net`, {
                        text: 'Voice note-nya tidak berhasil diproses. Coba ketik aja ya.'
                    })
                    continue
                }
            }

            // Skip tipe lain (gambar, sticker, dll)
            else {
                console.log(`[SKIP] Unsupported type: ${msgType}`)
                continue
            }

            if (!messageText.trim()) continue

            // Forward ke PHP webhook
            try {
                const payload = {
                    sender:    from,
                    pengirim:  from,
                    message:   messageText,
                    pesan:     messageText,
                    type:      isVoice ? 'ptt' : 'text',
                    is_voice:  isVoice,
                    name:      msg.pushName || 'User',
                    timestamp: msg.messageTimestamp,
                    id:        msg.key.id,
                }

                console.log('[WEBHOOK] Sending to PHP:', payload)

                const phpRes = await axios.post(WEBHOOK_URL, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 90000
                })

                console.log('[WEBHOOK] PHP response:', phpRes.data)

            } catch (err) {
                console.error('[WEBHOOK] Error:', err.message)
            }
        }
    })

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) console.log('[QR] Scan QR code di logs Railway!')
        if (connection === 'close') {
            console.log('[WA] Disconnected, reconnecting...')
            setTimeout(connectWA, 5000)
        }
        if (connection === 'open') {
            console.log('[WA] Connected!')
        }
    })
}

// Health check endpoint
app.get('/', (req, res) => res.json({ status: 'ok', connected: !!sock }))

// Endpoint untuk kirim pesan dari PHP
// PHP memanggil ini untuk balas ke user
app.post('/send', async (req, res) => {
    const { to, message, type } = req.body
    if (!sock) return res.status(503).json({ error: 'WA not connected' })

    try {
        const jid = `${to}@s.whatsapp.net`

        if (type === 'ptt' && req.body.audio_base64) {
            // Kirim voice note
            const audioBuffer = Buffer.from(req.body.audio_base64, 'base64')
            await sock.sendMessage(jid, {
                audio: audioBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true  // ptt=true = voice note, bukan file audio biasa
            })
        } else {
            // Kirim teks
            await sock.sendMessage(jid, { text: message })
        }

        res.json({ status: true })
    } catch (err) {
        console.error('[SEND] Error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

app.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`))
connectWA()
