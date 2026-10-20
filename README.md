# WUK AI by Wuk72

WUK AI is a local-first Expo assistant. It keeps conversation history and notes on the phone, supports date/time commands and text-to-speech offline, and sends open-ended questions to the authenticated backend. The server can use configured Gemini, OpenAI, Claude, Groq, OpenRouter, Cloudflare Workers AI, and Mistral API providers. The app never treats a canned response as an AI answer.

## Project details

- User-facing name: **WUK AI** · creator: **Wuk72**
- Expo SDK 57 · React Native 0.86
- Android application ID: `com.wuk72.wukai`
- Existing project folder: `JarvisAssistant`
- Existing backend: `https://wuk-ai.onrender.com`; Cloudflare Worker deployment instructions are below.

## Start the app

In PowerShell:

```powershell
Set-Location 'C:\Users\admin\OneDrive\Desktop\project\JarvisAssistant'
npm install
npx expo start --lan
```

Connect the phone and computer to the same Wi-Fi, open Expo Go that supports SDK 57, and scan the QR code. If Windows asks, permit the development server on private networks. The root `.env` contains only the public backend URL; the Gemini key is not used by the mobile app.

## Run or export the web app

The same Expo app also supports the browser. Run `npx expo start --web` for development or `npm run build:web` for a static production bundle in `dist/`. Cloudflare Pages can host this website; the API runs separately as a Cloudflare Worker. Browser speech input depends on browser support and microphone permission; native Android speech input still requires a development or production build.

## Publish the website and API on GitHub and Cloudflare

This repository is already a GitHub repository (`prince-0110/WUK-AI`) with the `origin` remote configured. The commands below save the current changes and push them to its `main` branch. Review `git status` before committing; `.env` and backend secrets are ignored by Git.

```powershell
Set-Location 'C:\Users\admin\OneDrive\Desktop\project\JarvisAssistant'
git status
git add .
git commit -m "Prepare WUK AI for Cloudflare deployment"
git push origin main
```

### Deploy the API Worker

The existing Express routes and multi-provider logic are reused by `backend/worker.js`. From PowerShell, authenticate Wrangler and deploy the Worker:

```powershell
Set-Location 'C:\Users\admin\OneDrive\Desktop\project\JarvisAssistant\backend'
npm ci
npx wrangler login
npm run deploy
```

Wrangler prints the Worker URL, usually `https://wuk-ai-api.<your-account>.workers.dev`. Add the backend secrets through Wrangler's prompts; enter only keys you actually use. Never commit these values or place them in the Expo website build variables.

```powershell
npx wrangler secret put API_ACCESS_PASSWORD
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put CLOUDFLARE_WORKERS_AI_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put WEB_ORIGINS
```

`API_ACCESS_PASSWORD` is a private passphrase of at least 12 characters. Set it in the backend and enter the same password in WUK AI settings; avoid short PINs because the Worker is public. Provider keys are optional; add only the ones enabled for your account. For the Cloudflare Workers AI provider, create a narrowly scoped token with **Workers AI – Read** and **Workers AI – Edit**, and also set the account ID. Store its model API token under `CLOUDFLARE_WORKERS_AI_API_TOKEN`; Wrangler reserves `CLOUDFLARE_API_TOKEN` for deployment authentication. `WEB_ORIGINS` is the exact Pages website origin (for example `https://wuk-ai.pages.dev`), with no trailing slash. If you change the site domain later, update this secret and redeploy the Worker.

The Worker configuration enables the Cloudflare Node.js compatibility needed for Express. Worker memory is temporary and not shared across all Cloudflare locations; for production-wide request quotas, configure Cloudflare rate-limiting rules in the dashboard as well as the backend's per-instance request limits.

### Deploy the website with Pages

