# PalPluss M-Pesa STK Push Integration

A lightweight Node.js Express server and responsive web interface to initiate and track **M-Pesa STK Push (Lipa Na M-Pesa Online)** payments using the **PalPluss API**.

---

## 🚀 Features

- **Simple Web UI**: Enter a phone number, select/enter amount, and send STK Push prompt.
- **Phone Formatting**: Automatically cleans and normalizes Kenyan phone numbers (`07...`, `01...`, `+254...` $\to$ `254XXXXXXXXX`).
- **Live Status Polling**: Tracks the transaction in real time from "Dispatched" to "Awaiting PIN" to "Confirmed/Failed".
- **Webhook Callback Handler**: Receives asynchronous payment confirmations from PalPluss.
- **Recent Activity Log**: Shows recent transaction history with status badges and M-Pesa receipts.

---

## 📁 Project Structure

```
.
├── server.js            # Express server (STK Push API, Webhook listener, Status endpoint)
├── db.js                # SQLite schema, migrations, and persistence
├── public/
│   └── index.html       # Responsive frontend interface
├── data/lycash.db       # SQLite database (created automatically; ignored by git)
├── .env                 # Your PalPluss credentials (API key, Channel ID, Port)
├── .env.example         # Template for environment variables
├── package.json
└── README.md
```

---

## 🛠️ Setup & Configuration

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Credentials in `.env`
Open the `.env` file in the project root and add your PalPluss API key:

```env
# Your PalPluss API Key (pk_live_... or pk_test_...)
PALPLUSS_API_KEY=pk_test_your_actual_key_here

# (Optional) Specific Channel ID (Paybill or Till). Leave blank to use account default.
PALPLUSS_CHANNEL_ID=

# Server Port
PORT=3000

# (Optional) Public URL for Webhooks / Callbacks
CALLBACK_URL=
```

> **Note:** The integration uses PalPluss's documented `/v1/payments/stk` endpoint. A configured channel ID is passed as a request field; no undocumented channel-specific endpoint is assumed.

Set `CALLBACK_SECRET` when possible. Requests to `/api/callback` must then include
`x-palpluss-callback-secret` (or a bearer token) with that value.

---

## 🏃 Running the Application

### Start the server:
```bash
npm start
```

For development mode with auto-reload:
```bash
npm run dev
```

Then open your browser and navigate to:
```
http://localhost:3000
```

---

## 🌐 Testing Webhooks / Callbacks (Optional)

When a customer enters their PIN on their phone, PalPluss sends an asynchronous `POST` notification to your `callbackUrl`.

To test this locally:

1. Start **ngrok** (or localtunnel):
   ```bash
   ngrok http 3000
   ```
2. Copy the forwarding URL and update your `.env`:
   ```env
   CALLBACK_URL=https://your-subdomain.ngrok-free.app/api/callback
   ```
3. Restart the server. PalPluss will now post payment confirmations directly to your local server!

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/stk-push` | Initiates an STK push prompt to customer phone |
| `POST` | `/api/callback` | Webhook endpoint for PalPluss payment results |
| `GET` | `/api/status/:id` | Polls the status of a specific transaction |
| `GET` | `/api/transactions` | Returns the list of recent transactions |
| `GET` | `/api/config-check` | Returns API key status for the UI |
