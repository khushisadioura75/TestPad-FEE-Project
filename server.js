require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { OAuth2Client } = require("google-auth-library");
const { upsertUser, getUser, saveTest, getTests, getTest, saveTestResult, getTestResults, createSession, getSession, deleteSession } = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const TIMEOUT_MS = 10000;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || "placeholder");

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const session = getSession(header.slice(7));
  if (!session) {
    return res.status(401).json({ error: "Invalid session" });
  }
  req.userId = session.user_id;
  next();
}

app.get("/api/auth/me", (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const session = getSession(header.slice(7));
  if (!session) return res.status(401).json({ error: "Invalid session" });
  const user = getUser(session.user_id);
  if (!user) return res.status(401).json({ error: "Invalid session" });
  res.json({ user: { googleId: user.google_id, name: user.name, email: user.email, avatarUrl: user.avatar_url } });
});

app.post("/api/auth/guest", (req, res) => {
  try {
    const name = (req.body?.name || "Guest").toString().trim().slice(0, 40);
    const guestId = "guest_" + require("crypto").randomUUID();
    const user = { googleId: guestId, name: name || "Guest", email: null, avatarUrl: null };
    upsertUser(user);
    const token = createSession(user.googleId);
    res.json({ token, user: { googleId: user.googleId, name: user.name, email: user.email, avatarUrl: user.avatarUrl } });
  } catch (err) {
    console.error("Guest login error:", err.message);
    res.status(500).json({ error: "Could not sign in as guest" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    deleteSession(header.slice(7));
  }
  res.json({ ok: true });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Missing credential" });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID || "placeholder",
    });

    const payload = ticket.getPayload();
    const user = {
      googleId: payload.sub,
      name: payload.name,
      email: payload.email,
      avatarUrl: payload.picture,
    };

    upsertUser(user);
    const token = createSession(user.googleId);
    res.json({ token, user: { googleId: user.googleId, name: user.name, email: user.email, avatarUrl: user.avatarUrl } });
  } catch (err) {
    console.error("Google auth error:", err.message);
    res.status(401).json({ error: "Invalid credential" });
  }
});

