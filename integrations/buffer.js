export function isConfigured() {
  return Boolean(process.env.BUFFER_TOKEN && process.env.BUFFER_PROFILE_ID);
}

export function status() {
  return { configured: isConfigured() };
}

export async function queueContent({ title, date, channel }) {
  if (!isConfigured()) throw new Error("Buffer is not configured. Set BUFFER_TOKEN and BUFFER_PROFILE_ID.");
  const response = await fetch("https://api.bufferapp.com/1/updates/create.json", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: process.env.BUFFER_TOKEN,
      "profile_ids[]": process.env.BUFFER_PROFILE_ID,
      text: `${title} (${channel} — planned ${date})`,
      shorten: "false"
    })
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.message || "Buffer request failed");
  return { queued: true, id: data.updates?.[0]?.id || null };
}
