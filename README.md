# Inventory Portal

A local-first electronics component inventory for Mac and iPhone. Catalog boards, sensors, displays, tools, and parts; attach photos; track stock and storage; and optionally use OpenAI to suggest identification from photos.

## Quick start (Mac)

1. Install **Docker Desktop** for Mac and launch it.
2. Unzip this project and open Terminal in the `inventory-portal` directory.
3. Run `docker compose up --build -d`.
4. Open **http://localhost:8000** on your Mac.

Your inventory and uploaded images persist in `./data/`, even when the container is recreated. Back up this directory regularly. The application starts empty; no sample records are added.

## Optional AI identification

Copy `.env.example` to `.env`, set `OPENAI_API_KEY=your_key`, then run `docker compose up -d --force-recreate`. An OpenAI API key is billed separately from ChatGPT subscriptions. Photos submitted using **Identify with AI** are sent to the configured model; ordinary photo uploads stay local. The app currently accepts JPEG, PNG and WebP for AI identification; iPhone HEIC photos can be stored but must be converted before AI identification.

AI identification is advisory and may be inaccurate. Always verify part markings and electrical specifications against manufacturer documentation before wiring components.

## Access from iPhone

For the initial version, the Docker port is bound to Mac localhost for safety. For iPhone access on the same Wi-Fi, change the Compose port mapping from `127.0.0.1:8000:8000` to `8000:8000`, restart with `docker compose up -d`, and visit `http://YOUR_MAC_LAN_IP:8000` from the iPhone. **This version has no login**, so only do this on a trusted private network. Do not forward the port to the public internet.

For secure access away from home, use Tailscale on both devices and enable Tailscale Serve to expose the local service privately over HTTPS. Consult current Tailscale documentation for the Serve command for your version. Do not enable Funnel (public access). The Mac must remain on and connected.

## Features

- Responsive dashboard with stock counts and low-stock alerts
- Search by name, model, manufacturer, project, or notes
- Filter by category and storage location
- Add, edit, delete component records
- Attach photos (max 10 MB each)
- Optional AI image identification with uncertainty disclosure
- CSV export
- Persistent SQLite database and local photo storage
- Built-in API docs at `/api/docs`

## Architecture

FastAPI + SQLite + HTML/CSS/JavaScript, packaged in one Docker container. SQLite keeps the first Mac-only version easy to install, back up, and maintain. The API and database access are separated enough to migrate to PostgreSQL and a cloud deployment later.

## Security and limitations

- **No authentication yet.** Keep bound to localhost unless using a trusted private network or properly secured private tunnel.
- No multi-user access, cloud sync, QR printing, BOM comparison, or purchase-order tracking yet.
- Images are stored locally and retained when component records are deleted; clean unused images manually if needed.
- For backups, stop the container (`docker compose stop`) before copying `data/` to avoid an inconsistent SQLite copy, then restart (`docker compose start`).
- The AI API requires a separately provisioned key and network access.
