# WhatsApp Pro Suite (Local-First Edition)

A high-performance, private, **Local-First WhatsApp Marketing & Automation Suite** featuring a local SQLite database, durable background campaign queue, clean messaging transport abstraction with safe Development Simulation mode, and 100% free offline AI via **Ollama**.

---

## 🏗️ Architecture Overview

The system operates strictly on your local PC with zero cloud AI dependencies and zero paid third-party messaging gateway lock-in:

```
Existing Dashboard (Web UI @ http://localhost:3000)
       ↓
Local Backend (Node.js HTTP Server)
       ↓
Local Database (SQLite @ ./data/app.db)
       ↓
Campaign Queue Worker (Durable, Atomic, Survives Restarts)
       ↓
Messaging Transport Abstraction (Development Simulator Mode)
       ↓
Local AI Engine (Ollama @ http://localhost:11434 with llama3.2:3b)
```

---

## ✨ Core Capabilities

### 1. Zero External Gateway Dependencies
- **GREEN-API has been completely removed** from all layers of this application.
- No third-party gateway credentials, tokens, or cloud quotas are required to run, test, or manage campaigns.

### 2. Local SQLite Database
- Runs on native SQLite (`./data/app.db`) using Node.js built-in `node:sqlite`.
- Stores:
  - **`contacts`**: Names, normalized phone numbers (E.164), company, tags, creation timestamp.
  - **`campaigns`**: Name, message template, attachments, status (`DRAFT`, `READY`, `RUNNING`, `PAUSED`, `COMPLETED`, `CANCELLED`).
  - **`messages`**: Record of all sent / simulated messages with delivery status.
  - **`message_queue`**: Persistent queue items (`PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `SKIPPED`) with atomic locking.
  - **`message_logs`**: Detailed timestamped execution logs for auditing.
  - **`settings`**: Dynamic key-value configuration (`messaging_mode`, `send_delay_ms`, `ollama_url`, `ollama_model`).

### 3. Safe Development Mode (Simulated Sending)
- Environment variable: `MESSAGING_MODE=development`
- **NO REAL WHATSAPP MESSAGES ARE SENT** in development mode.
- Simulates network delivery with realistic delays, logs simulated delivery (`SIMULATED_SUCCESS`), records message IDs in SQLite, and updates UI progress monitors in real-time.
- Test campaigns, pause/resume, cancellations, personalization, and error handling safely.

### 4. Pluggable Transport Abstraction
- Defined in `services/messaging/`:
  - `provider.js`: Base abstract `MessagingProvider` class (`connect()`, `disconnect()`, `getStatus()`, `sendText()`, `sendMedia()`).
  - `development.js`: Development simulator provider.
  - `index.js`: Transport factory resolving active provider.
- Any authorized, compliant messaging connection can be plugged in later without altering the campaign or queue system.

### 5. Dual WhatsApp Login Methods (All Countries Supported)
- Direct WhatsApp Multi-Device connection with **zero external paid gateways**.
- **Phone Number Login (Pairing Code)**:
  - Enter any phone number with country code from around the world (USA +1, UK +44, India +91, Canada +1, UAE +971, Saudi Arabia +966, Nigeria +234, Pakistan +92, Germany +49, and 150+ more).
  - Generates an 8-character pairing code (e.g. `ABCD-EFGH`).
  - Confirm directly in WhatsApp: **Settings / ⋮ Menu** → **Linked Devices** → **Link a Device** → **Link with phone number instead**.
  - Automatically establishes real WhatsApp session without camera/QR scanning.
- **QR Code Scan**:
  - Point your phone camera at the on-screen QR code to link instantly.
- **Auto-Reconnect & Multi-Device Sync**:
  - Preserves authenticated session securely in `./data/baileys_auth/`.
  - Reconnects automatically on server reboot.

### 6. Local Offline AI Engine (Ollama)
- Powered by local Ollama (`http://localhost:11434`).
- Default model: `llama3.2:3b` (configurable via `.env` or from the Settings UI).
- Features:
  - **AI Message Generator** with tone presets (Promotional, Professional, Friendly, Short, Informational, Custom).
  - **Smart Rewrite** (Shorter, Clearer, Professional, Friendly, Fix grammar, Alternative hook).
  - **Message Variations** (3 versions for A/B testing).
  - **Campaign Strategy Assistant** (Full campaign copy + tags kit).
  - **Dynamic Personalization** (`{name}`, `{company}`, `{product}` client-side substitution).
  - **Contact Data Sanitation & Cleanup** (E.164 formatting, duplicate removal, dummy number filtering).

---

## 🚀 Quick Start Guide (Windows)

### Prerequisites
1. **Node.js**: Version 22.0.0 or higher (Run `node -v` to check).
2. **Ollama**: For local offline AI features.

---

### Step 1: Install & Start Ollama

#### Install Ollama on Windows
Open PowerShell and run:
```powershell
winget install Ollama.Ollama
```
*(Or download the Windows installer from [https://ollama.com/download/windows](https://ollama.com/download/windows))*

#### Start the Ollama Service
```powershell
ollama serve
```

#### Pull the Recommended Lightweight Model
```powershell
ollama run llama3.2:3b
```
*(Once downloaded, it runs 100% offline without internet access).*

---

### Step 2: Install Project Dependencies

From the project root directory, run:
```powershell
npm install
```

---

### Step 3: Configure Environment Variables

The project includes an `.env` file pre-configured for local operation:
```env
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.2:3b"
DATABASE_URL="sqlite:///./data/app.db"
MESSAGING_MODE="development"
PORT=3000
```

---

### Step 4: Start the Application

Launch the local server:
```powershell
npm start
```
*(or `node server.js`)*

---

### Step 5: Open the Dashboard

Open your web browser and navigate to:
```
http://localhost:3000/
```

You will see:
- **Bulk Dispatcher**: Create campaigns, set throttle delays, monitor live queue progress.
- **AI Assistant**: Generate, rewrite, and synthesize campaign copy with your local Ollama model.
- **Chats & Inbox**: Browse local message history and test quick simulated replies.
- **Number Validator**: Validate phone numbers locally against international E.164 specifications.
- **Local System Settings**: Review SQLite database health, Ollama status, and development mode metrics.

---

## 📡 REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Health check returning status of app, database, AI, and messaging mode |
| `/api/stats` | `GET` | Aggregate stats: contacts, campaigns, sent, queued, pending, failed |
| `/api/settings` | `GET`, `POST` | Get or update local settings |
| `/api/campaigns` | `GET`, `POST` | List campaigns or launch a new campaign into the local SQLite queue |
| `/api/campaigns/:id/queue` | `GET` | Retrieve queue items and live delivery status for a campaign |
| `/api/campaigns/:id/cancel`| `POST` | Cancel pending jobs in an active campaign |
| `/api/validate-numbers` | `POST` | Local offline E.164 phone number validator and formatter |
| `/api/contacts/import` | `POST` | Bulk contact cleaner and importer into local SQLite database |
| `/api/chats` | `GET` | List recent conversation threads from local database |
| `/api/chats/send` | `POST` | Send a single message through the active transport |
| `/api/ai/status` | `GET` | Check if local Ollama server is reachable |
| `/api/ai/models` | `GET` | List all local models downloaded on host PC |
| `/api/ai/generate` | `POST` | Generate WhatsApp message from parameters |
| `/api/ai/rewrite` | `POST` | Rewrite existing message using selected tone/objective |
| `/api/ai/variations` | `POST` | Generate 3 distinct message variations for A/B testing |
| `/api/ai/personalize` | `POST` | Substitute placeholders with contact data locally |
| `/api/ai/cleanup-contacts` | `POST`| Normalize numbers, deduplicate, and filter malformed inputs |
| `/api/ai/campaign-assistant` | `POST`| Generate full campaign kit |
| `/api/whatsapp/status` | `GET` | Get current WhatsApp Multi-Device connection status, QR, and pairing code |
| `/api/whatsapp/connect` | `POST` | Initialize WhatsApp connection or force fresh QR generation |
| `/api/whatsapp/pair-phone` | `POST` | Request an 8-character Pairing Code for any world phone number |
| `/api/whatsapp/disconnect` | `POST` | Disconnect WhatsApp Multi-Device session and clear auth files |

---

## 🔒 Privacy & Safety Guarantee

- **No Cloud AI APIs:** All prompts and generated copies stay on `localhost:11434`.
- **No Data Leakage:** Contact lists and phone numbers are stored strictly in local `./data/app.db` and never transmitted to external servers.
- **Compliance:** Operates strictly with authorized, compliant transport abstractions. Does not attempt anti-spam evasion or scraping.

---

## 📄 License
MIT License.
