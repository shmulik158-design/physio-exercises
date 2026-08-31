/* ============================================================
   Local admin server for the exercise library.
   Run via add-exercise.bat (or: node admin-server.js).

   Serves admin.html on localhost and exposes a small API that
   writes directly to exercises.json + images/, then optionally
   commits and pushes so the change goes live on GitHub Pages.

   No dependencies — Node built-ins only.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const JSON_PATH = path.join(ROOT, 'exercises.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const AUTH_PATH = path.join(ROOT, 'admin-auth.json'); // gitignored — holds only a salted hash, never the password itself
const QUICK_NOTES_PATH = path.join(ROOT, 'quick-notes.json');
const PORT = 8765;

// Closed vocabularies — the whole point is that these can't drift.
const REGIONS = ['shoulder', 'cervical', 'thoracic', 'lumbar', 'hip', 'knee', 'ankle', 'wrist', 'core'];
const EQUIPMENT = ['none', 'resistance band', 'chair', 'wall', 'small ball', 'dumbbell'];

/* ---------- data helpers ---------- */

// Coerce whatever the client sent into a trimmed string, so a malformed
// request produces a clear validation error instead of a 500.
const str = v => (v === null || v === undefined ? '' : String(v)).trim();

function readExercises() {
  let raw = fs.readFileSync(JSON_PATH, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM if present
  return JSON.parse(raw);
}

// Atomic write: write to a temp file on the same volume, then rename over
// the target. rename() is an atomic filesystem op — readers/crashes never
// see a half-written exercises.json, only the old version or the new one.
function writeExercises(list) {
  const tmp = JSON_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, JSON_PATH);
}

function readQuickNotes() {
  if (!fs.existsSync(QUICK_NOTES_PATH)) return [];
  let raw = fs.readFileSync(QUICK_NOTES_PATH, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function writeQuickNotes(list) {
  const tmp = QUICK_NOTES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, QUICK_NOTES_PATH);
}

function validate(ex, existing, isNew) {
  const errors = [];
  if (!/^[a-z0-9_]+$/.test(ex.id || '')) {
    errors.push('מזהה (id) חייב להיות אותיות אנגליות קטנות, ספרות וקו תחתון בלבד');
  }
  if (isNew && existing.some(e => e.id === ex.id)) {
    errors.push(`המזהה "${ex.id}" כבר קיים במאגר`);
  }
  if (!(ex.name_he || '').trim()) errors.push('חסר שם התרגיל בעברית');
  if (!REGIONS.includes(ex.region)) errors.push('אזור גוף לא חוקי');
  if (!EQUIPMENT.includes(ex.equipment)) errors.push('ציוד לא חוקי');
  return errors;
}

/* ---------- auth ----------
   Local-only tool, but "local-only" isn't "no one else on this machine can
   reach it" — anyone with a browser tab pointed at localhost:8765 could edit
   or delete the whole library. A password gate is cheap insurance regardless
   of any wider deployment. No accounts, no sessions — one password, checked
   via HTTP Basic Auth on every request. Hashed with scrypt (Node built-in,
   no new dependency); the file holding the hash is gitignored.
   ---------------------------------------------------------------- */

function hasPassword() {
  return fs.existsSync(AUTH_PATH);
}

function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  fs.writeFileSync(AUTH_PATH, JSON.stringify({ salt, hash }), 'utf8');
}

