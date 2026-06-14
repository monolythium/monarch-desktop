// Signed protocore release feed.
//
// The desktop app already self-updates its own binary through the Tauri
// updater. This module answers a different question: is the operator's
// protocore NODE running the latest SIGNED release published on GitHub?
//
// It reads the public GitHub Releases API for `monolythium/protocore`
// (unauthenticated — the unauthenticated rate limit is 60/hr, so the UI
// fetches on mount + manual refresh, never on a tight poll), selects the
// newest non-draft release for the requested channel, and — when present —
// pulls the `release-*.json` manifest asset to extract the cross-release
// identity (`compatibility.mono_core_commit`) plus the published tarball
// digest. The `signed` flag reports that a cosign `.sig` + `.pem` and an
// SBOM are PRESENT on the published release; it is NOT an on-device cosign
// verification.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const RELEASES_URL: &str = "https://api.github.com/repos/monolythium/protocore/releases?per_page=20";
const INSTALLER_IMAGE_REPO: &str = "ghcr.io/monolythium/monarch-os-installer";
const DEFAULT_CHANNEL: &str = "testnet";
const FEED_TIMEOUT: Duration = Duration::from_secs(8);
/// Hard ceiling on how many recent releases the list command will return,
/// regardless of the caller's request — the dropdown shows a handful, not a
/// scroll of history.
const RECENT_MAX: usize = 10;
const RECENT_DEFAULT: usize = 5;

/// The latest signed protocore release for a channel, with the
/// cross-release identity needed to compare against the running node.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestProtocoreRelease {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    /// Release body / changelog.
    pub notes: String,
    pub html_url: String,
    /// `compatibility.mono_core_commit` from the release manifest, when the
    /// manifest asset is present and readable. The ONLY reliable cross-release
    /// identity (the running node's `runtime.version` is the crate version and
    /// does not track the tag).
    pub mono_core_commit: Option<String>,
    /// `platforms.<plat>.sha256` from the release manifest — the TARBALL sha,
    /// NOT the runtime's binary sha. Surfaced for display only.
    pub tarball_sha256: Option<String>,
    /// Whether the published release carries BOTH a cosign `.sig` and `.pem`.
    /// PRESENCE on the release, not an on-device verification.
    pub signed: bool,
    /// Whether an SBOM (`*.spdx.json`) asset is present on the release.
    pub sbom: bool,
    /// The matching Monarch OS installer image, derived from the tag.
    pub installer_image: String,
}

/// `ghcr.io/monolythium/monarch-os-installer:<tag>` — the installer image
/// that pairs with a given release tag.
fn derive_installer_image(tag: &str) -> String {
    format!("{INSTALLER_IMAGE_REPO}:{tag}")
}

/// Select the newest non-draft release whose tag ends with `-<channel>`,
/// preferring the latest `published_at`. Pure so it can be unit-tested with
/// inline fixtures and no network.
fn select_latest(releases: &[Value], channel: &str) -> Option<Value> {
    let suffix = format!("-{channel}");
    releases
        .iter()
        .filter(|release| {
            // Skip drafts; a missing/false `draft` flag means published.
            if release.get("draft").and_then(Value::as_bool).unwrap_or(false) {
                return false;
            }
            release
                .get("tag_name")
                .and_then(Value::as_str)
                .map(|tag| tag.ends_with(&suffix))
                .unwrap_or(false)
        })
        .max_by(|a, b| {
            let pa = a.get("published_at").and_then(Value::as_str).unwrap_or("");
            let pb = b.get("published_at").and_then(Value::as_str).unwrap_or("");
            // RFC-3339 timestamps sort lexicographically; newest wins. Break an
            // exact-timestamp tie on the tag name so the winner is deterministic
            // regardless of array order.
            let ta = a.get("tag_name").and_then(Value::as_str).unwrap_or("");
            let tb = b.get("tag_name").and_then(Value::as_str).unwrap_or("");
            pa.cmp(pb).then_with(|| ta.cmp(tb))
        })
        .cloned()
}