1. In Cloudflare, open **Workers & Pages → Create application → Pages → Connect to Git** and authorize GitHub access to `prince-0110/WUK-AI`.
2. Select production branch `main`. Use the repository root as the root directory.
3. Set the build command to `npm ci && npm run build:web` and the output directory to `dist`.
4. Set the Pages environment variable `NODE_VERSION` to `24.20.0`.
5. Set the Pages build variable `EXPO_PUBLIC_API_URL` to the Worker URL from the previous step, such as `https://wuk-ai-api.<your-account>.workers.dev`. This is a public URL, not a key.
6. Select **Save and Deploy**. Pages gives the site a `*.pages.dev` URL. Add a custom domain from the Pages project's **Custom domains** settings if you want one.
7. If you used a custom site domain, update the Worker secret `WEB_ORIGINS` to that exact `https://` origin.

Cloudflare Pages rebuilds the website after pushes to `main`. When you change backend code or provider adapters, redeploy the Worker from `backend/` with `npm run deploy`. After Pages finishes, open the site, open WUK AI **Settings → AI connection**, enter the Worker URL and the same `API_ACCESS_PASSWORD`, tap **Test connection**, then save. Android stores the password in encrypted secure storage between launches; the website saves it in that browser's local storage. Do not use a shared or public computer to save the website password.

The web front end and Worker are separate Cloudflare deployments: Pages serves the Expo website and the Worker answers `/health` and `/api/*`. The website itself can load without AI configured; online chat, image questions, and image generation require a reachable Worker, the password, and at least one configured provider. Notes, local chat history, and local commands remain on the device/browser. Keep `backend/.env` for local development only; production keys belong in Cloudflare Worker secrets.

## Connect the private backend

Set a private passphrase of at least 12 characters as `API_ACCESS_PASSWORD` in the backend host environment (for Render: **Dashboard → WUK AI service → Environment**). Enter the same password in **WUK AI → Settings → Backend password**, then tap **Test connection** and **Save connection**. Avoid short PINs because the backend is reachable over the public internet. This is the password that gates `/api/status`, `/api/chat`, `/api/vision`, and `/api/image`; `/health` remains public for uptime checks. Keep provider API keys such as `GEMINI_API_KEY` only in the backend host's environment; never put them in mobile source, Expo `EXPO_PUBLIC_` variables, or this repository. The app does not use an `API_ACCESS_TOKEN` setting.

Photo questions and image creation use whichever configured provider supports that operation. Supported adapters include Gemini, OpenAI, Claude, Groq, OpenRouter, Cloudflare Workers AI, and Mistral for vision; Gemini, OpenAI, OpenRouter, Cloudflare Workers AI, and Mistral for image generation. Groq does not advertise image generation in its current adapter. Actual model availability depends on the selected model, provider account, region, and quota. Generated and attached images are cached locally on the phone; clearing temporary cache removes those image files while retaining the text conversation.

Chat calls the authenticated `POST /api/chat` route with `{ provider, research, allowFallback, messages }`. It includes at most the last 16 messages. The app automatically requests provider web search for messages that appear time-sensitive (for example, current prices, news, or documentation); Settings can switch research off or on for every request. When source citation metadata is returned, the answer shows clickable source links. The automatic detector is a best-effort keyword check and can miss a query; users can choose Always or Off.

### AI providers, research, and fallback

The Connections screen defaults to **Auto · Best available**. Auto routes by supported capability and prefers Gemini for general use, then tries other compatible configured providers after an upstream quota/rate limit or service failure. A specific provider can also be selected; the fallback switch controls whether a manually selected provider can fail over. Each fallback may send the same bounded conversation context to another service and incur a separate charge. Web research only routes to providers whose adapter supports search. The current text/search adapters are Gemini, OpenAI, Anthropic, Groq, OpenRouter, and Mistral. Cloudflare Workers AI currently provides text, vision, and image-generation adapters; choose Auto for research so it can use a search-capable provider.

Configure keys and optional model IDs in the **private backend environment**, never in Expo variables or mobile code. Variables are listed in `backend/.env.example`. Cloudflare requires both an API token and account ID. OpenRouter's default chat model is its free-model router; the default image model may be paid. Provider free tiers and their limits change; a key does not guarantee unlimited use. Deploy the backend, then open WUK AI Settings and use **Test connection**. Configured providers and advertised capabilities will appear in Connections. Responses identify which provider answered and whether fallback was used.