app.post("/api/generate", requireAuth, async (req, res) => {
  try {
    const { topic, mcqCount, codingCount } = req.body;
    if (!topic || !topic.trim()) return res.status(400).json({ error: "Topic is required" });

    const prompt = `
Generate a coding test on the topic "${topic}".
Return ONLY valid JSON, no markdown, no explanation, no code fences.

For each coding question, the "starterCode" MUST be a COMPLETE, RUNNABLE Java program that:
1. Has a public class named "Main"
2. The student's solution goes in a static helper method with a "// TODO: implement this" comment and NO placeholder return value — the helper body is left EMPTY for the student to implement (do NOT add a default "return 0;" or any other default value)
3. THIS IS CRITICAL LAYOUT RULE: place the helper solution method at the TOP of the class (right after the opening brace), and place the "public static void main(String[] args)" method BELOW it, separated by AT LEAST 10 blank lines (so the user has a large writing zone above main and will very unlikely touch the main method).
4. "public static void main(String[] args)" reads input from stdin using Scanner, calls the solution helper, and prints ONLY the final result to stdout (no labels, no extra text)

Example of a correct starterCode string:
"import java.util.*;\\n\\npublic class Main {\\n    public static int addAndSubtract(int a, int b) {\\n        // TODO: implement this\\n    }\\n    \\n    \\n    \\n    \\n    \\n    \\n    \\n    \\n    \\n    \\n    \\n    public static void main(String[] args) {\\n        Scanner sc = new Scanner(System.in);\\n        int a = sc.nextInt();\\n        int b = sc.nextInt();\\n        System.out.println(addAndSubtract(a, b));\\n    }\\n}"

Example of a correctly formatted MCQ "code" field (EVERY line separated by \\n, never compressed):
"int x = 5;\\nint y = x++ + ++x;\\nSystem.out.println(y);"

WRONG (never do this): "int x = 5; int y = x++ + ++x; System.out.println(y);"
WRONG (never do this): "int x=5; int y=x+++ ++x; System.out.println(y);"

Return format exactly like this:
{
  "mcqs": [
    {
      "question": "string",
      "code": "optional short Java snippet to analyze (or null)",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "A"
    }
  ],
  "codingQuestions": [
    {
      "title": "string",
      "description": "string",
      "starterCode": "COMPLETE runnable Java program with public class Main, the helper method at top and a working main() method at least 10 blank lines below it",
      "testCases": [
        { "input": "space or newline separated values matching what Scanner expects", "expectedOutput": "expected printed output as a string" }
      ]
    }
  ]
}

MCQ requirements (CRITICAL):
- Every MCQ must be a HARD, advanced "guess the output" Java question. Present a short tricky Java code snippet in the "code" field and ask what it prints or returns.
- CRITICAL CODE FORMATTING RULE: The "code" field MUST be written line by line. Use the escape sequence \\n after EVERY logical line of code (after each semicolon, opening brace, or closing brace), with proper 4-space indentation for lines inside blocks. NEVER merge multiple statements onto one line, NEVER collapse the whole snippet into 2-3 lines, and NEVER omit the \\n between statements. Each statement of the snippet must start on its OWN line, exactly as a programmer would type it in an editor.
- Use genuinely tricky concepts: integer vs float division, evaluation order, operator precedence, short-circuit && / ||, String immutability, StringBuilder, autoboxing/Integer cache, array/2D-array mutation, null, exceptions thrown at runtime like NullPointerException/ArrayIndexOutOfBounds/ArithmeticException, static and instance initializer blocks, passing object references vs primitives, += / ++ / precedence traps, char arithmetic, ternary chains, String.format, switch fall-through, wrapper equals vs ==.
- Every snippet MUST compile and run (no compile errors), then output exactly one line (or knowingly throw a runtime exception — if so, the correct option states the exact exception name).
- The "code" field may be null ONLY when the question is purely conceptual (rare).
- Options must be 4 plausible outputs where EXACTLY ONE is correct, and it must ACTUALLY match what the snippet prints when run.
- Make each question DIFFERENT in the type of trick used — do not repeat the same concept twice.

Generate exactly ${mcqCount} MCQs and exactly ${codingCount} coding questions.
Each coding question must have EXACTLY 10 test cases with realistic, varied values (including edge cases like empty input, zeros, negatives, max values) matching the main method's Scanner reads. Do not repeat the same input pattern across multiple test cases.
`;

    const response = await fetch("https://api.inceptionlabs.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MERCURY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mercury-2.5",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Mercury API error:", response.status, errText);
      return res.status(502).json({ error: "AI model error. Try again." });
    }

    const data = await response.json();
    let rawText = data.choices?.[0]?.message?.content || "";
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    const result = JSON.parse(rawText);

    // Enforce: the helper (with the TODO) sits above main with an EMPTY body,
    // and main is at least 10 lines below the helper's closing brace so the
    // student writes in the helper, not in main. Output depends strictly on
    // the code the student writes — the AI may not sneak in a solution.
    sanitizeStarterCodes(result);

    res.json(result);
  } catch (err) {
    console.error("Generate error:", err.message);
    res.status(500).json({ error: "Failed to generate questions. Try again." });
  }
});

