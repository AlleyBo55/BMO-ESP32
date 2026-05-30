# Requirements Document

## Introduction

The BMO Dashboard is a standalone Next.js application, decoupled from the existing Doraemon Electron app, that serves as both the configuration UI for a human admin and the cognitive backend (the "brain") for the BMO ESP32-C3 firmware. The dashboard is deployed on Vercel and uses Supabase as its persistence and authentication store.

The dashboard is conceptually a simpler clone of OpenClaw, scoped to BMO's persona and capabilities. It exposes a configuration surface for BMO's soul (persona prompt), skills (web search, sing, play music, story, comfort, play-pretend), STT/TTS providers, LLM provider/model, and OpenRouter API key, plus a live view of remaining OpenRouter credits and a conversation activity log.

The ESP32-C3 firmware never talks to OpenRouter directly. Instead it always calls this dashboard's API endpoints (`/api/voice/stt`, `/api/voice/tts`, `/api/brain`, `/api/openrouter/credits`) and the dashboard performs the upstream provider calls. The ESP32 is authenticated to the API by a long random fingerprint, configured during onboarding, stored on the dashboard side in Supabase and on the device side in a gitignored local env file that is flashed into firmware at build time.

A first-run onboarding wizard, executable exactly once, provisions the admin username and password (stored hashed in Supabase) and the ESP32 fingerprint. Once onboarding is complete, the dashboard is locked behind an admin login. Admin credentials cannot be changed or reset from the dashboard UI; they can only be modified by editing the Supabase row directly. All Supabase keys and the OpenRouter key live in environment variables and are never committed to git.

## Glossary

- **BMO_Dashboard**: The Next.js (App Router) web application deployed on Vercel that provides the admin UI and the BMO API endpoints.
- **BMO_Firmware**: The ESP32-C3 program flashed onto the BMO device. The BMO_Firmware calls the BMO_Dashboard API for all cognitive and voice operations.
- **Admin**: The single human operator who configures and manages the BMO_Dashboard through the web UI.
- **Onboarding_Wizard**: The first-run setup flow inside the BMO_Dashboard that captures the Admin credentials and the ESP32_Fingerprint exactly once.
- **ESP32_Fingerprint**: A high-entropy random secret string (minimum 32 bytes encoded as hex or base64) that uniquely identifies the BMO_Firmware to the BMO_Dashboard API. Sent by the BMO_Firmware in every API request.
- **Auth_Service**: The component of the BMO_Dashboard that authenticates Admin sessions and validates ESP32_Fingerprint values on API requests.
- **Soul_Document**: A Markdown document describing BMO's persona, used as the system prompt for the LLM.
- **Skill**: A configurable BMO capability (web search, sing, play music, story, comfort, play-pretend) that can be enabled, disabled, and parameterized.
- **STT_Service**: The Speech-to-Text component of the BMO_Dashboard API that converts audio uploaded by the BMO_Firmware into text by calling an upstream provider (Qwen ASR via OpenRouter by default).
- **TTS_Service**: The Text-to-Speech component of the BMO_Dashboard API that converts text into audio for playback on the BMO_Firmware by calling an upstream provider (gpt-audio-mini via OpenRouter by default).
- **Brain_Service**: The full-pipeline endpoint that accepts text or audio from the BMO_Firmware, runs STT (if needed), invokes the LLM with the Soul_Document and active Skills, and returns the response as text and synthesized audio.
- **OpenRouter_Service**: The BMO_Dashboard component that holds the OpenRouter API key and proxies requests to OpenRouter for LLM, STT, and TTS calls and for credit balance queries.
- **OpenRouter_Credits_Endpoint**: The BMO_Dashboard endpoint that returns the OpenRouter account's remaining credit balance.
- **Supabase_Store**: The Supabase project that stores Admin credentials, configuration (Soul_Document, Skills, providers, ESP32_Fingerprint), and conversation logs.
- **Service_Role_Key**: The Supabase service-role API key, used only by server-side BMO_Dashboard code, never exposed to the browser.
- **Local_Env_File**: A gitignored file in the BMO_Firmware repository (e.g. `.env.local` or `secrets.h`) that holds the dashboard base URL and the ESP32_Fingerprint and is consumed at firmware build time.
- **Activity_Log**: The append-only record of conversations and API calls between the BMO_Firmware and the BMO_Dashboard, stored in Supabase_Store.
- **Hashed_Password**: The Admin password after applying a memory-hard hash (Argon2id preferred, bcrypt acceptable) with a per-row salt; the plaintext password is never stored.

