# WUK AI by Wuk72

WUK AI is a local-first Expo assistant. It keeps conversation history and notes on the phone, supports date/time commands and text-to-speech offline, and sends open-ended questions only to the authenticated Gemini backend. The app never treats a canned response as an AI answer.

## Project details

- User-facing name: **WUK AI** · creator: **Wuk72**
- Expo SDK 57 · React Native 0.86
- Android application ID: `com.wuk72.wukai`
- Existing project folder: `JarvisAssistant`
- Default backend: `https://wuk-ai.onrender.com` (overridden by `.env`)

## Start the app

In PowerShell:

```powershell
Set-Location 'C:\Users\admin\OneDrive\Desktop\project\JarvisAssistant'
npm install
npx expo start --lan
```

Connect the phone and computer to the same Wi-Fi, open Expo Go that supports SDK 57, and scan the QR code. If Windows asks, permit the development server on private networks. The root `.env` contains only the public backend URL; the Gemini key is not used by the mobile app.

## Connect Gemini

Set a strong `API_ACCESS_TOKEN` in the backend host's environment variables (for Render: **Dashboard → WUK AI service → Environment**). Use the exact same value in **WUK AI → Settings → AI connection → Backend access token**, then tap **Test connection** and **Save connection**. Generate a random token locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`; paste that value directly into Render's `API_ACCESS_TOKEN` and the app's token field. Do not use the Gemini key here. The app keeps this access token in memory for the current session and does not save it to local storage. Keep `GEMINI_API_KEY` only in the backend host's environment; never put either secret in mobile source, Expo `EXPO_PUBLIC_` variables, or this repository.

Chat calls the verified `POST /api/chat` route with `{ messages: [{ role, content }] }`. It includes at most the last 16 messages. Render can sleep on its free tier, so the app shows a waking state and allows up to 70 seconds for a chat response. Health success means the backend is reachable; it does not by itself verify Gemini.

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

Settings lets you switch between the WUK Frost and Pale Mist backgrounds while retaining the Wuk72 blue palette. Matrix Rain is optional and off by default; turn it on in Settings. It pauses while the app is inactive or reduced motion is enabled. Main navigation is in the header menu so the chat screen has no persistent bottom tab strip. Speech recognition and Gemini require their respective device/backend services; local notes and date/time commands remain available without them.