app.post("/run", (req, res) => {
  const { language, files, stdin } = req.body;

  if (language !== "java" || !files || !files.length) {
    return res.status(400).json({ error: "Only Java is supported." });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  let result = { run: { stdout: "", stderr: "", code: 1 } };

  try {
    const fileContent = files[0].content;
    fs.writeFileSync(path.join(tmpDir, "Main.java"), fileContent, "utf-8");

    const compile = spawnSync("javac", [path.join(tmpDir, "Main.java")], {
      timeout: TIMEOUT_MS,
      cwd: tmpDir,
      encoding: "utf-8",
    });

    if (compile.status !== 0) {
      result.run.stderr = compile.stderr || compile.stdout || "Compilation failed";
      return res.json(result);
    }

    const run = spawnSync("java", ["-cp", tmpDir, "Main"], {
      timeout: TIMEOUT_MS,
      cwd: tmpDir,
      encoding: "utf-8",
      input: stdin || "",
    });

    result.run.stdout = (run.stdout || "").trimEnd();
    result.run.stderr = (run.stderr || "").trimEnd();
    result.run.code = run.status;

    res.json(result);
  } catch (err) {
    result.run.stderr = err.message;
    res.json(result);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

app.post("/api/tests/save", requireAuth, (req, res) => {
  try {
    const { topic, mcqCount, codingCount, data } = req.body;
    const id = saveTest({ userGoogleId: req.userId, topic, mcqCount, codingCount, data });
    res.json({ id });
  } catch (err) {
    console.error("Save test error:", err.message);
    res.status(500).json({ error: "Failed to save test" });
  }
});

app.get("/api/tests", requireAuth, (req, res) => {
  try {
    const tests = getTests(req.userId);
    res.json({ tests });
  } catch (err) {
    console.error("Get tests error:", err.message);
    res.status(500).json({ error: "Failed to load tests" });
  }
});

app.get("/api/tests/:id", requireAuth, (req, res) => {
  try {
    const test = getTest(Number(req.params.id), req.userId);
    if (!test) return res.status(404).json({ error: "Test not found" });
    sanitizeStarterCodes(test.data);
    res.json(test);
  } catch (err) {
    console.error("Get test error:", err.message);
    res.status(500).json({ error: "Failed to load test" });
  }
});

app.post("/api/tests/:id/results", requireAuth, (req, res) => {
  try {
    const { answers, code, results } = req.body;
    const id = saveTestResult({ testId: Number(req.params.id), userGoogleId: req.userId, answers, code, results });
    res.json({ id });
  } catch (err) {
    console.error("Save result error:", err.message);
    res.status(500).json({ error: "Failed to save results" });
  }
});

app.get("/api/results", requireAuth, (req, res) => {
  try {
    const results = getTestResults(req.userId);
    res.json({ results });
  } catch (err) {
    console.error("Get results error:", err.message);
    res.status(500).json({ error: "Failed to load results" });
  }
});

function isDrillbenchFile(name) {
  return typeof name === "string" && /\.drillbench\.json$/i.test(name);
}

/* Locate the helper method (the one containing the TODO) and return its
   signature line index and closing-brace line index, or -1s. */
function findHelper(lines) {
  let openIdx = -1;
  let closeIdx = -1;
  let openLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\bTODO\b/.test(lines[i])) {
      openLine = i;
      break;
    }
  }
  if (openLine === -1) return { open: -1, close: -1 };

  for (let i = openLine; i >= 0; i--) {
    if (/\)\s*\{?\s*$/.test(lines[i]) && !lines[i].includes("main(") && !/\bclass\b/.test(lines[i])) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return { open: -1, close: -1 };

  let bal = 0;
  for (let i = openIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") bal++;
      else if (ch === "}") {
        bal--;
        if (bal === 0) {
          closeIdx = i;
          return { open: openIdx, close: closeIdx, openLine };
        }
      }
    }
  }
  return { open: openIdx, close: -1, openLine };
}

/* Empty out the helper's body so the student MUST write the logic. Keeps the
   signature, the empty braces, and the TODO comment. The only output a program
   can produce comes strictly from what the student writes. */
function stripHelperBody(code) {
  if (typeof code !== "string" || !code) return code;
  const lines = code.split("\n");
  const h = findHelper(lines);
  if (h.open === -1 || h.close === -1 || h.close <= h.open + 1) return code;
  const indent = (lines[h.open].match(/^\s*/) || [""])[0];
  const sig = lines[h.open].trimEnd().replace(/\s*\{\s*$/, "");
  const head = lines.slice(0, h.open);
  const tail = lines.slice(h.close + 1);
  return [...head, `${sig} {`, `${indent}    // TODO: implement this`, `${indent}}`, ...tail].join("\n");
}

/* Apply helper-emptying + layout normalization to every coding starter. */
function sanitizeStarterCodes(data) {
  if (!data || typeof data !== "object" || !data.codingQuestions) return data;
  (data.codingQuestions || []).forEach((q) => {
    if (typeof q.starterCode === "string" && q.starterCode) {
      q.starterCode = stripHelperBody(q.starterCode);
      q.starterCode = normalizeStarterCode(q.starterCode);
    }
  });
  return data;
}

/* Normalize starter code: ensure the helper method (with the TODO) is above
   main, and that "public static void main" sits at least 10 lines below the
   helper's closing brace. */
function normalizeStarterCode(code) {
  if (typeof code !== "string" || !code) return code;
  const lines = code.split("\n");
  const mainIdx = lines.findIndex((l) => /\bpublic\s+static\s+void\s+main\s*\(/.test(l));
  const todoIdx = lines.findIndex((l) => /\bTODO\b/.test(l));
  if (mainIdx === -1 || todoIdx === -1 || mainIdx < todoIdx) return code;

  const h = findHelper(lines);
  if (h.close === -1) return code;
  const closeIdx = h.close;
  if (closeIdx < todoIdx) return code;

  const required = closeIdx + 10; // 10 blank lines between helper end and main
  if (mainIdx >= required) return code;

  const pad = Array(required - mainIdx).fill("");
  lines.splice(mainIdx, 0, ...pad);
  return lines.join("\n");
}

function sanitizeFileName(name) {
  return (
    (name || "test").toString().trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) ||
    "test"
  );
}

function resolveFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) throw new Error("Missing folder path");
  const resolved = path.resolve(folder.trim());
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  if (!stat || !stat.isDirectory()) throw new Error("Folder does not exist");
  return resolved;
}

function getDriveLabel(letter) {
  try {
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Volume -DriveLetter ${letter}).FileSystemLabel`],
      { encoding: "utf-8", timeout: 5000, windowsHide: true }
    );
    const label = (out.stdout || "").trim();
    return label || "Local Disk";
  } catch (_) {
    return "Local Disk";
  }
}

app.get("/api/fs/drives", requireAuth, (req, res) => {
  try {
    const drives = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) {
          drives.push({ kind: "drive", name: `${letter}:`, label: getDriveLabel(letter), path: root });
        }
      } catch (_) {}
    }
    res.json({ drives });
  } catch (err) {
    console.error("FS drives error:", err.message);
    res.status(500).json({ error: "Could not list drives" });
  }
});

app.get("/api/fs/list", requireAuth, (req, res) => {
  try {
    const folder = resolveFolder(req.query.path);
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      const p = path.join(folder, ent.name);
      try {
        if (ent.isDirectory()) {
          items.push({ kind: "folder", name: ent.name, path: p });
        } else if (ent.isFile()) {
          const s = fs.statSync(p);
          if (isDrillbenchFile(ent.name)) {
            items.push({
              kind: "test",
              name: ent.name.replace(/\.drillbench\.json$/i, ""),
              path: p,
              size: s.size,
              mtime: s.mtimeMs,
            });
          } else {
            items.push({ kind: "file", name: ent.name, path: p, size: s.size, mtime: s.mtimeMs });
          }
        }
      } catch (_) {}
    }
    const order = { folder: 0, test: 1, file: 2 };
    items.sort(
      (a, b) =>
        order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );
    res.json({ folder, items });
  } catch (err) {
    console.error("FS list error:", err.message);
    res.status(400).json({ error: err.message || "Could not list folder" });
  }
});

app.get("/api/fs/test", requireAuth, (req, res) => {
  try {
    const p = path.resolve(String(req.query.path || ""));
    if (!isDrillbenchFile(path.basename(p))) throw new Error("Not a Drillbench test file");
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (parsed.kind !== "drillbench" || !parsed.data) throw new Error("Invalid Drillbench test file");
    sanitizeStarterCodes(parsed.data);
    res.json({
      path: p,
      topic: parsed.topic,
      mcqCount: parsed.mcqCount,
      codingCount: parsed.codingCount,
      data: parsed.data,
      savedAt: parsed.savedAt,
    });
  } catch (err) {
    console.error("FS read test error:", err.message);
    res.status(400).json({ error: err.message || "Could not load test" });
  }
});

app.post("/api/fs/save", requireAuth, (req, res) => {
  try {
    const { folder, topic, mcqCount, codingCount, data, fileName, overwrite } = req.body;
    const dir = resolveFolder(folder);
    const name = sanitizeFileName(fileName || topic || "test") + ".drillbench.json";
    const p = path.join(dir, name);
    const plainName = name.replace(/\.drillbench\.json$/i, "");
    if (fs.existsSync(p) && !overwrite) {
      return res.json({ exists: true, path: p, name: plainName });
    }
    fs.writeFileSync(
      p,
      JSON.stringify(
        { kind: "drillbench", version: 1, topic, mcqCount, codingCount, data, savedAt: new Date().toISOString() },
        null,
        2
      ),
      "utf-8"
    );
    res.json({ path: p, name: plainName });
  } catch (err) {
    console.error("FS save error:", err.message);
    res.status(400).json({ error: err.message || "Could not save test" });
  }
});

app.post("/api/fs/folder", requireAuth, (req, res) => {
  try {
    const { parent, name } = req.body;
    const dir = resolveFolder(parent);
    const safe = sanitizeFileName(name || "New Folder");
    const p = path.join(dir, safe);
    fs.mkdirSync(p, { recursive: false });
    res.json({ path: p, name: safe });
  } catch (err) {
    console.error("FS folder error:", err.message);
    res.status(400).json({ error: err.message || "Could not create folder" });
  }
});

app.post("/api/fs/move", requireAuth, (req, res) => {
  try {
    const { from, toFolder } = req.body;
    const src = path.resolve(String(from || ""));
    if (!isDrillbenchFile(path.basename(src))) throw new Error("Only Drillbench test files can be moved");
    const dest = resolveFolder(toFolder);
    const target = path.join(dest, path.basename(src));
    fs.renameSync(src, target);
    res.json({ path: target });
  } catch (err) {
    console.error("FS move error:", err.message);
    res.status(400).json({ error: err.message || "Could not move test" });
  }
});

app.delete("/api/fs/test", requireAuth, (req, res) => {
  try {
    const p = path.resolve(String(req.query.path || ""));
    if (!isDrillbenchFile(path.basename(p))) throw new Error("Not a Drillbench test file");
    fs.rmSync(p, { force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("FS delete error:", err.message);
    res.status(400).json({ error: err.message || "Could not delete test" });
  }
});

/* ---------- Image analysis + batch generation ---------- */

app.post("/api/analyze-image", requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });

    const prompt = `Analyze this image. It likely contains a list of programming/computer science topics (like custom exceptions, file handling, collections, multithreading, etc.).

Extract ALL topic names from the image and return ONLY a valid JSON array of strings, no markdown, no explanation.

Example output:
["Custom Exceptions", "File Handling", "Collections", "Multithreading"]`;

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + process.env.REACT_APP_GEMINI_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/png", data: imageBase64 } }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      return res.status(502).json({ error: "AI analysis failed. Try again." });
    }

    const data = await response.json();
    let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    const topics = JSON.parse(rawText);
    if (!Array.isArray(topics)) throw new Error("Invalid response format");

    res.json({ topics: topics.map(t => String(t).trim()).filter(Boolean) });
  } catch (err) {
    console.error("Analyze image error:", err.message);
    res.status(500).json({ error: "Failed to analyze image. Try again." });
  }
});

app.post("/api/generate-batch", requireAuth, async (req, res) => {
  try {
    const { topics } = req.body;
    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      return res.status(400).json({ error: "No topics provided" });
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      try {
        const prompt = `
Generate a coding test on the topic "${topic}".
Return ONLY valid JSON, no markdown, no explanation, no code fences.

For each coding question, the "starterCode" MUST be a COMPLETE, RUNNABLE Java program that:
1. Has a public class named "Main"
2. The student's solution goes in a static helper method with a "// TODO: implement this" comment and NO placeholder return value — the helper body is left EMPTY for the student to implement (do NOT add a default "return 0;" or any other default value)
3. THIS IS CRITICAL LAYOUT RULE: place the helper solution method at the TOP of the class (right after the opening brace), and place the "public static void main(String[] args)" method BELOW it, separated by AT LEAST 10 blank lines (so the user has a large writing zone above main and will very unlikely touch the main method).
4. "public static void main(String[] args)" reads input from stdin using Scanner, calls the solution helper, and prints ONLY the final result to stdout (no labels, no extra text)

Example of a correctly formatted MCQ "code" field (EVERY line separated by \\n, never compressed):
"int x = 5;\\nint y = x++ + ++x;\\nSystem.out.println(y);"

WRONG (never do this): "int x = 5; int y = x++ + ++x; System.out.println(y);"
WRONG (never do this): "int x=5; int y=x+++ ++x; System.out.println(y);"

Return format exactly like this:
{
  "mcqs": [
    {
      "question": "string",
      "code": "optional short Java snippet to analyze (or null)",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "A"
    }
  ],
  "codingQuestions": [
    {
      "title": "string",
      "description": "string",
      "starterCode": "COMPLETE runnable Java program with public class Main",
      "testCases": [
        { "input": "space or newline separated values matching what Scanner expects", "expectedOutput": "expected printed output as a string" }
      ]
    }
  ]
}

MCQ requirements (CRITICAL):
- Every MCQ must be a HARD, advanced "guess the output" Java question. Present a short tricky Java code snippet in the "code" field and ask what it prints or returns.
- CRITICAL CODE FORMATTING RULE: The "code" field MUST be written line by line. Use the escape sequence \\n after EVERY logical line of code (after each semicolon, opening brace, or closing brace), with proper 4-space indentation for lines inside blocks. NEVER merge multiple statements onto one line, NEVER collapse the whole snippet into 2-3 lines, and NEVER omit the \\n between statements. Each statement of the snippet must start on its OWN line, exactly as a programmer would type it in an editor.
- Use genuinely tricky concepts: integer vs float division, evaluation order, operator precedence, short-circuit && / ||, String immutability, StringBuilder, autoboxing/Integer cache, array/2D-array mutation, null, exceptions thrown at runtime like NullPointerException/ArrayIndexOutOfBounds/ArithmeticException, static and instance initializer blocks, passing object references vs primitives, += / ++ / precedence traps, char arithmetic, ternary chains, String.format, switch fall-through, wrapper equals vs ==.
- Every snippet MUST compile and run (no compile errors), then output exactly one line (or knowingly throw a runtime exception — if so, the correct option states the exact exception name).
- The "code" field may be null ONLY when the question is purely conceptual (rare).
- Options must be 4 plausible outputs where EXACTLY ONE is correct, and it must ACTUALLY match what the snippet prints when run.
- Make each question DIFFERENT in the type of trick used — do not repeat the same concept twice.

Generate exactly 1 MCQ and exactly 1 coding question.
Each coding question must have EXACTLY 3 test cases with realistic, varied values (including edge cases like empty input, zeros, negatives, max values) matching the main method's Scanner reads. Do not repeat the same input pattern across multiple test cases.
`;

        const response = await fetch("https://api.inceptionlabs.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.MERCURY_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "mercury-2.5",
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!response.ok) {
          throw new Error(`AI model error for topic "${topic}"`);
        }

        const data = await response.json();
        let rawText = data.choices?.[0]?.message?.content || "";
        rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

        const parsed = JSON.parse(rawText);
        sanitizeStarterCodes(parsed);
        results.push({ topic, mcqs: parsed.mcqs || [], codingQuestions: parsed.codingQuestions || [] });
      } catch (err) {
        console.error(`Batch gen error for "${topic}":`, err.message);
        errors.push({ topic, error: err.message });
      }
    }

    res.json({ results, errors });
  } catch (err) {
    console.error("Batch generation error:", err.message);
    res.status(500).json({ error: "Failed to generate batch. Try again." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("TestPad server running on http://localhost:" + PORT);
});