## Requirements

### Requirement 1: First-Run Onboarding

**User Story:** As an Admin, I want to complete a one-time onboarding wizard on first launch, so that the dashboard, the admin account, and the ESP32 fingerprint are provisioned without exposing setup to anyone after that.

#### Acceptance Criteria

1. WHEN the BMO_Dashboard is launched and Supabase_Store contains zero Admin records, THE BMO_Dashboard SHALL redirect any incoming request to the Onboarding_Wizard route.
2. WHEN the Onboarding_Wizard is submitted with a username, a password, and an ESP32_Fingerprint, THE Auth_Service SHALL store the username, the Hashed_Password, and the ESP32_Fingerprint in Supabase_Store as a single Admin record.
3. THE Onboarding_Wizard SHALL require the submitted password to be at least 12 characters long.
4. THE Onboarding_Wizard SHALL require the submitted ESP32_Fingerprint to be at least 32 bytes of entropy expressed as a hex or base64 string.
5. WHERE the Admin requests it during the Onboarding_Wizard, THE BMO_Dashboard SHALL generate a cryptographically random ESP32_Fingerprint of at least 32 bytes and display it once for the Admin to copy.
6. IF Supabase_Store already contains an Admin record when the Onboarding_Wizard is submitted, THEN THE Auth_Service SHALL reject the submission with HTTP status 409 and SHALL NOT modify any existing record.
7. WHEN the Onboarding_Wizard submission succeeds, THE BMO_Dashboard SHALL redirect the Admin to the login route.

### Requirement 2: Admin Authentication and Session Management

**User Story:** As an Admin, I want every dashboard page to be reachable only after I log in, so that nobody else can read or change BMO's configuration.

#### Acceptance Criteria

1. WHEN an unauthenticated request arrives at any BMO_Dashboard route other than the login route, the Onboarding_Wizard route, or the BMO_Firmware API routes, THE Auth_Service SHALL redirect the request to the login route.
2. WHEN the login form is submitted with a username and a password, THE Auth_Service SHALL look up the Admin record in Supabase_Store and SHALL verify the password against the stored Hashed_Password using a constant-time comparison.
3. WHEN authentication succeeds, THE Auth_Service SHALL issue a session cookie that is HTTP-only, Secure, and SameSite=Lax, with an expiry of at most 24 hours.
4. IF authentication fails, THEN THE Auth_Service SHALL return HTTP status 401 and SHALL NOT disclose whether the username or the password was incorrect.
5. THE BMO_Dashboard SHALL NOT expose any UI control or API endpoint for changing the Admin username or password.
6. WHEN the Admin record in Supabase_Store is updated by direct database edit, THE Auth_Service SHALL accept the new credentials on the next login attempt without any further action by the Admin.
7. WHEN five consecutive failed login attempts occur for the Admin record within 15 minutes, THE Auth_Service SHALL reject further login attempts for that record for 15 minutes from the most recent failure and SHALL return HTTP status 429.

### Requirement 3: ESP32 Fingerprint Authentication for API Requests

**User Story:** As the operator of the BMO device, I want the dashboard API to only accept calls from my BMO firmware, so that no other client can use my OpenRouter credits or trigger BMO actions.

#### Acceptance Criteria

1. WHEN a request arrives at any BMO_Firmware API route (`/api/voice/stt`, `/api/voice/tts`, `/api/brain`, `/api/openrouter/credits`), THE Auth_Service SHALL read the ESP32_Fingerprint from the `X-BMO-Fingerprint` request header.
2. THE Auth_Service SHALL compare the supplied ESP32_Fingerprint against the value stored in Supabase_Store using a constant-time comparison.
3. IF the supplied ESP32_Fingerprint is missing, malformed, or does not match, THEN THE Auth_Service SHALL reject the request with HTTP status 401 and SHALL NOT process the request body.
4. WHEN the supplied ESP32_Fingerprint matches, THE Auth_Service SHALL allow the request to proceed to the relevant Service handler.
5. THE Auth_Service SHALL NOT log the ESP32_Fingerprint value in the Activity_Log or in any application log.
6. WHEN the Admin updates the ESP32_Fingerprint from the configuration page, THE BMO_Dashboard SHALL display a warning that the BMO_Firmware must be re-flashed with the new value before it will reconnect.

