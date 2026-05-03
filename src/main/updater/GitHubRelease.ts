// Fetches the latest release from a public GitHub repo.

import { request } from 'undici';

export type ReleaseInfo = {
  version: string;
  tgzUrl: string;
  htmlUrl: string;
};

const ASSET_PATTERN = /^local-addon-cloudwayssync-.*\.tgz$/;

export async function fetchLatestRelease(owner: string, repo: string): Promise<ReleaseInfo | null> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'local-addon-cloudwayssync',
        Accept: 'application/vnd.github+json',
      },
    });

    if (res.statusCode !== 200) {
      // 403 = rate limited, 404 = no releases — both non-fatal
      await res.body.dump();
      return null;
    }

    const body = await res.body.json() as {
      tag_name?: string;
      html_url?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    };

    const tagName = body.tag_name;
    if (!tagName) return null;

    const version = tagName.startsWith('v') ? tagName.slice(1) : tagName;
    const htmlUrl = body.html_url ?? '';

    const asset = body.assets?.find((a) => ASSET_PATTERN.test(a.name));
    if (!asset) return null;

    return { version, tgzUrl: asset.browser_download_url, htmlUrl };
  } catch {
    // Network error — non-fatal
    return null;
  }
}