/// Select up to `limit` non-draft releases for `channel`, newest first. Same
/// channel/draft filter as `select_latest`, just keeping the whole ordered
/// run instead of only the head. Pure, for inline-fixture unit tests.
fn select_recent(releases: &[Value], channel: &str, limit: usize) -> Vec<Value> {
    let suffix = format!("-{channel}");
    let mut matches: Vec<&Value> = releases
        .iter()
        .filter(|release| {
            if release.get("draft").and_then(Value::as_bool).unwrap_or(false) {
                return false;
            }
            release
                .get("tag_name")
                .and_then(Value::as_str)
                .map(|tag| tag.ends_with(&suffix))
                .unwrap_or(false)
        })
        .collect();
    // Newest first; break exact-timestamp ties on the tag so order is
    // deterministic regardless of the array's incoming order.
    matches.sort_by(|a, b| {
        let pa = a.get("published_at").and_then(Value::as_str).unwrap_or("");
        let pb = b.get("published_at").and_then(Value::as_str).unwrap_or("");
        let ta = a.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let tb = b.get("tag_name").and_then(Value::as_str).unwrap_or("");
        pb.cmp(pa).then_with(|| tb.cmp(ta))
    });
    matches.into_iter().take(limit).cloned().collect()
}

fn asset_names(release: &Value) -> Vec<String> {
    release
        .get("assets")
        .and_then(Value::as_array)
        .map(|assets| {
            assets
                .iter()
                .filter_map(|asset| asset.get("name").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The `release-*.json` manifest asset download URL, if present.
fn manifest_url(release: &Value) -> Option<String> {
    release
        .get("assets")
        .and_then(Value::as_array)?
        .iter()
        .find(|asset| {
            asset
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.starts_with("release-") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .and_then(|asset| asset.get("browser_download_url").and_then(Value::as_str))
        .map(str::to_owned)
}

/// Extract `(mono_core_commit, tarball_sha256)` from a parsed manifest body.
/// Degrades to `(None, None)` for any missing field.
fn manifest_identity(manifest: &Value) -> (Option<String>, Option<String>) {
    let mono_core_commit = manifest
        .get("compatibility")
        .and_then(|c| c.get("mono_core_commit"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let tarball_sha256 = manifest
        .get("platforms")
        .and_then(|p| p.get("x86_64-linux"))
        .and_then(|plat| plat.get("sha256"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    (mono_core_commit, tarball_sha256)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(FEED_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch the channel's published releases from the GitHub Releases API.
/// Unauthenticated; ~8s timeout.
async fn fetch_releases(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    client
        .get(RELEASES_URL)
        .header("User-Agent", "monarch-desktop")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Assemble a `LatestProtocoreRelease` from a single GitHub release `Value`,
/// reading the manifest asset for the cross-release identity. The manifest
/// read is best-effort: any failure (asset absent, network, parse) degrades
/// the identity to `None` without failing the whole build.
async fn build_release(client: &reqwest::Client, release: &Value) -> LatestProtocoreRelease {
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = release
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(&tag)
        .to_string();
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let notes = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let html_url = release
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let names = asset_names(release);
    let has_sig = names.iter().any(|n| n.ends_with(".sig"));
    let has_pem = names.iter().any(|n| n.ends_with(".pem"));
    let signed = has_sig && has_pem;
    let sbom = names.iter().any(|n| n.ends_with(".spdx.json"));

    let (mono_core_commit, tarball_sha256) = match manifest_url(release) {
        Some(url) => match client
            .get(&url)
            .header("User-Agent", "monarch-desktop")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => match resp.json::<Value>().await {
                Ok(manifest) => manifest_identity(&manifest),
                Err(_) => (None, None),
            },
            Err(_) => (None, None),
        },
        None => (None, None),
    };

    LatestProtocoreRelease {
        installer_image: derive_installer_image(&tag),
        tag,
        name,
        published_at,
        notes,
        html_url,
        mono_core_commit,
        tarball_sha256,
        signed,
        sbom,
    }
}

/// GitHub Releases API → newest signed release for `channel` (default
/// "testnet"). Unauthenticated; ~8s timeout. The manifest read degrades to
/// `None` identity if the asset is absent or unfetchable, never failing the
/// whole call.
#[tauri::command]
pub async fn latest_protocore_release(
    channel: Option<String>,
) -> Result<LatestProtocoreRelease, String> {
    let channel = channel.unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
    let client = http_client()?;

    let releases = fetch_releases(&client).await?;
    let release = select_latest(&releases, &channel)
        .ok_or_else(|| format!("no published release for channel '{channel}'"))?;

    Ok(build_release(&client, &release).await)
}

/// GitHub Releases API → the most recent published releases for `channel`,
/// newest first. `limit` is clamped to `RECENT_MAX`; a missing/zero limit
/// falls back to `RECENT_DEFAULT`. Powers the topbar update dropdown. Returns
/// an empty list (not an error) when the channel has no published releases,
/// so the dropdown degrades quietly. Each release's manifest is read
/// best-effort, exactly as the single-latest command does.
#[tauri::command]
pub async fn recent_protocore_releases(
    channel: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<LatestProtocoreRelease>, String> {
    let channel = channel.unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
    let limit = match limit {
        Some(0) | None => RECENT_DEFAULT,
        Some(n) => n.min(RECENT_MAX),
    };
    let client = http_client()?;

    let releases = fetch_releases(&client).await?;
    let chosen = select_recent(&releases, &channel, limit);

    let mut out = Vec::with_capacity(chosen.len());
    for release in &chosen {
        out.push(build_release(&client, release).await);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn releases_fixture() -> Vec<Value> {
        vec![
            // Older testnet release.
            json!({
                "tag_name": "v0.1.50-testnet",
                "name": "v0.1.50-testnet",
                "draft": false,
                "published_at": "2026-06-01T00:00:00Z",
                "html_url": "https://github.com/monolythium/protocore/releases/tag/v0.1.50-testnet",
                "body": "older",
                "assets": []
            }),
            // A draft of a newer testnet tag — must be ignored even though it
            // sorts newest.
            json!({
                "tag_name": "v0.1.53-testnet",
                "name": "draft build",
                "draft": true,
                "published_at": "2026-06-20T00:00:00Z",
                "html_url": "https://example/draft",
                "body": "draft",
                "assets": []
            }),
            // A different channel — must be ignored.
            json!({
                "tag_name": "v0.1.52-mainnet",
                "name": "mainnet",
                "draft": false,
                "published_at": "2026-06-15T00:00:00Z",
                "html_url": "https://example/mainnet",
                "body": "mainnet",
                "assets": []
            }),
            // A non-suffixed tag — must be ignored.
            json!({
                "tag_name": "v0.1.51",
                "name": "bare",
                "draft": false,
                "published_at": "2026-06-12T00:00:00Z",
                "html_url": "https://example/bare",
                "body": "bare",
                "assets": []
            }),
            // The newest published testnet release — should win.
            json!({
                "tag_name": "v0.1.52-testnet",
                "name": "v0.1.52-testnet",
                "draft": false,
                "published_at": "2026-06-13T00:00:00Z",
                "html_url": "https://github.com/monolythium/protocore/releases/tag/v0.1.52-testnet",
                "body": "newest",
                "assets": [
                    { "name": "protocore-v0.1.52-testnet-x86_64-linux.tar.gz", "browser_download_url": "https://example/tar" },
                    { "name": "protocore-v0.1.52-testnet-x86_64-linux.tar.gz.sig", "browser_download_url": "https://example/sig" },
                    { "name": "protocore-v0.1.52-testnet-x86_64-linux.tar.gz.pem", "browser_download_url": "https://example/pem" },
                    { "name": "protocore-v0.1.52-testnet.spdx.json", "browser_download_url": "https://example/sbom" },
                    { "name": "release-v0.1.52-testnet.json", "browser_download_url": "https://example/manifest" }
                ]
            }),
        ]
    }

    #[test]
    fn select_latest_picks_newest_published_for_channel() {
        let releases = releases_fixture();
        let chosen = select_latest(&releases, "testnet").expect("a testnet release");
        assert_eq!(chosen["tag_name"], "v0.1.52-testnet");
    }

    #[test]
    fn select_latest_ignores_drafts_other_channels_and_bare_tags() {
        let releases = releases_fixture();
        let chosen = select_latest(&releases, "testnet").expect("a testnet release");
        // Not the draft (would sort newest), not mainnet, not the bare tag.
        assert_ne!(chosen["tag_name"], "v0.1.53-testnet");
        assert_ne!(chosen["tag_name"], "v0.1.52-mainnet");
        assert_ne!(chosen["tag_name"], "v0.1.51");
    }

    #[test]
    fn select_latest_returns_none_for_unknown_channel() {
        let releases = releases_fixture();
        assert!(select_latest(&releases, "devnet").is_none());
    }

    #[test]
    fn asset_flags_require_both_sig_and_pem() {
        let releases = releases_fixture();
        let chosen = select_latest(&releases, "testnet").unwrap();
        let names = asset_names(&chosen);
        let signed = names.iter().any(|n| n.ends_with(".sig"))
            && names.iter().any(|n| n.ends_with(".pem"));
        let sbom = names.iter().any(|n| n.ends_with(".spdx.json"));
        assert!(signed);
        assert!(sbom);
    }

    #[test]
    fn manifest_identity_extracts_commit_and_tarball_sha() {
        let manifest = json!({
            "compatibility": { "mono_core_commit": "b4257f14abcd" },
            "platforms": { "x86_64-linux": { "sha256": "deadbeef".repeat(8) } }
        });
        let (commit, sha) = manifest_identity(&manifest);
        assert_eq!(commit.as_deref(), Some("b4257f14abcd"));
        assert_eq!(sha.as_deref(), Some(&"deadbeef".repeat(8)[..]));
    }

    #[test]
    fn manifest_identity_degrades_to_none_when_absent() {
        let (commit, sha) = manifest_identity(&json!({}));
        assert!(commit.is_none());
        assert!(sha.is_none());
    }

    #[test]
    fn derive_installer_image_uses_the_tag() {
        assert_eq!(
            derive_installer_image("v0.1.52-testnet"),
            "ghcr.io/monolythium/monarch-os-installer:v0.1.52-testnet"
        );
    }

    #[test]
    fn select_recent_returns_channel_releases_newest_first() {
        let releases = releases_fixture();
        let recent = select_recent(&releases, "testnet", 5);
        // Only the two published testnet tags survive the filter (the draft,
        // mainnet, and bare tags are excluded), newest first.
        let tags: Vec<&str> = recent
            .iter()
            .map(|r| r["tag_name"].as_str().unwrap())
            .collect();
        assert_eq!(tags, vec!["v0.1.52-testnet", "v0.1.50-testnet"]);
    }

    #[test]
    fn select_recent_excludes_drafts_other_channels_and_bare_tags() {
        let recent = select_recent(&releases_fixture(), "testnet", 10);
        for release in &recent {
            let tag = release["tag_name"].as_str().unwrap();
            assert!(tag.ends_with("-testnet"), "leaked non-testnet tag: {tag}");
            assert_ne!(tag, "v0.1.53-testnet", "leaked a draft");
        }
    }

    #[test]
    fn select_recent_honours_the_limit() {
        let recent = select_recent(&releases_fixture(), "testnet", 1);
        assert_eq!(recent.len(), 1);
        // The single kept release must be the newest one.
        assert_eq!(recent[0]["tag_name"], "v0.1.52-testnet");
    }

    #[test]
    fn select_recent_head_matches_select_latest() {
        let releases = releases_fixture();
        let recent = select_recent(&releases, "testnet", 5);
        let latest = select_latest(&releases, "testnet").unwrap();
        assert_eq!(recent.first().unwrap()["tag_name"], latest["tag_name"]);
    }

    #[test]
    fn select_recent_empty_for_unknown_channel() {
        assert!(select_recent(&releases_fixture(), "devnet", 5).is_empty());
    }
}
