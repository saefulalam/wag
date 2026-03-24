<?php
// core/WAGateway.php — gantikan FonnteGateway.php
// Kirim pesan lewat Railway/Render WA-Web.js

class FonnteGateway {  // nama sama agar tidak perlu ubah receive.php

    public static function send(string $target, string $message): bool {
        $target = preg_replace('/[^0-9]/', '', $target);

        $ch = curl_init(RAILWAY_URL . '/send');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode([
                'to'      => $target,
                'message' => $message,
                'type'    => 'text',
            ]),
        ]);

        $result  = curl_exec($ch);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($curlErr) { logError("WAGateway send error: $curlErr"); return false; }

        $data = json_decode($result, true);
        return ($data['status'] ?? false) === true;
    }

    public static function sendVoiceNote(string $target, string $audioBase64): bool {
        $target = preg_replace('/[^0-9]/', '', $target);

        $ch = curl_init(RAILWAY_URL . '/send');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode([
                'to'           => $target,
                'type'         => 'ptt',
                'audio_base64' => $audioBase64,
            ]),
        ]);

        $result  = curl_exec($ch);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($curlErr) { logError("WAGateway voice error: $curlErr"); return false; }

        $data = json_decode($result, true);
        return ($data['status'] ?? false) === true;
    }

    // Kompatibel dengan receive.php lama
    public static function parseWebhook(): ?array {
        $raw  = file_get_contents('php://input');
        $data = json_decode($raw, true) ?: $_POST;

        file_put_contents(
            __DIR__ . '/../incoming.log',
            date('Y-m-d H:i:s') . " | $raw\n---\n",
            FILE_APPEND
        );

        $senderRaw = $data['sender']  ?? $data['pengirim'] ?? '';
        $message   = $data['message'] ?? $data['pesan']    ?? '';

        if (empty($senderRaw) || empty($message)) return null;

        $norm        = fn(string $n) => preg_replace('/^0/', '62', preg_replace('/[^0-9]/', '', $n));
        $senderClean = $norm($senderRaw);
        $myWaClean   = $norm(MY_WA);

        if ($senderClean !== $myWaClean) return null;

        return [
            'sender'   => $senderClean,
            'message'  => trim($message),
            'is_voice' => $data['is_voice'] ?? false,
            'type'     => $data['type'] ?? 'text',
        ];
    }
}
