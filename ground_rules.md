# Project Core Architecture: Global Financing Map

You are my coding assistant. This text sets ground rules

Ground rules:
* Change only files in `whofundsit/`, giving me a solid green message before writing a file. Don't touch the `whofundsit/.git` directory.
* When I ask for something, build only that, then stop and report. Write the smallest readable code that does what I asked, but this is waivable. Just don't break things if you don't understand something and need confirmation.
* Don't open `.env`, and never print or log API keys or populated environment values.
* Ignore the files `whofundsit/prompts.md`, it's for documenting our prompts and responses only.

## Architecture Constraints
- Framework: Monorepo containing /frontend (Vite + React + TS) and /backend (Express + Node.js + TS).
- Database: PostgreSQL managed via Prisma ORM.
- Spatial Map Stack: MapLibre GL for the tile background base, Deck.gl for WebGL 3D arcs and node layers.
- Address Engine: Nominatim OpenStreetMap API via caching logic.
- AI Architecture: Webhook-based serverless processing using vLLM on Modal Cloud (Llama 3.1 70B).

## Strict Guardrails & Budget Capping Rules
1. Never run infinite data ingestion loops without an explicit row count ceiling.
2. In-memory rate limiters must gate all outbound API webhooks.
3. Keep frontend map visuals performant by utilizing WebGL layers instead of raw SVG DOM nodes.
4. Separate code from data; strictly exclude raw SEC database downloads or JSON cache files from Git using .gitignore.

## Rules for Git and Commits
- Make git commits as necessary per important change, (usually that's per prompt).
  Use about 80% conformance to ASD-STE100 language in the commit messages for clearness.
