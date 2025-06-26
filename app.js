/* =========  기본 모듈 ========= */
const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');
const Database = require('better-sqlite3');

const app = express();

/* =========  경로 준비 ========= */
const dataDir   = path.join(__dirname, 'data');
const staticDir = path.join(__dirname, 'static');
const imgDir    = path.join(staticDir, 'img');
const tmpDir    = path.join(staticDir, 'tmp');

[dataDir, imgDir, tmpDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* =========  DB 연결 & 마이그레이션 ========= */
const db = new Database(path.join(dataDir, 'db.sqlite'));
db.pragma('journal_mode = WAL');

/* 테이블 */
db.exec(`
  CREATE TABLE IF NOT EXISTS posts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content_html TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS post_images(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    file_url TEXT NOT NULL,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
`);

/* views 컬럼이 없던 구버전 DB를 위한 안전장치 */
try {
  db.exec(`ALTER TABLE posts ADD COLUMN views INTEGER DEFAULT 0`);
} catch { /* already exists */ }

/* =========  미들웨어 ========= */
app.use(express.json({ limit: '10mb' }));
app.use('/static', express.static(staticDir));     // 업로드 이미지
app.use('/',       express.static(path.join(__dirname, 'public'))); // 정적 프론트

/* =========  이미지 업로드 ========= */
const upload = multer({ dest: tmpDir });
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    const tmpPath  = req.file.path;
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = uuid() + ext;
    const outPath  = path.join(imgDir, filename);

    const max = 524_288_000;          // 500 MB
    const quality = req.file.size > max ? 80 : 100;

    await sharp(tmpPath).jpeg({ quality }).toFile(outPath);
    fs.unlinkSync(tmpPath);

    res.json({ url: `/static/img/${filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'upload failed' });
  }
});

/* =========  글 작성 ========= */
app.post('/api/posts', (req, res) => {
  const { title, contentHtml, imageUrls = [] } = req.body;
  if (!title || !contentHtml) return res.status(400).json({ error: 'invalid' });

  const info = db
    .prepare(`INSERT INTO posts(title,content_html) VALUES (?,?)`)
    .run(title, contentHtml);

  if (imageUrls.length) {
    const stmt = db.prepare(`INSERT INTO post_images(post_id,file_url) VALUES (?,?)`);
    const tx   = db.transaction(urls => urls.forEach(u => stmt.run(info.lastInsertRowid, u)));
    tx(imageUrls);
  }

  res.json({ id: info.lastInsertRowid });
});

/* =========  글 목록 (카드용) ========= */
app.get('/api/posts', (_req, res) => {
  /* 대표 이미지 1장 조인 */
  const rows = db.prepare(`
    SELECT  p.id, p.title, p.content_html,
            p.created_at, p.views,
            (SELECT file_url FROM post_images WHERE post_id = p.id LIMIT 1) AS image
    FROM    posts p
    ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

/* =========  글 상세 ========= */
app.get('/api/posts/:id', (req, res) => {
  const id = req.params.id;

  /* 조회수 +1 */
  const inc = db.prepare(`UPDATE posts SET views = views + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  inc.run(id);

  /* 데이터 가져오기 */
  const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id);
  if (!post) return res.status(404).json({ error: 'not found' });

  const images = db.prepare(`SELECT file_url FROM post_images WHERE post_id = ?`).all(id);
  res.json({ ...post, images });
});

/* =========  통계 ========= */
app.get('/api/stats', (_req, res) => {
  const totalPosts = db.prepare(`SELECT COUNT(*) AS n FROM posts`).get().n;
  const todayPosts = db.prepare(`
      SELECT COUNT(*) AS n
      FROM posts
      WHERE DATE(created_at,'localtime') = DATE('now','localtime')
  `).get().n;
  const totalViews = db.prepare(`SELECT SUM(views) AS v FROM posts`).get().v || 0;

  res.json({ totalPosts, todayPosts, totalViews });
});
// 👉 POST·GET 라우트들 아래에 붙여 주세요
app.delete('/api/posts/:id', (req, res) => {
  const { id } = req.params;

  // ① 실제로 존재하는지 확인
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'not found' });

  // ② 삭제 (posts · post_images 둘 다)
  const delPost  = db.prepare('DELETE FROM posts WHERE id = ?');
  delPost.run(id);

  // better-sqlite3 는 FK ON DELETE CASCADE 를 이미 걸어뒀으니,
  // post_images 레코드도 함께 지워집니다.

  res.json({ ok: true });
});
/* =========  서버 시작 ========= */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Notice-blog running on :' + PORT));