### Requirement 4: ESP32 Fingerprint Configuration Page

**User Story:** As an Admin, I want to be able to rotate the ESP32 fingerprint from the dashboard, so that I can recover from suspected compromise without rebuilding the dashboard.

#### Acceptance Criteria

1. WHEN the Admin opens the configuration page, THE BMO_Dashboard SHALL display the masked ESP32_Fingerprint with only the last 4 characters visible.
2. WHEN the Admin requests the ESP32_Fingerprint to be revealed, THE BMO_Dashboard SHALL display the full value and SHALL hide it again automatically after 60 seconds.
3. WHEN the Admin submits a new ESP32_Fingerprint, THE BMO_Dashboard SHALL validate that the value is at least 32 bytes of entropy expressed as a hex or base64 string before persisting it.
4. WHERE the Admin requests it on the configuration page, THE BMO_Dashboard SHALL generate a cryptographically random ESP32_Fingerprint of at least 32 bytes.
5. WHEN a new ESP32_Fingerprint is persisted to Supabase_Store, THE BMO_Dashboard SHALL invalidate any cached fingerprint within 60 seconds.
6. THE BMO_Dashboard SHALL provide a copy-to-clipboard control for the displayed ESP32_Fingerprint and SHALL provide instructions for placing it into the Local_Env_File of the BMO_Firmware repository.

### Requirement 5: Soul Document Configuration

**User Story:** As an Admin, I want to edit BMO's soul markdown directly in the dashboard, so that I can shape BMO's persona without redeploying.

#### Acceptance Criteria

1. THE BMO_Dashboard SHALL provide a Soul_Document editor that loads the current Soul_Document from Supabase_Store.
2. WHEN the Admin saves an edited Soul_Document, THE BMO_Dashboard SHALL persist the new Markdown content to Supabase_Store with an updated timestamp.
3. WHEN the Brain_Service composes an LLM request, THE Brain_Service SHALL prepend the current Soul_Document as the system prompt.
4. THE BMO_Dashboard SHALL reject Soul_Document content larger than 64 KiB and SHALL return an explanatory error message to the Admin.
5. WHERE no Soul_Document exists in Supabase_Store, THE BMO_Dashboard SHALL seed the editor with a default BMO persona Markdown document on first open.

### Requirement 6: Skill Configuration

**User Story:** As an Admin, I want to enable, disable, and parameterize BMO's skills, so that I can control which capabilities BMO offers without changing code.

#### Acceptance Criteria

1. THE BMO_Dashboard SHALL expose a Skills configuration page listing the Skills "web_search", "sing", "play_music", "story", "comfort", and "play_pretend".
2. WHEN the Admin toggles a Skill, THE BMO_Dashboard SHALL persist the enabled state and the Skill parameters to Supabase_Store.
3. WHEN the Brain_Service composes an LLM request, THE Brain_Service SHALL include only the currently enabled Skills as available tools.
4. IF a request from the BMO_Firmware invokes a disabled Skill, THEN THE Brain_Service SHALL respond with a polite refusal in BMO's voice and SHALL NOT call the upstream provider for that Skill.
5. WHERE the Skill "web_search" is enabled, THE Brain_Service SHALL accept a search query and SHALL return up to 5 result snippets from the configured search provider.

### Requirement 7: STT Pipeline (BMO Firmware to API)

**User Story:** As the BMO firmware, I want to upload recorded audio and receive transcribed text, so that I can convert what the user said into something the brain can reason about.

#### Acceptance Criteria

