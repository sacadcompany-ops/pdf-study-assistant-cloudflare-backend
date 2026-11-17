-- Migration 0001: Initial No-AI PDF Study Assistant Schema (Cloudflare D1 / SQLite)
-- Note: Uses standard indexed SQL tables without requiring SQLite FTS5.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'student')) DEFAULT 'student',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    r2_object_key TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL,
    processing_status TEXT NOT NULL CHECK (processing_status IN ('Pending', 'Processing', 'Completed', 'Failed')) DEFAULT 'Pending',
    status_message TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at DESC);

CREATE TABLE IF NOT EXISTS document_pages (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    original_text TEXT NOT NULL,
    UNIQUE(document_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_document_pages_doc_page ON document_pages(document_id, page_number);

CREATE TABLE IF NOT EXISTS text_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    chunk_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_text_chunks_doc_page ON text_chunks(document_id, page_number);

CREATE TABLE IF NOT EXISTS term_index (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL REFERENCES text_chunks(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    term_frequency INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_term_index_term_doc ON term_index(term, document_id);
CREATE INDEX IF NOT EXISTS idx_term_index_chunk ON term_index(chunk_id);
CREATE INDEX IF NOT EXISTS idx_term_index_doc ON term_index(document_id);

CREATE TABLE IF NOT EXISTS chat_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    answer_mode TEXT NOT NULL CHECK (answer_mode IN ('smart_search', 'exact_answer')),
    page_number INTEGER,
    relevance_score REAL NOT NULL DEFAULT 0.0,
    document_title TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_time ON chat_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
    rate_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL
);
