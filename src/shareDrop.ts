/**
 * Uploads a local trajectory blob to the room server's /share endpoint using a
 * presenter upload ticket, and returns the absolute /share/{id} URL the room
 * broadcasts so every member can load the file like any other URL.
 */
export async function uploadTrajectory(
  httpBase: string,
  blob: Blob,
  name: string,
  token: string,
): Promise<string> {
  const query = new URLSearchParams({ name }).toString();
  const response = await fetch(`${httpBase}/share?${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: blob,
  });
  if (!response.ok) {
    let message = `Upload failed (HTTP ${response.status}).`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Keep the default message when the body is not JSON.
    }
    throw new Error(message);
  }
  const { id } = (await response.json()) as { id: string };
  return `${httpBase}/share/${id}`;
}