Provider adapters use official [Gemini API](https://ai.google.dev/gemini-api/docs), [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses), [Anthropic Messages API](https://docs.anthropic.com/en/api/messages), [Groq API](https://console.groq.com/docs/api-reference), [OpenRouter API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [Cloudflare Workers AI REST API](https://developers.cloudflare.com/workers-ai/models/), and [Mistral API](https://docs.mistral.ai/api) endpoints. Search and image support is provider/model-specific.

Auto tries compatible providers in task-specific priority order after a provider quota/rate limit, timeout, outage, or server error; it does not repeat the same provider. Selecting one provider uses it first, and the fallback switch allows other compatible providers after qualifying failures. Invalid credentials and model permissions are surfaced instead of silently skipped. Each fallback sends the same bounded context to another provider and may incur another charge.

These are **backend-owner API credentials**, not personal OAuth connections or consumer subscriptions. All app installs using this backend share its configured provider accounts and quotas. This repository has no WUK user accounts, database, per-user credential vault, or secure BYOK flow, so do not expose this backend as a public multi-user service in its current configuration.

Google sign-in alone does not grant Gemini API access. ChatGPT/Claude subscriptions also do not normally include API usage; API billing is separate. OpenAI documents ChatGPT plan sharing for participating partner apps, with a limited program and partner eligibility. WUK AI has not been approved as a participating partner, so this build does not claim or implement ChatGPT-plan OAuth. Never enter a Google, ChatGPT, or Claude password into WUK AI.

Per-user OAuth, secure personal-key vaults, token revocation, per-user usage accounting, user-isolated rate limits, detailed request-cost tracking, video generation, and model streaming are not implemented. The existing backend request limits are process-wide. Image generation and vision availability depends on each configured provider model. Automated tests mock provider responses; they do not make live provider calls, so add valid keys to the private backend environment and verify provider/model access there before relying on a route.

Provider APIs and built-in search may incur usage charges. Configure spending limits with each provider and review its current pricing before enabling keys. Prompts are sent only to the selected provider; when fallback is enabled, a qualifying failure can send the same prompt/context to one alternate provider. Existing stateless requests use `store: false` where the provider API supports it. Local history stays on the device unless the user sends it as bounded context.

On Android, the active conversation can be exported as a plain text file through the system share sheet. In a browser it downloads as `.txt`. Code blocks have a copy action. Browser chat images are temporary object URLs and are not persisted between page loads; conversation text remains local.

Run backend adapter tests with `npm test` from `backend/`. Provider tests mock network responses and do not need real API keys.

## Voice support

Text-to-speech uses the existing Expo Speech package and works in Expo Go. Speech-to-text uses `expo-speech-recognition`, which adds a small native module and requires a WUK AI development or production build; it is not included in Expo Go. Rebuild after adding or changing its config plugin. Recognition is tap-to-start, single-session, permission-gated, and places text in the composer for review. The app does not save microphone recordings or listen for a wake word.

For a local development build, use an Android SDK/JDK installation and run:

```powershell
npx expo run:android
```

Or make a cloud development build with EAS after configuring the project:

```powershell
npx eas-cli@latest build --profile development --platform android
```

## Local data and privacy

Chats and notes stay on-device. Messages are not uploaded automatically; the app sends the current message and a bounded transcript only when you request an online answer. You can inspect the approximate saved JSON size, delete individual conversations or notes, clear all conversation history, and clear temporary cache entries. No audio recording files are stored.

Settings lets you switch between the WUK Frost and Pale Mist backgrounds while retaining the Wuk72 blue palette. Matrix Rain is optional and off by default; turn it on in Settings. It pauses while the app is inactive or reduced motion is enabled. Main navigation is in the header menu so the chat screen has no persistent bottom tab strip. Android content includes status-bar spacing at the top and a larger bottom composer safe gap. Speech recognition and Gemini require their respective device/backend services; local notes and date/time commands remain available without them.