1. WHEN a request with a valid ESP32_Fingerprint arrives at `/api/voice/stt` with an audio payload in the request body, THE STT_Service SHALL forward the audio to the configured upstream STT provider.
2. THE STT_Service SHALL accept audio payloads up to 25 MB in size, encoded as one of `audio/wav`, `audio/mpeg`, or `audio/webm`.
3. WHEN the upstream STT provider returns a transcript, THE STT_Service SHALL respond with HTTP status 200 and a JSON body of the form `{ "text": <string>, "duration_ms": <integer>, "model": <string> }`.
4. IF the audio payload exceeds 25 MB, THEN THE STT_Service SHALL reject the request with HTTP status 413.
5. IF the upstream STT provider returns an error or times out within 30 seconds, THEN THE STT_Service SHALL respond with HTTP status 502 and a JSON error body identifying the failure stage as `stt`.
6. THE STT_Service SHALL append a record to the Activity_Log capturing the timestamp, the resolved transcript, the duration, and the chosen model, but SHALL NOT persist the raw audio.

### Requirement 8: TTS Pipeline (API to BMO Firmware)

**User Story:** As the BMO firmware, I want to send text and receive audio back, so that I can speak BMO's responses aloud through the speaker.

#### Acceptance Criteria

1. WHEN a request with a valid ESP32_Fingerprint arrives at `/api/voice/tts` with a JSON body of the form `{ "text": <string>, "voice": <string optional>, "format": <string optional> }`, THE TTS_Service SHALL forward the text to the configured upstream TTS provider.
2. THE TTS_Service SHALL accept text inputs up to 4000 characters.
3. WHEN the upstream TTS provider returns audio, THE TTS_Service SHALL stream the audio bytes back to the client with a `Content-Type` of `audio/mpeg` by default and SHALL include a `X-BMO-Audio-Duration-Ms` response header.
4. IF the text input exceeds 4000 characters, THEN THE TTS_Service SHALL reject the request with HTTP status 413.
5. IF the upstream TTS provider returns an error or times out within 30 seconds, THEN THE TTS_Service SHALL respond with HTTP status 502 and a JSON error body identifying the failure stage as `tts`.
6. THE TTS_Service SHALL append a record to the Activity_Log capturing the timestamp, the input text, the chosen voice, the chosen model, and the resulting audio duration in milliseconds.

### Requirement 9: Full-Pipeline Brain Endpoint

**User Story:** As the BMO firmware, I want a single endpoint that accepts an utterance and returns BMO's spoken response, so that the device can stay simple and reliable.

#### Acceptance Criteria

1. WHEN a request with a valid ESP32_Fingerprint arrives at `/api/brain` with either a JSON body containing a `text` field or a multipart body containing an audio file, THE Brain_Service SHALL invoke the STT_Service for audio inputs and SHALL bypass it for text inputs.
2. WHEN the Brain_Service has a transcript, THE Brain_Service SHALL invoke the OpenRouter_Service with the configured LLM model, the current Soul_Document as the system prompt, and the enabled Skills as available tools.
3. WHEN the LLM returns a response, THE Brain_Service SHALL invoke the TTS_Service to synthesize the response and SHALL return a multipart response containing both the response text and the audio bytes, OR a JSON body with a streaming audio URL.
4. THE Brain_Service SHALL complete the full pipeline within 20 seconds for inputs of up to 30 seconds of audio or 1000 characters of text.
5. IF any pipeline stage fails, THEN THE Brain_Service SHALL respond with HTTP status 502 and a JSON body identifying which stage (`stt`, `llm`, or `tts`) failed.
6. WHEN the pipeline completes successfully, THE Brain_Service SHALL append one record to the Activity_Log linking the input transcript, the LLM response text, the chosen models, and the total duration.

### Requirement 10: OpenRouter Integration

**User Story:** As an Admin, I want the dashboard to manage the OpenRouter API key and surface remaining credits, so that I can keep BMO running without checking another website.

#### Acceptance Criteria

