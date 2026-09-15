const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:3001";

export async function exchangeGoogleCredential(credential) {
  const response = await fetch(`${API_BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Login failed");
  }

  return response.json();
}

export async function loginAsGuest(name) {
  const response = await fetch(`${API_BASE}/api/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || "" }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Guest sign-in failed");
  }

  return response.json();
}

export async function logout(token) {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
  } catch (_) {}
}

export async function fetchAuthUser() {
  const token = getToken();
  if (!token) return null;
  const response = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Not authenticated");
  const data = await response.json();
  return data.user;
}

export function storeSession(token, user) {
  localStorage.setItem("drillbench_token", token);
  localStorage.setItem("drillbench_user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("drillbench_token");
  localStorage.removeItem("drillbench_user");
}

export function getToken() {
  return localStorage.getItem("drillbench_token");
}

export async function saveTest({ token, topic, mcqCount, codingCount, data }) {
  const response = await fetch(`${API_BASE}/api/tests/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ topic, mcqCount, codingCount, data }),
  });
  if (!response.ok) throw new Error("Failed to save test");
  return response.json();
}

export async function fetchTests(token) {
  const response = await fetch(`${API_BASE}/api/tests`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Failed to load history");
  return response.json();
}

export async function fetchTest(token, id) {
  const response = await fetch(`${API_BASE}/api/tests/${id}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Failed to load test");
  return response.json();
}

export async function saveTestResults({ token, testId, answers, code, results }) {
  const response = await fetch(`${API_BASE}/api/tests/${testId}/results`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ answers, code, results }),
  });
  if (!response.ok) throw new Error("Failed to save results");
  return response.json();
}

/* ---------- "My PC" filesystem explorer ---------- */

async function fsRequest(url, options = {}, token) {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Authorization": `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "File operation failed");
  }
  return response.json();
}

export async function fetchDrives(token) {
  return fsRequest("/api/fs/drives", {}, token);
}

export async function listFsFolder(token, folder) {
  return fsRequest(`/api/fs/list?path=${encodeURIComponent(folder)}`, {}, token);
}

export async function fetchFsTest(token, path) {
  return fsRequest(`/api/fs/test?path=${encodeURIComponent(path)}`, {}, token);
}

export async function saveTestToFolder({ token, folder, topic, mcqCount, codingCount, data, fileName, overwrite }) {
  return fsRequest(
    "/api/fs/save",
    {
      method: "POST",
      body: JSON.stringify({ folder, topic, mcqCount, codingCount, data, fileName, overwrite }),
    },
    token
  );
}

export async function createFolder({ token, parent, name }) {
  return fsRequest(
    "/api/fs/folder",
    {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    },
    token
  );
}

export async function moveTestFile({ token, from, toFolder }) {
  return fsRequest(
    "/api/fs/move",
    {
      method: "POST",
      body: JSON.stringify({ from, toFolder }),
    },
    token
  );
}

export async function deleteTestFile({ token, path }) {
  return fsRequest(`/api/fs/test?path=${encodeURIComponent(path)}`, { method: "DELETE" }, token);
}