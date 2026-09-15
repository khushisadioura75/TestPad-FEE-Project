import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { generateQuestions } from "./geminiService";
import { runCode, runCodeWithStdin } from "./pistonService";
import {
  exchangeGoogleCredential,
  loginAsGuest,
  logout,
  fetchAuthUser,
  storeSession,
  clearSession,
  getToken,
  saveTest,
  fetchTests,
  fetchTest,
  saveTestResults,
  fetchDrives,
  listFsFolder,
  fetchFsTest,
  saveTestToFolder,
  createFolder,
  moveTestFile,
  deleteTestFile,
} from "./apiService";
import "./App.css";

// ---------------------------------------------------------------------------
// "ResizeObserver loop completed with undelivered notifications." is a
// benign browser warning, not a real error: it fires when an observer's
// callback triggers another resize in the same frame (which is exactly
// what happens when the F11 fullscreen toggle resizes .stage-inner.coding
// while Monaco's own internal ResizeObserver is laying out the editor).
// Nothing breaks and no state is lost, but Create React App's dev overlay
// treats any uncaught window "error" event as a fatal crash screen. This
// registers once, before the error can occur, to stop it from propagating
// to that overlay and to tear the overlay down if it still slips through.
if (process.env.NODE_ENV === "development") {
  const isBenignResizeObserverError = (message) =>
    typeof message === "string" &&
    (message.includes("ResizeObserver loop completed with undelivered notifications") ||
      message.includes("ResizeObserver loop limit exceeded"));

  const hideDevOverlay = () => {
    document.getElementById("webpack-dev-server-client-overlay")?.remove();
    document.getElementById("webpack-dev-server-client-overlay-div")?.remove();
  };

  window.addEventListener("error", (e) => {
    if (isBenignResizeObserverError(e.message)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      setTimeout(hideDevOverlay, 0);
    }
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reasonMessage = e.reason?.message || String(e.reason || "");
    if (isBenignResizeObserverError(reasonMessage)) {
      e.preventDefault();
      setTimeout(hideDevOverlay, 0);
    }
  });
}

const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;

function loadGisScript() {
  return new Promise((resolve) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.body.appendChild(script);
  });
}

function buildTestTerminal(results) {
  const errors = [...new Set((results || []).map((r) => r.error).filter(Boolean))];
  if (errors.length > 0) {
    return `[ERROR]\n${errors.join("\n\n")}`;
  }
  return "";
}

function buildCustomTerminal(output) {
  if (!output) return "";
  if (output.error) {
    const detail = String(output.stderr || output.error).trim();
    return `[ERROR] exit ${output.code ?? "?"}\n${detail || "program failed"}`;
  }
  return String(output.stdout || "").trim() || "(no output)";
}

function computeScore(data, answers, testResults) {
  let earned = 0;
  let total = 0;
  (data.mcqs || []).forEach((m, i) => {
    total += 1;
    if (answers[i] === m.correctAnswer) earned += 1;
  });
  (data.codingQuestions || []).forEach((cq, ci) => {
    total += (cq.testCases || []).length;
    const res = testResults[ci];
    if (res) earned += res.filter((r) => r.passed).length;
  });
  return { earned, total };
}