function checkPassword(password) {
  if (!hasPassword()) return false;
  const { salt, hash } = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  const attempt = crypto.scryptSync(password || '', salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

function isAuthorized(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  return checkPassword(password);
}

function sendAuthRequired(res) {
  // Header VALUES must be Latin1 — Node throws on non-ASCII here, so the realm
  // stays in English even though everything the user actually reads is Hebrew.
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Exercise library admin", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('נדרשת סיסמה.');
}

// Shown once, before any password is set — a normal request never sees this after setup.
const SETUP_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8">
<title>הגדרת סיסמה — ניהול מאגר התרגילים</title>
<style>
  body{font-family:Assistant,Arial,sans-serif;background:#F6F6F1;color:#1E2B29;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  form{background:#fff;border:1px solid #DAD9CE;border-radius:8px;padding:32px;width:320px;}
  h1{font-size:18px;margin:0 0 8px;color:#2B4C4A;}
  p{font-size:13px;color:#5B6C69;margin:0 0 20px;line-height:1.5;}
  input{width:100%;padding:10px 12px;font-size:15px;border:1px solid #DAD9CE;border-radius:6px;
        margin-bottom:12px;box-sizing:border-box;font-family:inherit;}
  button{width:100%;padding:11px;font-size:14px;font-weight:700;background:#2B4C4A;color:#fff;
         border:none;border-radius:6px;cursor:pointer;font-family:inherit;}
  .err{color:#B85C6B;font-size:13px;margin-bottom:12px;}
</style></head><body>
<form method="POST" action="/api/setup-password">
  <h1>הגדרת סיסמה לכלי הניהול</h1>
  <p>פעם ראשונה בלבד. הסיסמה הזו תידרש בכל כניסה לכלי הניהול, בדפדפן הזה ובכל דפדפן אחר.</p>
  <div class="err" id="err"></div>
  <input type="password" name="password" placeholder="סיסמה (לפחות 6 תווים)" required minlength="6" autofocus>
  <input type="password" name="confirm" placeholder="אימות סיסמה" required minlength="6">
  <button type="submit">שמור והתחל</button>
</form>
<script>
  document.querySelector('form').addEventListener('submit', e=>{
    const p = document.querySelector('[name=password]').value;
    const c = document.querySelector('[name=confirm]').value;
    if (p !== c) { e.preventDefault(); document.getElementById('err').textContent = 'הסיסמאות לא תואמות'; }
  });
</script>
</body></html>`;

/* ---------- request helpers ---------- */

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => { chunks += c; });
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => {
      chunks += c;
      if (chunks.length > 30 * 1024 * 1024) { // 30MB guard
        reject(new Error('הבקשה גדולה מדי'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(chunks ? JSON.parse(chunks) : {}); }
      catch (e) { reject(new Error('גוף בקשה לא תקין')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/* ---------- routes ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  try {
    // --- first run: no password set yet — only the setup flow is reachable ---
    if (!hasPassword()) {
      if (req.method === 'GET' && (route === '/' || route === '/admin.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(SETUP_PAGE);
      }
      if (req.method === 'POST' && route === '/api/setup-password') {
        const raw = await readRawBody(req);
        const params = new URLSearchParams(raw);
        const password = params.get('password') || '';
        if (password.length < 6) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(SETUP_PAGE.replace('id="err"></div>', 'id="err">הסיסמה קצרה מדי</div>'));
        }
        setPassword(password);
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    // --- password is set — everything below requires it ---
    if (!isAuthorized(req)) return sendAuthRequired(res);

    // --- static: the admin page itself ---
    if (req.method === 'GET' && (route === '/' || route === '/admin.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // --- static: images, so the admin page can preview them ---
    if (req.method === 'GET' && route.startsWith('/images/')) {
      const name = path.basename(decodeURIComponent(route));
      const file = path.join(IMAGES_DIR, name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    // --- vocabularies + current library ---
    if (req.method === 'GET' && route === '/api/data') {
      return sendJSON(res, 200, {
        regions: REGIONS,
        equipment: EQUIPMENT,
        exercises: readExercises(),
        quickNotes: readQuickNotes()
      });
    }

    // --- replace the whole quick-notes bank (a short reusable-phrase list, not per-exercise) ---
    if (req.method === 'POST' && route === '/api/quick-notes') {
      const body = await readBody(req);
      const list = Array.isArray(body.notes) ? body.notes.map(str).filter(Boolean) : [];
      writeQuickNotes(list);
      return sendJSON(res, 200, { ok: true, quickNotes: list });
    }

    // --- create / update one exercise ---
    if (req.method === 'POST' && route === '/api/exercise') {
      const body = await readBody(req);
      const list = readExercises();
      const idx = list.findIndex(e => e.id === body.original_id);
      const isNew = idx === -1;

      const ex = {
        id: str(body.id),
        name_he: str(body.name_he),
        region: str(body.region),
        equipment: str(body.equipment),
        image_file: str(body.id) + '.png',
        default_sets: str(body.default_sets),
        default_reps: str(body.default_reps),
        instructions_he: str(body.instructions_he) || 'TODO',
        // Russian translation layer — optional, unvalidated. Empty means "not translated yet",
        // same convention as instructions_he:'TODO'. Never machine-generated by the server.
        name_ru: str(body.name_ru),
        instructions_ru: str(body.instructions_ru),
        default_reps_ru: str(body.default_reps_ru),
        updated_at: new Date().toISOString().slice(0, 10)
      };

      const errors = validate(ex, list, isNew || body.id !== body.original_id);
      if (errors.length) return sendJSON(res, 400, { ok: false, errors });

      // Image: optional on edit, required on create.
      if (body.image_data) {
        const b64 = body.image_data.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(IMAGES_DIR, ex.image_file), Buffer.from(b64, 'base64'));
      } else if (isNew) {
        return sendJSON(res, 400, { ok: false, errors: ['חובה לצרף תמונה לתרגיל חדש'] });
      } else if (body.id !== body.original_id) {
        // Renamed id with no new image — carry the old file over.
        const oldFile = path.join(IMAGES_DIR, body.original_id + '.png');
        if (fs.existsSync(oldFile)) fs.renameSync(oldFile, path.join(IMAGES_DIR, ex.image_file));
      }

      if (isNew) {
        list.push(ex);
      } else {
        // Preserve fields the form doesn't manage (e.g. image_prompt).
        list[idx] = { ...list[idx], ...ex };
      }
      writeExercises(list);
      return sendJSON(res, 200, { ok: true, exercises: list });
    }

    // --- delete ---
    if (req.method === 'POST' && route === '/api/delete') {
      const body = await readBody(req);
      let list = readExercises();
      const target = list.find(e => e.id === body.id);
      if (!target) return sendJSON(res, 404, { ok: false, errors: ['התרגיל לא נמצא'] });
      list = list.filter(e => e.id !== body.id);
      writeExercises(list);
      const img = path.join(IMAGES_DIR, target.image_file);
      if (fs.existsSync(img)) fs.unlinkSync(img);
      return sendJSON(res, 200, { ok: true, exercises: list });
    }

    // --- publish: commit + push so GitHub Pages rebuilds ---
    if (req.method === 'POST' && route === '/api/publish') {
      // Track commit and push separately: if commit succeeds but push fails
      // (no network, remote rejected, etc.), the change is saved locally but
      // NOT live — that distinction must reach the UI, not get flattened
      // into one generic "publish failed" message.
      let committed = false;
      try {
        git(['add', 'exercises.json', 'quick-notes.json', 'images', 'index.html', 'admin.html', 'admin-server.js', 'add-exercise.bat']);
        const status = git(['status', '--porcelain']).trim();
        if (!status) return sendJSON(res, 200, { ok: true, message: 'אין שינויים חדשים לפרסום' });

        git(['commit', '-m', 'Update exercise library']);
        committed = true;

        git(['push', 'origin', 'main']);
        return sendJSON(res, 200, { ok: true, message: 'פורסם. האתר יתעדכן תוך כדקה.' });
      } catch (e) {
        const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
        if (committed) {
          return sendJSON(res, 500, {
            ok: false,
            errors: [
              'השינוי נשמר במחשב הזה אבל לא עלה לאתר (הדחיפה ל-GitHub נכשלה).',
              'האתר החי עדיין מציג את הגרסה הקודמת. נסה "פרסם" שוב כשהרשת תחזור.',
              detail
            ]
          });
        }
        return sendJSON(res, 500, { ok: false, errors: ['הפרסום נכשל:', detail] });
      }
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    sendJSON(res, 500, { ok: false, errors: [err.message] });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ניהול מאגר התרגילים פועל.');
  console.log('  ' + addr);
  console.log('');
  console.log('  לסגירה: Ctrl+C בחלון הזה.');
  console.log('');
  try {
    execFileSync('cmd', ['/c', 'start', '', addr], { stdio: 'ignore' });
  } catch { /* browser will just have to be opened manually */ }
});
