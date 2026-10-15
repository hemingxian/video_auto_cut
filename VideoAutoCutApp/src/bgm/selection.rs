use anyhow::{Result, bail};
use std::time::{Duration, Instant};

use crate::candidate::DownloadCandidate;
use crate::logging::log_line;

pub(super) struct BgmSelection<T> {
    pub(super) candidate: DownloadCandidate,
    pub(super) artifact: T,
    pub(super) query: String,
}

pub(super) enum BgmAttemptPhase {
    Searching {
        source: String,
        query: String,
        current: usize,
    },
    Downloading {
        source: String,
        query: String,
        current: usize,
    },
}

fn normalized_query_text(query: &str) -> String {
    query.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_bgm_topic_token(query: &str) -> Option<String> {
    const GENERIC_TERMS: &[&str] = &[
        "a",
        "an",
        "and",
        "audio",
        "background",
        "bgm",
        "for",
        "instrumental",
        "music",
        "of",
        "soundtrack",
        "the",
        "to",
        "track",
        "with",
    ];

    query.split_whitespace().find_map(|word| {
        let token = word
            .trim_matches(|character: char| {
                !character.is_alphanumeric() && character != '-' && character != '_'
            })
            .trim();
        if token.is_empty() || token.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        let normalized = token.to_lowercase();
        (!GENERIC_TERMS.contains(&normalized.as_str())).then(|| token.to_string())
    })
}

fn push_unique_query(queries: &mut Vec<String>, query: impl AsRef<str>) {
    let query = normalized_query_text(query.as_ref());
    if query.is_empty()
        || queries
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&query))
    {
        return;
    }
    queries.push(query);
}

pub(super) fn bgm_query_fallbacks(query: &str) -> Vec<String> {
    let mut queries = Vec::new();
    push_unique_query(&mut queries, query);
    if let Some(topic) = first_bgm_topic_token(query) {
        push_unique_query(&mut queries, format!("{topic} background music"));
    }
    push_unique_query(&mut queries, "background music instrumental");
    queries
}

fn push_unique_source(sources: &mut Vec<String>, source: &str) {
    let source = source.trim().to_lowercase();
    if source.is_empty() {
        return;
    }
    if !sources.iter().any(|item| item == &source) {
        sources.push(source);
    }
}

pub(super) fn resolve_bgm_provider_sources(
    configured: &str,
    has_jamendo: bool,
    has_openverse_credentials: bool,
) -> Vec<String> {
    let mut sources = Vec::new();
    let configured_sources: Vec<String> = configured
        .split(',')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect();

    let configured_sources = if configured_sources.is_empty() {
        vec!["auto".to_string()]
    } else {
        configured_sources
    };

    for source in configured_sources {
        match source.as_str() {
            "auto" => {
                if has_jamendo {
                    push_unique_source(&mut sources, "jamendo-audio");
                }
                // Openverse supports anonymous access. Keep it behind Jamendo
                // in auto mode even when no Openverse credentials are present.
                push_unique_source(&mut sources, "openverse-audio");
            }
            other => push_unique_source(&mut sources, other),
        }
    }

    if has_jamendo {
        push_unique_source(&mut sources, "jamendo-audio");
    }
    if has_openverse_credentials {
        push_unique_source(&mut sources, "openverse-audio");
    }

    sources
}

fn bgm_candidate_allowed(candidate: &DownloadCandidate) -> bool {
    if !candidate.has_download_target() {
        return false;
    }

    if !candidate.media_type.trim().is_empty()
        && !candidate.media_type.eq_ignore_ascii_case("audio")
    {
        return false;
    }

    if candidate.commercial_use == Some(false) {
        return false;
    }

    let license_key = candidate.license_key.to_ascii_lowercase();
    if ["nc", "nd", "sa"]
        .iter()
        .any(|token| license_key.split('-').any(|part| part == *token))
    {
        return false;
    }

    true
}

