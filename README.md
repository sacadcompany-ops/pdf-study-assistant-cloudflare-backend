# PDF Study Assistant — No-AI Cloudflare Workers Backend

A deterministic, **100% AI-free** PDF question-answering and document indexing API built on **Cloudflare Workers**, **Cloudflare D1**, and **Cloudflare R2**.

## Architecture Guarantees

- **Zero AI / Zero LLM Calls**: No OpenAI, Gemini, Claude, embeddings, or external inference APIs.
- **Mode A — Smart Search (`smart_search`)**: Bilingual English/Somali normalization, tokenization, BM25 + TF-IDF scoring, exact phrase bonus, multi-word coverage boost, minimum relevance threshold (`0.35`), and page-level citations.
- **Mode B — Exact Answer (`exact_answer`)**: Splits original PDF pages into verbatim sentences, scores keyword overlap & phrase proximity, and returns unmodified original sentences with source PDF title and page number.
- **Unanswered Fallback**: Returns `"Ma helin jawaab ku filan oo ku jirta PDF-yada la kaydiyey. Fadlan su'aasha si kale u qor."` whenever no passage meets the relevance threshold.

---

## Deployment Instructions (Cloudflare Workers + D1 + R2)

```bash
cd backend
npm install

# 1. Create D1 Database and copy the database_id into wrangler.toml
npx wrangler d1 create pdf_study_db

# 2. Create R2 Bucket
npx wrangler r2 bucket create pdf-study-files

# 3. Apply D1 SQL migrations
npx wrangler d1 migrations apply pdf_study_db --remote

# 4. Set required secrets (never commit secrets to source code)
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_INVITE_CODE

# 5. Deploy Worker
npx wrangler deploy
```

### Promoting an Existing User to Admin (Optional)

```bash
npx wrangler d1 execute pdf_study_db --remote \
  --command "UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';"
```

---

## REST API Reference (`/api/v1`)

### Authentication
- `POST /api/v1/auth/register` — `{ name, email, password, admin_invite_code? }`
- `POST /api/v1/auth/login` — `{ email, password }`
- `POST /api/v1/auth/logout` — Revokes current JWT `jti`
- `GET /api/v1/auth/me` — Returns authenticated user profile

### Categories
- `GET /api/v1/categories` — List all categories with completed document counts
- `POST /api/v1/admin/categories` — Admin: create category
- `PUT /api/v1/admin/categories/:id` — Admin: update category
- `DELETE /api/v1/admin/categories/:id` — Admin: delete category

### Admin PDF Management (Role: `admin` only)
- `POST /api/v1/admin/documents` — Multipart upload (`file`, `title`, `description`, `category_id`, optional `pages_json`). Stores PDF in R2, indexes pages/chunks/terms in D1.
- `GET /api/v1/admin/documents` — List all documents across statuses (`Pending`, `Processing`, `Completed`, `Failed`)
- `GET /api/v1/admin/documents/:id` — Inspect document metadata and chunk count
- `PUT /api/v1/admin/documents/:id` — Update metadata (JSON) or replace PDF file (multipart)
- `DELETE /api/v1/admin/documents/:id` — Delete R2 object and D1 records
- `POST /api/v1/admin/documents/:id/process` — Reprocess/re-index document pages

### Student PDF Access
- `GET /api/v1/documents` — List `Completed` searchable documents (`?q=&category_id=`)
- `GET /api/v1/documents/:id` — Get document metadata and download URL
- `GET /api/v1/documents/:id/download` — Stream original PDF from R2
- `GET /api/v1/documents/:id/pages/:page` — Get original extracted text for a specific page

### Chat & Search
- `POST /api/v1/chat/ask` — `{ question, document_id?, answer_mode: "smart_search" | "exact_answer" }`
  Returns `{ found, answer, answer_mode, document_id, document_title, page_number, relevance_score, matched_text, results }` and saves entry to `chat_history`.
- `POST /api/v1/search/smart` — `{ query, document_id?, limit? }`
- `POST /api/v1/search/exact` — `{ query, document_id?, limit? }`
- `GET /api/v1/chat/history` — Fetch user's saved chat history
- `DELETE /api/v1/chat/history` — Clear user's chat history

---

## Android APK Build Instructions

From the project root:

```bash
# Debug APK
gradle :app:assembleDebug

# Release APK (with configured signing keystore env vars)
gradle :app:assembleRelease
```

The API base URL defaults to `https://pdf-chatbot-api.sacadcompany.workers.dev/` via `BuildConfig.API_BASE_URL` and can also be overridden at runtime in the app's **Settings** screen.
