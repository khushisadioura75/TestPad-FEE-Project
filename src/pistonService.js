const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:3001";

export async function runCode(sourceCode, testCases) {
  const results = [];

  for (const test of testCases) {
    const response = await fetch(`${API_BASE}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "java",
        files: [{ name: "Main.java", content: sourceCode }],
        stdin: test.input,
      }),
    });

    if (!response.ok) throw new Error("Code execution failed");
    const data = await response.json();
    const actualOutput = (data.run?.stdout || "").trim();
    const expected = test.expectedOutput.trim();

    results.push({
      input: test.input,
      expected,
      actual: actualOutput,
      passed: actualOutput === expected,
      error: data.run?.code !== 0 ? (data.run?.stderr || "Execution failed") : null,
    });
  }

  return results;
}

export async function runCodeWithStdin(sourceCode, stdin) {
  const response = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "java",
      files: [{ name: "Main.java", content: sourceCode }],
      stdin: stdin || "",
    }),
  });

  if (!response.ok) throw new Error("Code execution failed");
  const data = await response.json();
  const result = {
    stdout: String(data.run?.stdout || ""),
    stderr: String(data.run?.stderr || ""),
    code: data.run?.code ?? 1,
  };
  result.error = result.code !== 0 ? (result.stderr || "Execution failed") : null;
  return result;
}