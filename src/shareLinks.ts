// Rewrites cloud-storage share links (Google Drive, Dropbox, OneDrive,
// GitHub) into direct-download URLs, and validates trajectory URLs before
// any fetch happens.

export interface ResolvedTrajectoryUrl {
  /** URL to actually fetch (share links rewritten to raw-file endpoints). */
  directUrl: string;
  /** True when a known cloud-storage rewrite matched; enables the proxy fallback. */
  isCloudShare: boolean;
}

const ALLOWED_EXTENSIONS = [".xyz", ".extxyz", ".cube", ".cub"];

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Returns a human-readable error when the URL must not be fetched, or null
 * when it is acceptable. https-only, except plain http to loopback/LAN hosts
 * (the local dev setup). When the path ends in a visible file extension it
 * must be .xyz/.extxyz; extension-less URLs (Drive/OneDrive download
 * endpoints) are left to the content checks.
 */
export function validateTrajectoryUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "Not a valid URL.";
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateHostname(url.hostname))) {
    return "Only https:// URLs can be loaded (http:// is allowed for local/LAN development hosts).";
  }

  const lastSegment = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const extensionMatch = lastSegment.match(/\.[A-Za-z0-9]+$/);
  if (extensionMatch && !ALLOWED_EXTENSIONS.includes(extensionMatch[0].toLowerCase())) {
    return `Expected a ${ALLOWED_EXTENSIONS.join(" or ")} file, got "${lastSegment}".`;
  }

  return null;
}

/** Rewrites known share-link formats to direct-download URLs; leaves anything else untouched. */
export function resolveTrajectoryUrl(input: string): ResolvedTrajectoryUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { directUrl: input, isCloudShare: false };
  }
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = url.pathname.match(/^\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id");
    if (id) {
      return {
        directUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
        isCloudShare: true,
      };
    }
  }

  if ((host === "www.dropbox.com" || host === "dropbox.com") && /^\/(s|scl\/fi)\//.test(url.pathname)) {
    const direct = new URL(url.toString());
    direct.hostname = "dl.dropboxusercontent.com";
    direct.searchParams.delete("dl");
    return { directUrl: direct.toString(), isCloudShare: true };
  }

  if (host === "1drv.ms" || host === "onedrive.live.com") {
    return {
      directUrl: `https://api.onedrive.com/v1.0/shares/u!${base64UrlEncode(url.toString())}/root/content`,
      isCloudShare: true,
    };
  }

  if (host === "github.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (match) {
      return {
        directUrl: `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`,
        isCloudShare: true,
      };
    }
  }

  return { directUrl: input, isCloudShare: false };
}