1. THE OpenRouter_Service SHALL read the OpenRouter API key from a server-only environment variable named `OPENROUTER_API_KEY`.
2. THE BMO_Dashboard SHALL NOT expose the OpenRouter API key value to any client-side bundle, page, or API response.
3. WHEN the Admin opens the OpenRouter configuration page, THE BMO_Dashboard SHALL display whether the `OPENROUTER_API_KEY` environment variable is present and SHALL display the last 4 characters only.
4. WHEN a request with a valid ESP32_Fingerprint arrives at `/api/openrouter/credits`, THE OpenRouter_Service SHALL call the OpenRouter `/credits` endpoint and SHALL return a JSON body of the form `{ "total": <number>, "used": <number>, "remaining": <number>, "currency": "USD" }`.
5. WHEN the Admin opens the dashboard home page, THE BMO_Dashboard SHALL poll `/api/openrouter/credits` every 60 seconds and SHALL display the remaining credits.
6. IF the OpenRouter `/credits` call fails, THEN THE OpenRouter_Service SHALL respond with HTTP status 502 and SHALL preserve the most recent successful credit value for display with a "stale" indicator.
7. THE BMO_Dashboard SHALL allow the Admin to select the LLM model, the STT model, and the TTS model from a configurable list of OpenRouter model identifiers, with defaults `qwen/qwen-asr` for STT and `openai/gpt-audio-mini` for TTS.

### Requirement 11: Activity Log

**User Story:** As an Admin, I want to see a chronological log of BMO's recent conversations and API calls, so that I can debug issues and review interactions.

#### Acceptance Criteria

1. THE BMO_Dashboard SHALL provide an Activity_Log page that displays the most recent 200 entries in reverse chronological order.
2. WHEN the Brain_Service, STT_Service, or TTS_Service completes a request, THE BMO_Dashboard SHALL append one structured record to the Activity_Log in Supabase_Store.
3. THE Activity_Log SHALL store, per record, the timestamp, the request type, the input text or transcript, the response text, the chosen models, the total duration in milliseconds, and the result status.
4. THE Activity_Log SHALL NOT store raw audio bytes, the OpenRouter API key, the ESP32_Fingerprint, the Admin password, or any Supabase keys.
5. WHEN the Admin requests deletion of an Activity_Log entry, THE BMO_Dashboard SHALL remove only that entry from Supabase_Store.

### Requirement 12: Secret Handling and Environment Variables

**User Story:** As an Admin, I want all secrets to live in environment variables and never enter source control, so that a leaked git repo cannot compromise my account.

#### Acceptance Criteria

1. THE BMO_Dashboard SHALL read the Supabase URL, Supabase anon key, and Service_Role_Key from environment variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` respectively.
2. THE BMO_Dashboard SHALL use the Service_Role_Key only in server-side code paths and SHALL NOT include it in any client bundle or HTTP response body.
3. THE BMO_Dashboard repository SHALL include a `.gitignore` rule that excludes `.env`, `.env.local`, and `.env.*.local`.
4. THE BMO_Dashboard repository SHALL include a committed `.env.example` file listing every required environment variable name with placeholder values only.
5. THE BMO_Firmware repository SHALL store the dashboard base URL and the ESP32_Fingerprint in a Local_Env_File that is excluded from git via `.gitignore`.
6. WHEN the BMO_Firmware build runs, THE BMO_Firmware build SHALL inject the values from the Local_Env_File into the firmware binary as compile-time constants and SHALL fail the build if the Local_Env_File is missing.
7. IF a request to any BMO_Dashboard server route attempts to read a secret environment variable from the client, THEN THE BMO_Dashboard SHALL respond with HTTP status 404 and SHALL NOT reveal the variable's existence.

### Requirement 13: Deployment and Single-Instance Onboarding Guarantee

**User Story:** As an Admin, I want onboarding to be a one-time, irreversible action even across redeploys, so that an attacker cannot simply trigger setup again to take over.

#### Acceptance Criteria

1. WHEN the BMO_Dashboard starts and Supabase_Store contains at least one Admin record, THE BMO_Dashboard SHALL respond to any request to the Onboarding_Wizard route with HTTP status 404.
2. WHEN the BMO_Dashboard is deployed on Vercel, THE BMO_Dashboard SHALL detect the Supabase Admin row at request time rather than at build time so that fresh deployments still respect existing onboarding state.
3. THE BMO_Dashboard SHALL provide a documented runbook for resetting the Admin record by deleting the row directly in Supabase, and SHALL NOT provide any in-app reset path.
