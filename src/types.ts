export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  JWT_SECRET: string;
  ADMIN_INVITE_CODE?: string;
  APP_NAME?: string;
  MIN_SMART_THRESHOLD?: string;
  MIN_EXACT_THRESHOLD?: string;
  MAX_UPLOAD_BYTES?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

export type UserRole = 'admin' | 'student';
export type ProcessingStatus = 'Pending' | 'Processing' | 'Completed' | 'Failed';
export type AnswerMode = 'smart_search' | 'exact_answer';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface JwtClaims {
  sub: string;
  name: string;
  email: string;
  role: UserRole;
  jti: string;
  iat: number;
  exp: number;
}

export interface DocumentRow {
  id: string;
  title: string;
  description: string;
  file_name: string;
  r2_object_key: string;
  file_size: number;
  page_count: number;
  category_id: string | null;
  category_name?: string | null;
  uploaded_at: string;
  processing_status: ProcessingStatus;
  status_message: string;
  uploaded_by: string | null;
}

export interface ExtractedPageInput {
  page_number: number;
  original_text: string;
}

export interface SearchMatchItem {
  document_id: string;
  document_title: string;
  page_number: number;
  relevance_score: number;
  matched_text: string;
  matched_terms: string[];
}

export interface SearchResponsePayload {
  found: boolean;
  answer: string;
  answer_mode: AnswerMode;
  document_id: string | null;
  document_title: string | null;
  page_number: number | null;
  relevance_score: number;
  matched_text: string | null;
  results: SearchMatchItem[];
}