function App() {
  const [topic, setTopic] = useState("");
  const [mcqCount, setMcqCount] = useState("5");
  const [codingCount, setCodingCount] = useState("2");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [testId, setTestId] = useState(null);

  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [studentCode, setStudentCode] = useState({});
  const [testResults, setTestResults] = useState({});
  const [runningIndex, setRunningIndex] = useState(null);
  const [codeStarts, setCodeStarts] = useState({});
  const [codeTimes, setCodeTimes] = useState({});
  const [customInputs, setCustomInputs] = useState({});
  const [customOpen, setCustomOpen] = useState({});
  const [customRuns, setCustomRuns] = useState({});
  const [terminals, setTerminals] = useState({});

  const [activeIndex, setActiveIndex] = useState(0);

  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const [toasts, setToasts] = useState([]);
  const tokenRef = useRef(getToken());
  const googleBtnRef = useRef(null);

  const [submission, setSubmission] = useState(null);
  const [explorerOpen, setExplorerOpen] = useState(false);

  const questionScrollRef = useRef(null);
  const questionDragState = useRef({ dragging: false, startY: 0, scrollStart: 0 });

  // Tracks the numbered question list's scroll geometry so the custom,
  // always-visible track/thumb rendered beside it (.q-grid-track /
  // .q-grid-thumb) can be positioned in JS rather than relying on the
  // browser's native (hover-only) scrollbar.
  const [gridMetrics, setGridMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });

  const updateGridMetrics = useCallback(() => {
    const el = questionScrollRef.current;
    if (!el) return;
    setGridMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, []);

  const handleDragMove = useCallback(
    (e) => {
      if (!questionDragState.current.dragging || !questionScrollRef.current) return;
      const delta = questionDragState.current.startY - e.clientY;
      questionScrollRef.current.scrollTop = questionDragState.current.scrollStart + delta;
      updateGridMetrics();
    },
    [updateGridMetrics]
  );

  const handleDragEnd = useCallback(() => {
    questionDragState.current.dragging = false;
  }, []);

  const handleQuestionDragStart = (e) => {
    questionDragState.current = { dragging: true, startY: e.clientY, scrollStart: questionScrollRef.current?.scrollTop || 0 };
  };

  useEffect(() => {
    window.addEventListener("mousemove", handleDragMove);
    window.addEventListener("mouseup", handleDragEnd);
    return () => {
      window.removeEventListener("mousemove", handleDragMove);
      window.removeEventListener("mouseup", handleDragEnd);
    };
  }, [handleDragMove, handleDragEnd]);

  // ---- toasts ----
  const pushToast = useCallback((message, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  // ---- auth bootstrap ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadGisScript();
      const token = getToken();
      if (token) {
        try {
          const savedUser = await fetchAuthUser();
          if (cancelled) return;
          setUser(savedUser);
          try {
            const { tests } = await fetchTests(token);
            if (!cancelled) setHistory(tests);
          } catch (err) {
            console.error("Failed to load history:", err);
          }
        } catch (err) {
          console.warn("Stale session, clearing:", err.message);
          clearSession();
          if (!cancelled) setAuthReady(true);
          return;
        }
      }
      if (!cancelled) setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- Google identity service ----
  useEffect(() => {
    if (!user && authReady && window.google?.accounts?.id && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes("YOUR_GOOGLE")) {
      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async (response) => {
            try {
              const { token, user: profile } = await exchangeGoogleCredential(response.credential);
              tokenRef.current = token;
              storeSession(token, profile);
              setUser(profile);
              pushToast(`Welcome, ${profile.name?.split(" ")[0] || "friend"}!`, "success");
              try {
                const { tests } = await fetchTests(token);
                setHistory(tests);
              } catch (_) {}
            } catch (err) {
              pushToast(err.message || "Login failed", "error");
            }
          },
        });
        if (googleBtnRef.current) {
          window.google.accounts.id.renderButton(googleBtnRef.current, {
            type: "standard",
            theme: "outline",
            size: "medium",
            shape: "pill",
            text: "signin_with",
          });
        }
      } catch (err) {
        console.error("GIS init failed:", err);
      }
    }
  }, [user, authReady, pushToast]);

  const handleGuestLogin = async () => {
    try {
      const { token, user: profile } = await loginAsGuest();
      tokenRef.current = token;
      storeSession(token, profile);
      setUser(profile);
      pushToast(`Welcome, ${profile.name || "Guest"}!`, "success");
      try {
        const { tests } = await fetchTests(token);
        setHistory(tests);
      } catch (_) {}
    } catch (err) {
      pushToast(err.message || "Could not sign in as guest", "error");
    }
  };

  // ---- load a previously saved test ----
  const loadSavedTest = useCallback(
    async (id) => {
      let entry;
      try {
        const test = await fetchTest(getToken(), id);
        entry = { ...test, id };
      } catch (err) {
        pushToast(err.message || "Could not load test", "error");
        return;
      }
      setTopic(entry.topic);
      setMcqCount(entry.mcqCount);
      setCodingCount(entry.codingCount);
      setData(entry.data);
      setTestId(entry.id);
      const initialCode = {};
      (entry.data.codingQuestions || []).forEach((q, idx) => {
        initialCode[idx] = q.starterCode || "";
      });
      setStudentCode(initialCode);
      setSelectedAnswers({});
      setTestResults({});
      setActiveIndex(0);
      setError("");
      setShowHistory(false);
      setSubmission(null);
    },
    [pushToast]
  );

  // initial load from URL (?test=ID)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("test");
    if (id && user) {
      loadSavedTest(Number(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleGenerate = async () => {
    if (!topic.trim()) {
      pushToast("Please enter a topic.", "error");
      return;
    }
    const token = tokenRef.current;
    if (!token || !user) {
      pushToast("Please sign in to generate a test.", "error");
      return;
    }

    setError("");
    setLoading(true);
    setData(null);
    setSelectedAnswers({});
    setStudentCode({});
    setTestResults({});
    setActiveIndex(0);
    setSubmission(null);

    try {
      const result = await generateQuestions(topic, mcqCount, codingCount, token);
      setData(result);

      const initialCode = {};
      (result.codingQuestions || []).forEach((q, idx) => {
        initialCode[idx] = q.starterCode || "";
      });
      setStudentCode(initialCode);

      let newTestId = null;
      try {
        const saved = await saveTest({ token, topic, mcqCount, codingCount, data: result });
        newTestId = saved.id;
        setTestId(newTestId);
        const { tests } = await fetchTests(token);
        setHistory(tests);
      } catch (err) {
        console.warn("Could not persist test:", err);
      }

      try {
        if (newTestId) {
          window.history.replaceState(null, "", `?test=${newTestId}`);
        }
      } catch (_) {}

      pushToast("Drill generated!", "success");
    } catch (err) {
      console.error(err);
      pushToast(err.message || "Something went wrong generating questions. Try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleRunCode = async (index, question) => {
    setRunningIndex(index);
    setCustomOpen((prev) => ({ ...prev, [index]: false }));
    setCustomRuns((prev) => ({ ...prev, [index]: false }));
    if (codeStarts[index]) {
      setCodeTimes((prev) => ({ ...prev, [index]: Date.now() - codeStarts[index] }));
    }
    try {
      const results = await runCode(studentCode[index], question.testCases);
      setTestResults((prev) => ({ ...prev, [index]: results }));
      setTerminals((prev) => ({ ...prev, [index]: buildTestTerminal(results) }));
      const passedCount = results.filter((r) => r.passed).length;
      if (passedCount === results.length) {
        pushToast(`All ${results.length} test cases passed!`, "success");
      } else {
        pushToast(`${passedCount}/${results.length} test cases passed`, "info");
      }
      if (testId && user) {
        try {
          const updated = { ...testResults, [index]: results };
          await saveTestResults({ token: tokenRef.current, testId, answers: selectedAnswers, code: studentCode, results: updated });
        } catch (_) {}
      }
    } catch (err) {
      console.error(err);
      pushToast("Code execution failed. Is the Java server running?", "error");
    } finally {
      setRunningIndex(null);
    }
  };

  const handleRunCustom = async (index) => {
    setRunningIndex(index);
    setCustomRuns((prev) => ({ ...prev, [index]: true }));
    try {
      const output = await runCodeWithStdin(studentCode[index], customInputs[index] || "");
      setTerminals((prev) => ({ ...prev, [index]: buildCustomTerminal(output) }));
    } catch (err) {
      console.error(err);
      pushToast("Code execution failed. Is the Java server running?", "error");
    } finally {
      setRunningIndex(null);
    }
  };

  const handleCodeChange = (index, value) => {
    setStudentCode((prev) => ({ ...prev, [index]: value }));
    if (value && value.trim() && !codeStarts[index]) {
      setCodeStarts((prev) => ({ ...prev, [index]: Date.now() }));
    }
  };

  const goToQuestion = (i) => {
    setActiveIndex(i);
  };

  const handleSubmitTest = async () => {
    if (testId && user) {
      try {
        await saveTestResults({ token: tokenRef.current, testId, answers: selectedAnswers, code: studentCode, results: testResults });
      } catch (_) {}
    }
    const score = data ? computeScore(data, selectedAnswers, testResults) : { earned: 0, total: 0 };
    setSubmission(score);
    pushToast(`Test submitted! Score: ${score.earned}/${score.total}`, "success");
  };

  const loadPcTest = async (filePath) => {
    try {
      const t = await fetchFsTest(getToken(), filePath);
      setTopic(t.topic);
      setMcqCount(t.mcqCount);
      setCodingCount(t.codingCount);
      setData(t.data);
      setTestId(null);
      const initialCode = {};
      (t.data.codingQuestions || []).forEach((q, idx) => {
        initialCode[idx] = q.starterCode || "";
      });
      setStudentCode(initialCode);
      setSelectedAnswers({});
      setTestResults({});
      setActiveIndex(0);
      setError("");
      setExplorerOpen(false);
      setSubmission(null);
      pushToast("Loaded test from PC", "success");
    } catch (err) {
      pushToast(err.message || "Could not load test from PC", "error");
    }
  };

  const handleUseHistoryEntry = (id) => {
    loadSavedTest(id);
  };

  const handleExit = () => {
    setData(null);
    setShowHistory(false);
    setTestId(null);
    setSubmission(null);
    window.history.replaceState(null, "", window.location.pathname);
  };

  const handleLogout = () => {
    logout(tokenRef.current);
    clearSession();
    setUser(null);
    setData(null);
    setHistory([]);
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    window.location.href = window.location.pathname;
  };

  const answeredCount = Object.keys(selectedAnswers).length;
  const codingDone = Object.keys(testResults).length;

  // Build a unified list
  const combinedList = data
    ? [
        ...data.mcqs.map((q, idx) => ({ type: "mcq", data: q, idx })),
        ...data.codingQuestions.map((q, idx) => ({ type: "coding", data: q, idx })),
      ]
    : [];

  const activeItem = combinedList[activeIndex];

  // Recompute the scroll-track geometry whenever the underlying list
  // changes size (new test generated/loaded) or the viewport resizes.
  useEffect(() => {
    updateGridMetrics();
    window.addEventListener("resize", updateGridMetrics);
    return () => window.removeEventListener("resize", updateGridMetrics);
  }, [data, updateGridMetrics]);

  const gridScrollable = combinedList.length > 17;
  const thumbHeightPct =
    gridMetrics.scrollHeight > 0
      ? Math.max(8, (gridMetrics.clientHeight / gridMetrics.scrollHeight) * 100)
      : 100;
  const maxScroll = gridMetrics.scrollHeight - gridMetrics.clientHeight;
  const thumbTopPct = maxScroll > 0 ? (gridMetrics.scrollTop / maxScroll) * (100 - thumbHeightPct) : 0;

  return (
    <div className="app-shell">
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}

      <FileExplorer
        open={explorerOpen}
        onClose={() => setExplorerOpen(false)}
        onLoadTest={loadPcTest}
        canSave={!!data}
        topic={topic}
        mcqCount={mcqCount}
        codingCount={codingCount}
        data={data}
        pushToast={pushToast}
      />

      <header className="app-header">
        <span className="app-brand" onClick={handleExit} style={{ cursor: "pointer" }}>
          TestPad
        </span>
        <div className="app-header-actions">
{user ? (
            <>
              <div className="user-chip" title={user.email || user.name || "User"}>
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="user-avatar" />
                ) : (
                  <span className="user-avatar user-avatar-fallback">
                    {(user.name || "G").charAt(0)}
                  </span>
                )}
                <span className="user-name">{user.name ? user.name.split(" ")[0] : "Guest"}</span>
              </div>
              <button className="icon-btn" title="Sign out" onClick={handleLogout}>
                ⎋
              </button>
            </>
          ) : (
            <div className="login-actions">
              <div ref={googleBtnRef}></div>
              <button className="guest-btn" onClick={handleGuestLogin}>
                Continue as guest
              </button>
            </div>
          )}
        </div>

        {showHistory && (
          <div className="history-panel">
            <div className="history-panel-head">
              <span>History</span>
              <button className="icon-btn" onClick={() => setShowHistory(false)}>
                ✕
              </button>
            </div>

            {history.length === 0 ? (
              <p className="history-empty">No drills generated yet.</p>
            ) : (
              <div className="history-list">
                {history.map((entry) => (
                  <button
                    key={entry.id}
                    className="history-item"
                    onClick={() => handleUseHistoryEntry(entry.id)}
                  >
                    <span className="history-item-topic">{entry.topic}</span>
                    <span className="history-item-meta">
                      {entry.mcqCount} mcq · {entry.codingCount} coding ·{" "}
                      {new Date(entry.createdAt + "Z").toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      {!data ? (
        <div className="landing">
          <div className="landing-inner">
            {user ? (
              <p className="tagline">
                Enter a topic, generate MCQs + coding questions, and test your code instantly.
              </p>
            ) : (
              <p className="tagline">
                Sign in with Google — or just continue as guest — to generate, save, and track your drills.
              </p>
            )}

            <div className="panel corner-bracket">
              <label className="field-label" htmlFor="topic">
                Topic
              </label>
              <input
                id="topic"
                className="topic-input"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
                disabled={!user}
                autoComplete="off"
                name="topic"
              />
              {!user && <p className="inline-hint">Sign in or continue as guest to generate.</p>}

              <div className="count-row">
                <label>
                  <span>MCQs</span>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    value={mcqCount}
                    onChange={(e) => setMcqCount(e.target.value === "" ? 0 : Number(e.target.value))}
                    onFocus={(e) => e.target.select()}
                    disabled={!user}
                  />
                </label>
                <label>
                  <span>Coding questions</span>
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={codingCount}
                    onChange={(e) => setCodingCount(e.target.value === "" ? 0 : Number(e.target.value))}
                    onFocus={(e) => e.target.select()}
                    disabled={!user}
                  />
                </label>
              </div>

              <button className="primary-btn" onClick={handleGenerate} disabled={loading || !user}>
                {loading ? (
                  <span className="spinner-wrap">
                    <span className="spinner" /> Creating test…
                  </span>
                ) : (
                  <>
                    <span className="btn-icon">✨</span> Create Test
                  </>
                )}
              </button>

              {user && (
                <button className="open-test-btn" onClick={() => setExplorerOpen(true)}>
                  <span className="btn-icon">🗔</span> Open Test
                </button>
              )}
            </div>

            {error && <p className="error">{error}</p>}

          </div>
        </div>
      ) : (
        <div className="test-shell">
          <aside className="sidebar">
            <div className="sidebar-header">
              <span className="sidebar-title">{topic}</span>
            </div>

            <button className="save-test-sidebar-btn" onClick={() => setExplorerOpen(true)}>
              Save
            </button>

            <div className="progress-bar">
              <div
                className="progress-bar-fill"
                style={{
                  width: `${combinedList.length ? ((answeredCount + codingDone) / combinedList.length) * 100 : 0}%`,
                }}
              />
            </div>

            {/* Wrapper pairs the question grid with its own dedicated, always-
                visible scroll track (rendered as a sibling .q-grid-track div,
                not the native browser scrollbar) once the list exceeds 17
                items. */}
            <div className={`q-grid-outer ${gridScrollable ? "has-own-scroll" : ""}`}>
              <div
                className={`q-grid ${gridScrollable ? "q-grid-scroll" : "q-grid-fixed"}`}
                ref={questionScrollRef}
                onMouseDown={gridScrollable ? handleQuestionDragStart : undefined}
                onScroll={gridScrollable ? updateGridMetrics : undefined}
              >
                {combinedList.map((item, idx) => {
                  const isMcq = item.type === "mcq";
                  const answered = isMcq
                    ? selectedAnswers[item.idx] !== undefined
                    : testResults[item.idx] !== undefined;
                  const isFirstMcq = idx === 0 && isMcq;
                  const isFirstCoding = !isMcq && (idx === 0 || combinedList[idx - 1]?.type === "mcq");
                  return (
                    <React.Fragment key={`${item.type}-${item.idx}`}>
                      {isFirstMcq && <div className="q-section-label">MCQs</div>}
                      {isFirstCoding && <div className="q-section-label">Coding</div>}
                      <div className="q-item">
                        <button
                          className={`q-btn ${activeIndex === idx ? "active" : ""} ${
                            answered ? "answered" : ""
                          }`}
                          onClick={() => goToQuestion(idx)}
                        >
                          {idx + 1}
                        </button>
                        {answered && <span className="q-tick">✓</span>}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
              {gridScrollable && (
                <div className="q-grid-track">
                  <div
                    className="q-grid-thumb"
                    style={{ height: `${thumbHeightPct}%`, top: `${thumbTopPct}%` }}
                  />
                </div>
              )}
            </div>
            <div className="sidebar-counter">{activeIndex + 1}/{combinedList.length}</div>
          </aside>

          <main className="question-stage">
            {activeItem?.type === "mcq" && (
              <MCQView
                question={activeItem.data}
                idx={activeItem.idx}
                selected={selectedAnswers[activeItem.idx]}
                onSelect={(opt) =>
                  setSelectedAnswers((prev) => ({ ...prev, [activeItem.idx]: opt }))
                }
              />
            )}

            {activeItem?.type === "coding" && (
              <CodingView
                question={activeItem.data}
                idx={activeItem.idx}
                code={studentCode[activeItem.idx]}
                onCodeChange={(value) => handleCodeChange(activeItem.idx, value)}
                startTime={codeStarts[activeItem.idx]}
                tookMs={codeTimes[activeItem.idx]}
                results={testResults[activeItem.idx]}
                onRun={() => {
                  const hasCustom = (customInputs[activeItem.idx] || "").trim().length > 0;
                  if (hasCustom) handleRunCustom(activeItem.idx);
                  else handleRunCode(activeItem.idx, activeItem.data);
                }}
                running={runningIndex === activeItem.idx}
                customInput={customInputs[activeItem.idx]}
                onCustomInputChange={(v) =>
                  setCustomInputs((prev) => ({ ...prev, [activeItem.idx]: v }))
                }
                customOpen={!!customOpen[activeItem.idx]}
                customRan={!!customRuns[activeItem.idx]}
                onCustomToggle={() => {
                  const idx = activeItem.idx;
                  const next = !customOpen[idx];
                  setCustomOpen((prev) => ({ ...prev, [idx]: next }));
                  if (!next) {
                    setCustomRuns((prev) => ({ ...prev, [idx]: false }));
                    setCustomInputs((prev) => ({ ...prev, [idx]: "" }));
                    setTerminals((prev) => ({ ...prev, [idx]: "" }));
                  }
                }}
                onCloseTerminal={() => {
                  const idx = activeItem.idx;
                  setTerminals((prev) => ({ ...prev, [idx]: "" }));
                  setCustomOpen((prev) => ({ ...prev, [idx]: false }));
                  setCustomRuns((prev) => ({ ...prev, [idx]: false }));
                  setCustomInputs((prev) => ({ ...prev, [idx]: "" }));
                }}
                terminal={terminals[activeItem.idx]}
                isLast={activeIndex === combinedList.length - 1}
                onSubmit={handleSubmitTest}
              />
            )}
          </main>
        </div>
      )}

      {submission && data && (
        <div className="submission-screen">
          <div className="submission-card">
            <div className="submission-check">✓</div>
            <div className="submission-title">Test Submitted</div>
            <div className="submission-score">{submission.earned}</div>
            <div className="submission-total">out of {submission.total} marks</div>
            <div className="submission-sub">
              1 mark per MCQ · 1 mark per passing test case
            </div>
            <button
              className="primary-btn"
              onClick={() => {
                setSubmission(null);
                handleExit();
              }}
            >
              New Test
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MCQView({ question, idx, selected, onSelect }) {
  return (
    <div className="stage-inner">
      <div className="section-label">Multiple Choice</div>
      <div className="mcq-layout">
        <div className="mcq-prompt">
          <div className="stage-header">
            <span className="stage-tag">MCQ {String(idx + 1).padStart(2, "0")}</span>
          </div>
          <h2 className="stage-question">{question.question}</h2>

          {question.code && (
            <pre className="mcq-code">
              <code>{question.code}</code>
            </pre>
          )}
        </div>

        <div className="mcq-pick-box">
          {question.options.map((opt, oIdx) => {
            const isSelected = selected === opt;
            return (
              <button
                key={oIdx}
                className={`pick-option ${isSelected ? "selected" : ""}`}
                onClick={() => onSelect(isSelected ? null : opt)}
              >
                <span className="pick-circle" />
                <span className="pick-text">{opt}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CodingView({ question, idx, code, onCodeChange, startTime, tookMs, results, onRun, running, customInput, onCustomInputChange, customOpen, customRan, onCustomToggle, onCloseTerminal, terminal, isLast, onSubmit }) {
  const [now, setNow] = useState(null);
  // Base editor height. Made noticeably taller now that the editor column
  // owns most of the horizontal space (sample I/O moved to the left panel).
  const [editorH, setEditorH] = useState(() => Math.max(440, window.innerHeight - 230));
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Ref now points at the WHOLE coding stage (prompt + editor), not just the
  // editor's wrapper, so F11 enlarges everything that was on screen instead
  // of letting only the code area take over the viewport.
  const stageRef = useRef(null);

  useEffect(() => {
    const onResize = () => setEditorH(Math.max(440, window.innerHeight - 230));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- fullscreen handling ----
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      (el.requestFullscreen ? el.requestFullscreen() : Promise.reject())
        .catch(() => setIsFullscreen((f) => !f));
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      // Recalculate editor height once the layout size actually changes,
      // so the editor fills the (now larger, but still shared) space.
      setEditorH(Math.max(440, window.innerHeight - 230));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Intercept F11 so it drives our own contained fullscreen (whole coding
  // view: prompt + editor + run strip + custom input), instead of the
  // browser's own fullscreen chrome.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      }
      if (e.key === "Escape" && isFullscreen) {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, isFullscreen]);

  useEffect(() => {
    let id;
    if (startTime) {
      if (!tookMs) {
        setNow(Date.now());
        id = setInterval(() => setNow(Date.now()), 1000);
      } else {
        setNow(null);
      }
    } else {
      setNow(null);
    }
    return () => id && clearInterval(id);
  }, [startTime, tookMs]);

  const fmtMs = (ms) => {
    if (ms == null) return "";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  const displayMs = tookMs ?? (startTime && now ? now - startTime : null);

  const panelOpen = customOpen && !customRan;
  const passedCount = results ? results.filter((r) => r.passed).length : 0;
  const failedCount = results ? results.length - passedCount : 0;

  return (
    <div className={`stage-inner coding ${isFullscreen ? "manual-fullscreen" : ""}`} ref={stageRef}>
      <div className="stage-header">
        <span className="stage-tag">Coding {String(idx + 1).padStart(2, "0")}</span>
      </div>

      <div className="coding-layout">
        {/* Left column: question copy + a dedicated sample input/output box,
            styled to match the amber "coding" theme used by the run strip.
            This stays visible in fullscreen since the whole stage (not just
            the editor) is what enters fullscreen now. */}
        <div className="coding-prompt">
          <h2 className="stage-question">{question.title}</h2>
          <p className="stage-desc">{question.description}</p>

          <div className="sample-box">
            <div className="sample-box-head">Sample</div>
            {question.testCases?.[0] ? (
              <div className="sample-box-rows">
                <div className="sample-box-row">
                  <span className="sample-box-label">Input</span>
                  <pre>{question.testCases[0].input}</pre>
                </div>
                <div className="sample-box-row">
                  <span className="sample-box-label">Output</span>
                  <pre>{question.testCases[0].expectedOutput}</pre>
                </div>
              </div>
            ) : (
              <div className="sample-box-empty">No sample available</div>
            )}
          </div>

          {results && (
            <div className={`results-summary ${failedCount === 0 ? "pass" : "fail"}`}>
              <div className="pass-line">{passedCount} passed</div>
              <div className="fail-line">{failedCount} failed</div>
            </div>
          )}
        </div>

        {/* Right column: the code area itself, pushed right and given the
            bulk of the available width. No fullscreen class/ref lives here
            anymore — the editor simply keeps its normal size relative to
            the (now-enlarged) stage around it. */}
        <div className="coding-editor-col">
          <div className="code-block-wrap">
            <div className="code-block-header">
              {displayMs != null && (
                <span className={`timer-chip ${tookMs ? "timer-done" : "timer-live"}`}>
                  {tookMs ? `⏱ Took ${fmtMs(displayMs)}` : `⏱ ${fmtMs(displayMs)}`}
                </span>
              )}
              <button
                className="fs-toggle-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit full screen (Esc / F11)" : "Full screen (F11)"}
              >
                {isFullscreen ? "⛶ Exit Full Screen" : "⛶ Full Screen"}
              </button>
            </div>
            <div className="code-block-body">
              <Editor
                height={editorH}
                defaultLanguage="java"
                theme="vs"
                value={code}
                onChange={onCodeChange}
                options={{
                  fontSize: 14,
                  fontFamily: "'JetBrains Mono', monospace",
                  minimap: { enabled: false },
                  folding: false,
                  scrollBeyondLastLine: false,
                }}
              />
              {!panelOpen && terminal && (
                <div className="run-console">
                  <div className="run-console-head">
                    <span className="mini-terminal-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>terminal</span>
                    <button className="run-console-close" onClick={onCloseTerminal} title="Close terminal">
                      ✕
                    </button>
                  </div>
                  <pre className="run-console-body">{terminal}</pre>
                </div>
              )}
            </div>
            {panelOpen && (
              <div className="strip-panel">
                <div className="custom-input-panel">
                  <div className="custom-input-head">
                    <span>Custom Input</span>
                    <span>stdin · one value per line</span>
                  </div>
                  <textarea
                    className="custom-input-area"
                    value={customInput || ""}
                    onChange={(e) => onCustomInputChange(e.target.value)}
                    placeholder={"type your input here"}
                    spellCheck="false"
                  />
                </div>
              </div>
            )}
            {/* Run + custom input controls live inside the same coding stage,
                so they always render just below the code area whether or
                not full screen is active. */}
            <div className="code-strip">
              <button className="run-btn" onClick={onRun} disabled={running}>
                {running ? (
                  <span className="spinner-wrap">
                    <span className="spinner" /> Running…
                  </span>
                ) : (
                  <>▷ Run</>
                )}
              </button>
              <button
                className={`custom-input-btn ${customOpen ? "active" : ""}`}
                onClick={onCustomToggle}
                disabled={running}
              >
                <span className="custom-input-tick">{customOpen ? "✓" : ""}</span>
                ⌨ Custom Input
              </button>
            </div>
          </div>

          {isLast && (
            <div className="submit-row">
              <button className="submit-btn" onClick={onSubmit}>
                ✓ Submit Test
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



function FileExplorer({
  open,
  onClose,
  onLoadTest,
  canSave,
  topic,
  mcqCount,
  codingCount,
  data,
  pushToast,
}) {
  const [items, setItems] = useState([]);
  const [crumbs, setCrumbs] = useState([{ label: "My PC", path: null }]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragPath, setDragPath] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [pendingOverwrite, setPendingOverwrite] = useState(null);

  const token = getToken();
  const currentPath = crumbs[crumbs.length - 1]?.path ?? null;
  const atRoot = !currentPath;

  const load = useCallback(
    async (folder) => {
      setBusy(true);
      setError("");
      try {
        if (!folder) {
          const { drives } = await fetchDrives(token);
          setItems(drives);
          setCrumbs([{ label: "My PC", path: null }]);
        } else {
          const { items: found, folder: resolved } = await listFsFolder(token, folder);
          setItems(found);
          setCrumbs(buildBreadcrumbs(resolved));
        }
        setSelected(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [token]
  );

  useEffect(() => {
    if (open) {
      load(null);
      setSaving(false);
      setSaveName("");
    }
  }, [open, load]);

  const openItem = (item) => {
    if (item.kind === "drive" || item.kind === "folder") {
      load(item.path);
    } else if (item.kind === "test") {
      onLoadTest(item.path);
    }
  };

  const goToCrumb = (crumb) => {
    const idx = crumbs.findIndex((c) => c.label === crumb.label && c.path === crumb.path);
    if (idx < 0) return;
    if (crumb.path === null) {
      load(null);
    } else {
      load(crumb.path);
    }
  };

  const goUp = () => {
    if (crumbs.length <= 1) return;
    const parent = crumbs[crumbs.length - 2];
    load(parent.path);
  };

  const handleSave = async (force) => {
    if (!canSave || !currentPath) return;
    setBusy(true);
    setError("");
    try {
      const res = await saveTestToFolder({
        token,
        folder: currentPath,
        topic,
        mcqCount,
        codingCount,
        data,
        fileName: saveName.trim() || topic || "test",
        overwrite: !!force,
      });
      if (res.exists) {
        setPendingOverwrite({ name: res.name, path: res.path });
        return;
      }
      pushToast(`Saved "${res.name}"`, "success");
      setSaving(false);
      setSaveName("");
      load(currentPath);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!pendingOverwrite) setBusy(false);
    }
  };

  const handleBeginSave = () => {
    if (!canSave || !currentPath) return;
    setSaveName(topic || "");
    setSaving(true);
  };

  const confirmOverwrite = async () => {
    setPendingOverwrite(null);
    await handleSave(true);
  };

  const cancelOverwrite = () => {
    setBusy(false);
    setPendingOverwrite(null);
  };

  const handleNewFolder = async () => {
    if (!currentPath || !folderName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await createFolder({ token, parent: currentPath, name: folderName.trim() });
      setFolderName("");
      setCreatingFolder(false);
      pushToast(`Created "${res.name}"`, "success");
      load(currentPath);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || selected.kind !== "test") return;
    if (!window.confirm(`Delete "${selected.name}" from your PC?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteTestFile({ token, path: selected.path });
      pushToast("Deleted test file", "success");
      load(currentPath);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDropOn = async (item) => {
    setDropTarget(null);
    if (!dragPath) return;
    try {
      await moveTestFile({ token, from: dragPath, toFolder: item.path });
      pushToast(`Moved "${pathBase(dragPath)}" into "${item.name}"`, "success");
      load(currentPath);
    } catch (err) {
      setError(err.message);
      pushToast("Could not move test", "error");
    } finally {
      setDragPath(null);
    }
  };

  const getItemIcon = (item) => {
    if (item.kind === "drive") return { emoji: "💾", color: "#64748b" };
    if (item.kind === "folder") return { emoji: "📁", color: "#3b82f6" };
    if (item.kind === "test") return { emoji: "🎯", color: "#f59e0b" };
    return { emoji: "📄", color: "#94a3b8" };
  };

  const folders = items.filter((i) => i.kind === "folder" || i.kind === "drive");
  const files = items.filter((i) => i.kind === "test" || i.kind === "file");

  return (
    <>
      {open && (
        <div className="finder-overlay" onMouseDown={() => onClose()}>
          <div className="finder-window" onMouseDown={(e) => e.stopPropagation()}>
            <div className="finder-titlebar">
              <div className="finder-traffic-lights">
                <button className="finder-dot red" onClick={onClose} />
                <button className="finder-dot yellow" />
                <button className="finder-dot green" />
              </div>
              <div className="finder-titlebar-text">
                {crumbs[crumbs.length - 1]?.label || "This PC"}
              </div>
              <div className="finder-titlebar-right">
                <button className={`finder-view-btn ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")} title="Icons">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/></svg>
                </button>
                <button className={`finder-view-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} title="List">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="2.5" rx="1"/><rect x="1" y="6.75" width="14" height="2.5" rx="1"/><rect x="1" y="11.5" width="14" height="2.5" rx="1"/></svg>
                </button>
              </div>
            </div>

            <div className="finder-toolbar">
              <button className="finder-nav-btn" onClick={goUp} disabled={atRoot || busy} title="Back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="finder-breadcrumbs">
                {crumbs.map((crumb, i) => {
                  const isLast = i === crumbs.length - 1;
                  return (
                    <React.Fragment key={crumb.label + crumb.path}>
                      {i > 0 && <span className="finder-crumb-sep">/</span>}
                      <button className={`finder-crumb ${isLast ? "current" : ""}`} onClick={() => !isLast && goToCrumb(crumb)} disabled={isLast}>
                        {i === 0 ? "🖥 " : ""}{crumb.label}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
              <div className="finder-toolbar-actions">
                <button className="finder-icon-btn" onClick={() => { setFolderName(""); setCreatingFolder(true); }} disabled={atRoot || busy} title="New Folder">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                </button>
                {selected?.kind === "test" && (
                  <button className="finder-icon-btn danger" onClick={handleDelete} disabled={busy} title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                )}
                {canSave && (
                  <button className="finder-save-btn" onClick={handleBeginSave} disabled={atRoot || busy}>Save Here</button>
                )}
              </div>
            </div>

            {saving && currentPath && (
              <div className="finder-save-bar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <input autoFocus className="finder-folder-input" placeholder="Test name" value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setSaving(false); setSaveName(""); } }} />
                <button className="finder-folder-btn save" onClick={handleSave} disabled={busy || !saveName.trim()}>Save</button>
                <button className="finder-folder-btn cancel" onClick={() => { setSaving(false); setSaveName(""); }}>Cancel</button>
              </div>
            )}

            {creatingFolder && currentPath && (
              <div className="finder-new-folder-bar">
                <input autoFocus className="finder-folder-input" placeholder="untitled folder" value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleNewFolder(); if (e.key === "Escape") setCreatingFolder(false); }} />
                <button className="finder-folder-btn" onClick={handleNewFolder} disabled={busy || !folderName.trim()}>Create</button>
                <button className="finder-folder-btn cancel" onClick={() => setCreatingFolder(false)}>Cancel</button>
              </div>
            )}

            {error && <div className="finder-error">{error}</div>}

            {pendingOverwrite && (
              <div className="finder-overwrite-overlay">
                <div className="finder-overwrite-box">
                  <div className="finder-overwrite-icon">⚠️</div>
                  <div className="finder-overwrite-title">Overwrite this file?</div>
                  <div className="finder-overwrite-message">
                    "{pendingOverwrite.name}.drillbench.json" already exists in this folder. Do you want to replace it?
                  </div>
                  <div className="finder-overwrite-actions">
                    <button className="finder-folder-btn cancel" onClick={cancelOverwrite}>No</button>
                    <button className="finder-folder-btn save" onClick={confirmOverwrite} disabled={busy}>Yes</button>
                  </div>
                </div>
              </div>
            )}

            <div className={`finder-content ${viewMode}`}>
              {busy && items.length === 0 && (
                <div className="finder-empty"><div className="finder-spinner" /><span>Loading...</span></div>
              )}
              {!busy && items.length === 0 && (
                <div className="finder-empty"><span className="finder-empty-icon">📂</span><span>This folder is empty</span></div>
              )}

              {viewMode === "grid" && folders.length > 0 && (
                <div className="finder-section">
                  <div className="finder-section-title">Locations</div>
                  <div className="finder-grid">
                    {folders.map((item) => {
                      const icon = getItemIcon(item);
                      const isDragOver = dragPath && dropTarget === item.path;
                      return (
                        <div key={item.path}
                          className={`finder-tile ${selected?.path === item.path ? "selected" : ""} ${isDragOver ? "drag-over" : ""}`}
                          onClick={() => setSelected(item)}
                          onDoubleClick={() => openItem(item)}
                          onDragOver={(e) => { e.preventDefault(); setDropTarget(item.path); }}
                          onDragLeave={() => setDropTarget(null)}
                          onDrop={(e) => { e.preventDefault(); handleDropOn(item); }}
                        >
                          <div className="finder-tile-icon" style={{ background: `${icon.color}15` }}>
                            <span className="finder-tile-emoji">{icon.emoji}</span>
                          </div>
                          <span className="finder-tile-name">{item.name}</span>
                          {item.label && <span className="finder-tile-sub">{item.label}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {viewMode === "grid" && files.length > 0 && (
                <div className="finder-section">
                  <div className="finder-section-title">Files</div>
                  <div className="finder-grid">
                    {files.map((item) => {
                      const icon = getItemIcon(item);
                      return (
                        <div key={item.path}
                          className={`finder-tile ${selected?.path === item.path ? "selected" : ""}`}
                          onClick={() => setSelected(item)}
                          onDoubleClick={() => openItem(item)}
                          draggable={item.kind === "test"}
                          onDragStart={(e) => { if (item.kind !== "test") return; setDragPath(item.path); e.dataTransfer.effectAllowed = "move"; }}
                          onDragEnd={() => { setDragPath(null); setDropTarget(null); }}
                        >
                          <div className="finder-tile-icon" style={{ background: `${icon.color}15` }}>
                            <span className="finder-tile-emoji">{icon.emoji}</span>
                          </div>
                          <span className="finder-tile-name">{item.name}</span>
                          <span className="finder-tile-sub">{fmtSize(item.size)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {viewMode === "list" && (
                <div className="finder-list">
                  <div className="finder-list-head">
                    <span className="finder-list-col name">Name</span>
                    <span className="finder-list-col size">Size</span>
                    <span className="finder-list-col date">Modified</span>
                  </div>
                  {[...folders, ...files].map((item) => {
                    const icon = getItemIcon(item);
                    const isDragOver = dragPath && dropTarget === item.path;
                    return (
                      <div key={item.path}
                        className={`finder-list-row ${selected?.path === item.path ? "selected" : ""} ${isDragOver ? "drag-over" : ""}`}
                        onClick={() => setSelected(item)}
                        onDoubleClick={() => openItem(item)}
                        draggable={item.kind === "test"}
                        onDragStart={(e) => { if (item.kind !== "test") return; setDragPath(item.path); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => { setDragPath(null); setDropTarget(null); }}
                        onDragOver={(e) => { if (item.kind === "folder" || item.kind === "drive") { e.preventDefault(); setDropTarget(item.path); } }}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={(e) => { if (item.kind === "folder" || item.kind === "drive") { e.preventDefault(); handleDropOn(item); } }}
                      >
                        <span className="finder-list-col name"><span className="finder-list-emoji">{icon.emoji}</span> {item.name}</span>
                        <span className="finder-list-col size">{item.kind === "drive" ? item.label : item.kind === "folder" ? "—" : fmtSize(item.size)}</span>
                        <span className="finder-list-col date">{item.mtime ? new Date(item.mtime).toLocaleDateString() : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="finder-statusbar">
              <span>{items.length} item{items.length !== 1 ? "s" : ""}</span>
              {currentPath && <span className="finder-statusbar-path">{currentPath}</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function buildBreadcrumbs(folder) {
  const crumbs = [{ label: "This PC", path: null }];
  if (typeof folder !== "string") return crumbs;
  const driveMatch = folder.match(/^\s*([A-Za-z]:\\)/);
  if (!driveMatch) return crumbs;
  const drive = driveMatch[1];
  crumbs.push({ label: drive.slice(0, 2), path: drive });
  const rest = folder.slice(drive.length).replace(/[\\/]+$/, "");
  if (!rest) return crumbs;
  let cur = drive;
  for (const part of rest.split(/[\\/]+/)) {
    cur = cur + part + "\\";
    crumbs.push({ label: part, path: cur });
  }
  return crumbs;
}

function pathBase(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default App;