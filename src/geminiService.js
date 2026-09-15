const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:3001";

export async function generateQuestions(topic, mcqCount, codingCount, token) {
  const response = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ topic, mcqCount, codingCount }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to generate questions");
  }

  return response.json();
}