-- Migration 0002: Seed initial academic subject categories

INSERT OR IGNORE INTO categories (id, name, description) VALUES
  ('cat-math', 'Mathematics', 'Algebra, geometry, calculus, statistics, and quantitative problem solving'),
  ('cat-science', 'Science', 'General science textbooks, scientific methods, and interdisciplinary studies'),
  ('cat-biology', 'Biology', 'Cellular biology, genetics, anatomy, botany, and ecology'),
  ('cat-chemistry', 'Chemistry', 'Organic, inorganic, physical chemistry, and laboratory guides'),
  ('cat-physics', 'Physics', 'Mechanics, thermodynamics, optics, electricity, and magnetism'),
  ('cat-english', 'English', 'English grammar, literature, reading comprehension, and writing'),
  ('cat-somali', 'Somali', 'Af-Soomaali grammar, literature, essays, and cultural studies'),
  ('cat-history', 'History', 'World history, African history, and historical source documents'),
  ('cat-geography', 'Geography', 'Physical geography, cartography, climate, and human geography'),
  ('cat-other', 'Other', 'Additional study guides, syllabi, and reference documents');
