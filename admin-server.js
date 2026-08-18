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
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const JSON_PATH = path.join(ROOT, 'exercises.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const PORT = 8765;

// Closed vocabularies — the whole point is that these can't drift.
const REGIONS = ['shoulder', 'cervical', 'thoracic', 'lumbar', 'hip', 'knee', 'ankle', 'wrist'];
const EQUIPMENT = ['none', 'resistance band', 'chair', 'wall', 'small ball'];

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

/* ---------- request helpers ---------- */

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
        exercises: readExercises()
      });
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
        git(['add', 'exercises.json', 'images', 'index.html', 'admin.html', 'admin-server.js', 'add-exercise.bat']);
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