pub(super) fn select_bgm_from_sources<T>(
    sources: &[String],
    queries: &[String],
    acquire_timeout: Duration,
    mut search: impl FnMut(&str, &str, Duration) -> Result<Option<Vec<DownloadCandidate>>>,
    mut download: impl FnMut(&[DownloadCandidate], Duration) -> Result<(usize, T)>,
    mut report_phase: impl FnMut(BgmAttemptPhase),
) -> Result<Option<BgmSelection<T>>> {
    if sources.is_empty() {
        bail!("没有可用的 BGM 素材来源");
    }
    if queries.is_empty() {
        bail!("BGM 搜索词为空");
    }

    let started = Instant::now();
    let mut errors = Vec::new();
    let mut timed_out = false;
    let mut progress_current = 0;

    'sources: for source in sources {
        for (query_index, query) in queries.iter().enumerate() {
            let Some(search_budget) = acquire_timeout.checked_sub(started.elapsed()) else {
                timed_out = true;
                break 'sources;
            };
            if search_budget.is_zero() {
                timed_out = true;
                break 'sources;
            }

            report_phase(BgmAttemptPhase::Searching {
                source: source.clone(),
                query: query.clone(),
                current: progress_current,
            });
            let candidates = match search(source, query, search_budget) {
                Ok(Some(candidates)) => candidates
                    .into_iter()
                    .filter(bgm_candidate_allowed)
                    .collect::<Vec<_>>(),
                Ok(None) => {
                    let warning = format!("BGM 素材 Provider 不可用: {source}");
                    eprintln!("[警告] {warning}");
                    log_line(&warning);
                    errors.push(warning);
                    continue 'sources;
                }
                Err(error) => {
                    let warning =
                        format!("BGM 来源搜索失败，将尝试下一来源: {source} / {query}: {error:#}");
                    eprintln!("[警告] {warning}");
                    log_line(&warning);
                    errors.push(warning);
                    continue 'sources;
                }
            };

            if candidates.is_empty() {
                if let Some(next_query) = queries.get(query_index + 1) {
                    println!(
                        "[警告] BGM 来源未返回可用候选，简化搜索词后重试: {source} / {next_query}"
                    );
                } else {
                    println!("[警告] BGM 来源没有返回可用候选: {source}");
                }
                continue;
            }

            let Some(download_budget) = acquire_timeout.checked_sub(started.elapsed()) else {
                timed_out = true;
                break 'sources;
            };
            if download_budget.is_zero() {
                timed_out = true;
                break 'sources;
            }

            progress_current = progress_current.max(1);
            report_phase(BgmAttemptPhase::Downloading {
                source: source.clone(),
                query: query.clone(),
                current: progress_current,
            });
            match download(&candidates, download_budget) {
                Ok((candidate_index, artifact)) => {
                    let Some(candidate) = candidates.get(candidate_index).cloned() else {
                        bail!(
                            "BGM 下载器返回了无效候选索引: {candidate_index} / {}",
                            candidates.len()
                        );
                    };
                    return Ok(Some(BgmSelection {
                        candidate,
                        artifact,
                        query: query.clone(),
                    }));
                }
                Err(error) => {
                    let warning = format!(
                        "BGM 来源的候选全部下载失败，将尝试下一来源: {source} / {query}: {error:#}"
                    );
                    eprintln!("[警告] {warning}");
                    log_line(&warning);
                    errors.push(warning);
                    continue 'sources;
                }
            }
        }
    }

    if timed_out {
        errors.push(format!(
            "BGM 素材获取总超时（{} 秒）",
            acquire_timeout.as_secs()
        ));
    }
    if !errors.is_empty() {
        bail!("BGM 所有来源均未成功: {}", errors.join(" | "));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn candidate_for_source(source: &str) -> DownloadCandidate {
        DownloadCandidate {
            index: 1,
            id: "candidate".to_string(),
            source: source.to_string(),
            provider: "provider".to_string(),
            media_type: "audio".to_string(),
            title: "title".to_string(),
            description: String::new(),
            uploader: String::new(),
            creator: String::new(),
            creator_url: String::new(),
            webpage_url: "https://example.com/track".to_string(),
            download_url: "https://cdn.example.com/track.mp3".to_string(),
            thumbnail: String::new(),
            duration: Some(60.0),
            filetype: "mp3".to_string(),
            view_count: None,
            upload_date: String::new(),
            tags: vec![],
            license: "CC0".to_string(),
            license_key: "cc0".to_string(),
            license_url: String::new(),
            commercial_use: Some(true),
            attribution_required: Some(false),
            attribution: String::new(),
        }
    }

    #[test]
    fn candidate_policy_rejects_incompatible_media_and_licenses() {
        let mut input = candidate_for_source("source");
        assert!(bgm_candidate_allowed(&input));

        input.media_type = "video".to_string();
        assert!(!bgm_candidate_allowed(&input));

        input.media_type = "audio".to_string();
        input.commercial_use = Some(false);
        assert!(!bgm_candidate_allowed(&input));

        input.commercial_use = Some(true);
        for license_key in ["cc-by-nc-4.0", "cc-by-nd-4.0", "cc-by-sa-4.0"] {
            input.license_key = license_key.to_string();
            assert!(
                !bgm_candidate_allowed(&input),
                "{license_key} must be rejected"
            );
        }
    }

    #[test]
    fn bgm_queries_fall_back_from_specific_to_generic_without_duplicates() {
        assert_eq!(
            bgm_query_fallbacks("  technology   news background music electronic calm  "),
            vec![
                "technology news background music electronic calm",
                "technology background music",
                "background music instrumental",
            ]
        );
        assert_eq!(
            bgm_query_fallbacks("Background Music Instrumental"),
            vec!["Background Music Instrumental"]
        );
    }

    #[test]
    fn auto_provider_order_keeps_anonymous_openverse_as_fallback() {
        assert_eq!(
            resolve_bgm_provider_sources("auto", true, false),
            vec!["jamendo-audio", "openverse-audio"]
        );
        assert_eq!(
            resolve_bgm_provider_sources("auto", false, false),
            vec!["openverse-audio"]
        );
        assert_eq!(
            resolve_bgm_provider_sources("openverse-audio", true, false),
            vec!["openverse-audio", "jamendo-audio"]
        );
    }

    #[test]
    fn empty_results_use_simpler_query_and_record_the_successful_query() {
        let sources = vec!["openverse-audio".to_string()];
        let queries = bgm_query_fallbacks("technology news background music electronic calm");
        let mut search_calls = Vec::new();

        let selection = select_bgm_from_sources(
            &sources,
            &queries,
            Duration::from_secs(5),
            |source, query, _| {
                search_calls.push((source.to_string(), query.to_string()));
                if query == "technology background music" {
                    Ok(Some(vec![candidate_for_source(source)]))
                } else {
                    Ok(Some(Vec::new()))
                }
            },
            |_, _| Ok((0, PathBuf::from("track.mp3"))),
            |_| {},
        )
        .expect("selection should not fail")
        .expect("fallback query should find a candidate");

        assert_eq!(selection.query, "technology background music");
        assert_eq!(selection.candidate.source, "openverse-audio");
        assert_eq!(selection.artifact, PathBuf::from("track.mp3"));
        assert_eq!(
            search_calls,
            vec![
                (
                    "openverse-audio".to_string(),
                    "technology news background music electronic calm".to_string(),
                ),
                (
                    "openverse-audio".to_string(),
                    "technology background music".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn search_error_moves_to_next_source_without_retrying_simpler_queries() {
        let sources = vec!["openverse-audio".to_string(), "jamendo-audio".to_string()];
        let queries = bgm_query_fallbacks("technology news background music electronic calm");
        let mut search_calls = Vec::new();

        let selection = select_bgm_from_sources(
            &sources,
            &queries,
            Duration::from_secs(5),
            |source, query, _| {
                search_calls.push((source.to_string(), query.to_string()));
                if source == "openverse-audio" {
                    Err(anyhow::anyhow!("network timeout"))
                } else {
                    Ok(Some(vec![candidate_for_source(source)]))
                }
            },
            |_, _| Ok((0, ())),
            |_| {},
        )
        .expect("second source should still be attempted")
        .expect("second source should succeed");

        assert_eq!(selection.candidate.source, "jamendo-audio");
        assert_eq!(selection.query, queries[0]);
        assert_eq!(
            search_calls,
            vec![
                ("openverse-audio".to_string(), queries[0].clone()),
                ("jamendo-audio".to_string(), queries[0].clone()),
            ]
        );
    }

    #[test]
    fn exhausted_downloads_move_to_next_source_without_retrying_queries() {
        let sources = vec!["openverse-audio".to_string(), "jamendo-audio".to_string()];
        let queries = bgm_query_fallbacks("technology news background music electronic calm");
        let mut search_calls = Vec::new();
        let mut download_calls = Vec::new();
        let mut progress = Vec::new();

        let selection = select_bgm_from_sources(
            &sources,
            &queries,
            Duration::from_secs(5),
            |source, query, _| {
                search_calls.push((source.to_string(), query.to_string()));
                Ok(Some(vec![candidate_for_source(source)]))
            },
            |candidates, _| {
                let source = candidates[0].source.clone();
                download_calls.push(source.clone());
                if source == "openverse-audio" {
                    Err(anyhow::anyhow!("all candidate downloads failed"))
                } else {
                    Ok((0, ()))
                }
            },
            |phase| match phase {
                BgmAttemptPhase::Searching { current, .. }
                | BgmAttemptPhase::Downloading { current, .. } => progress.push(current),
            },
        )
        .expect("second source should still be attempted")
        .expect("second source should download successfully");

        assert_eq!(selection.candidate.source, "jamendo-audio");
        assert_eq!(
            search_calls,
            vec![
                ("openverse-audio".to_string(), queries[0].clone()),
                ("jamendo-audio".to_string(), queries[0].clone()),
            ]
        );
        assert_eq!(download_calls, vec!["openverse-audio", "jamendo-audio"]);
        assert_eq!(progress, vec![0, 1, 1, 1]);
    }

    #[test]
    fn acquire_timeout_prevents_unbounded_source_attempts() {
        let sources = vec!["openverse-audio".to_string()];
        let queries = vec!["background music instrumental".to_string()];
        let result: Result<Option<BgmSelection<()>>> = select_bgm_from_sources(
            &sources,
            &queries,
            Duration::ZERO,
            |_, _, _| panic!("search must not start after the total deadline"),
            |_, _| panic!("download must not start after the total deadline"),
            |_| {},
        );

        let error = match result {
            Ok(_) => panic!("zero budget should time out"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("BGM 素材获取总超时"));
    }
}
