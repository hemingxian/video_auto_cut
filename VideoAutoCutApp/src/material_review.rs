use anyhow::{Context, Result, anyhow, bail};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::candidate::{DownloadCandidate, value_f64, value_string, value_u64};
use crate::models::{AppPaths, RunConfig, Shot};
use crate::persistence::write_json_pretty_atomic;

#[derive(Debug, Clone)]
pub(crate) struct DownloadCandidateDecision {
    pub(crate) id: String,
    pub(crate) index: usize,
    pub(crate) score: f32,
    pub(crate) decision: String,
    pub(crate) reason: String,
    pub(crate) reject_type: String,
}

fn strip_json_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }

    let without_open = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim();

    without_open.trim_end_matches("```").trim().to_string()
}

fn parse_json_response_text(text: &str) -> Result<Value> {
    let cleaned = strip_json_code_fence(text);
    serde_json::from_str(&cleaned).with_context(|| format!("模型没有返回可解析 JSON: {cleaned}"))
}

fn chat_message_content(response: &Value) -> Result<&str> {
    response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "DashScope 审核响应缺少 choices[0].message.content: {}",
                response
            )
        })
}

fn resolve_dashscope_chat_completions_url(
    relay_root: Option<&str>,
    endpoint_override: Option<&str>,
) -> String {
    if let Some(root) = relay_root.map(str::trim).filter(|value| !value.is_empty()) {
        return format!("{}/v1/chat/completions", root.trim_end_matches('/'));
    }
    endpoint_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
        .to_string()
}

fn dashscope_chat_completions_url() -> String {
    let relay_root = env::var("DASHSCOPE_BASE_URL").ok();
    let endpoint_override = env::var("DASHSCOPE_OPENAI_BASE_URL").ok();
    resolve_dashscope_chat_completions_url(relay_root.as_deref(), endpoint_override.as_deref())
}

fn prompt_template_paths(paths: &AppPaths, name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(directory) = env::var_os("VIDEOAUTO_RUST_PROMPT_DIR") {
        candidates.push(PathBuf::from(directory).join(name));
    }

    candidates.push(paths.root.join("prompts").join("rust").join(name));

    if let Some(repo_root) = paths.root.parent() {
        candidates.push(repo_root.join("VideoAutoCutApp").join("prompts").join(name));
    }

    if let Ok(current_directory) = env::current_dir() {
        candidates.push(
            current_directory
                .join("VideoAutoCutApp")
                .join("prompts")
                .join(name),
        );
        if let Some(parent) = current_directory.parent() {
            candidates.push(parent.join("VideoAutoCutApp").join("prompts").join(name));
        }
    }

    candidates
}

fn read_prompt_template(paths: &AppPaths, name: &str) -> Result<String> {
    let candidates = prompt_template_paths(paths, name);
    for path in &candidates {
        if path.is_file() {
            return fs::read_to_string(path)
                .with_context(|| format!("读取提示词模板失败: {}", path.display()));
        }
    }

    let searched = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    bail!("缺少提示词模板: {name}，已查找: {searched}")
}

fn render_prompt_template(template: &str, values: &[(&str, String)]) -> String {
    values
        .iter()
        .fold(template.to_string(), |text, (key, value)| {
            text.replace(&format!("{{{{{key}}}}}"), value)
        })
}

fn send_download_review_request(
    client: &Client,
    url: &str,
    api_key: &str,
    body: &Value,
) -> Result<Value> {
    client
        .post(url)
        .bearer_auth(api_key)
        .json(body)
        .send()
        .context("DashScope download review request failed")?
        .error_for_status()
        .context("DashScope download review returned error status")?
        .json()
        .context("DashScope download review JSON parse failed")
}

pub(crate) fn review_download_candidates(
    paths: &AppPaths,
    shot: &Shot,
    candidates: &[DownloadCandidate],
    config: &RunConfig,
) -> Result<Vec<DownloadCandidateDecision>> {
    let api_key = env::var("DASHSCOPE_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("DASHSCOPE_API_KEY is missing"))?;

    let model = env::var("DASHSCOPE_DOWNLOAD_REVIEW_MODEL")
        .or_else(|_| env::var("DASHSCOPE_TEXT_MODEL"))
        .or_else(|_| env::var("DASHSCOPE_MODEL"))
        .unwrap_or_else(|_| "qwen-plus".to_string());

    let url = dashscope_chat_completions_url();

    let candidate_payload: Vec<Value> = candidates
        .iter()
        .map(|candidate| {
            json!({
                "index": candidate.index,
                "id": candidate.id,
                "source": candidate.source,
                "provider": candidate.provider,
                "media_type": candidate.media_type,
                "title": candidate.title,
                "description": candidate.description,
                "uploader": candidate.uploader,
                "creator": candidate.creator,
                "duration_seconds": candidate.duration,
                "view_count": candidate.view_count,
                "upload_date": candidate.upload_date,
                "tags": candidate.tags,
                "thumbnail_url": candidate.thumbnail,
                "url": candidate.public_url(),
                "license": candidate.license,
                "license_key": candidate.license_key,
                "license_url": candidate.license_url,
                "commercial_use": candidate.commercial_use,
                "attribution_required": candidate.attribution_required,
            })
        })
        .collect();

    let template = read_prompt_template(paths, "download_candidate_review.md")?;
    let prompt = render_prompt_template(
        &template,
        &[
            ("title", shot.title.clone()),
            ("download_query", shot.download_query.clone()),
            ("visual_query", shot.visual_query.clone()),
            (
                "voice_text",
                shot.voice_text.as_deref().unwrap_or("").to_string(),
            ),
            (
                "clip_requirements",
                shot.clip_requirements.as_deref().unwrap_or("").to_string(),
            ),
            (
                "threshold",
                format!("{:.0}", config.download_review_threshold),
            ),
            (
                "candidates",
                serde_json::to_string_pretty(&candidate_payload)?,
            ),
        ],
    );

    let messages = json!([
        {
            "role": "system",
            "content": "你只输出一个 JSON object，不能输出 Markdown。"
        },
        {
            "role": "user",
            "content": prompt
        }
    ]);

    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "response_format": { "type": "json_object" }
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    let response = match send_download_review_request(&client, &url, &api_key, &body) {
        Ok(response) => response,
        Err(first_error) => {
            if let Some(object) = body.as_object_mut() {
                object.remove("response_format");
            }
            send_download_review_request(&client, &url, &api_key, &body).with_context(|| {
                format!(
                    "download review failed after retry without response_format: {first_error:#}"
                )
            })?
        }
    };

    let content = chat_message_content(&response)?;
    let parsed = parse_json_response_text(content)?;

    Ok(parse_candidate_decisions(&parsed))
}

fn parse_candidate_decisions(value: &Value) -> Vec<DownloadCandidateDecision> {
    value
        .get("items")
        .or_else(|| value.get("candidates"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let index = value_u64(item.get("index")).unwrap_or(0) as usize;
                    let id = value_string(item, "id");
                    if id.is_empty() && index == 0 {
                        return None;
                    }

                    let score = value_f64(item.get("score")).unwrap_or(0.0) as f32;
                    let score = if score.is_finite() { score } else { 0.0 };

                    Some(DownloadCandidateDecision {
                        id,
                        index,
                        score,
                        decision: value_string(item, "decision").to_lowercase(),
                        reason: value_string(item, "reason"),
                        reject_type: value_string(item, "reject_type"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn select_candidates_for_download(
    candidates: &[DownloadCandidate],
    decisions: &[DownloadCandidateDecision],
    count: usize,
    threshold: f32,
) -> Vec<DownloadCandidate> {
    let by_id: HashMap<&str, &DownloadCandidateDecision> = decisions
        .iter()
        .filter(|decision| !decision.id.is_empty())
        .map(|decision| (decision.id.as_str(), decision))
        .collect();

    let by_index: HashMap<usize, &DownloadCandidateDecision> = decisions
        .iter()
        .filter(|decision| decision.index > 0)
        .map(|decision| (decision.index, decision))
        .collect();

    let mut ranked: Vec<(&DownloadCandidate, &DownloadCandidateDecision)> = candidates
        .iter()
        .filter_map(|candidate| {
            let decision = by_id
                .get(candidate.id.as_str())
                .copied()
                .or_else(|| by_index.get(&candidate.index).copied())?;

            let rejected = decision.decision.contains("reject");
            if rejected || decision.score < threshold || !candidate.has_download_target() {
                return None;
            }

            Some((candidate, decision))
        })
        .collect();

    ranked.sort_by(
        |(left_candidate, left_decision), (right_candidate, right_decision)| {
            right_decision
                .score
                .partial_cmp(&left_decision.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left_candidate.index.cmp(&right_candidate.index))
        },
    );

    ranked
        .into_iter()
        .take(count)
        .map(|(candidate, _)| candidate.clone())
        .collect()
}

pub(crate) fn write_download_review(
    output_directory: &Path,
    candidates: &[DownloadCandidate],
    decisions: &[DownloadCandidateDecision],
    selected: &[DownloadCandidate],
) -> Result<()> {
    let selected_ids: HashSet<&str> = selected
        .iter()
        .map(|candidate| candidate.id.as_str())
        .collect();
    let decision_by_id: HashMap<&str, &DownloadCandidateDecision> = decisions
        .iter()
        .filter(|decision| !decision.id.is_empty())
        .map(|decision| (decision.id.as_str(), decision))
        .collect();
    let decision_by_index: HashMap<usize, &DownloadCandidateDecision> = decisions
        .iter()
        .filter(|decision| decision.index > 0)
        .map(|decision| (decision.index, decision))
        .collect();

    let items: Vec<Value> = candidates
        .iter()
        .map(|candidate| {
            let decision = decision_by_id
                .get(candidate.id.as_str())
                .copied()
                .or_else(|| decision_by_index.get(&candidate.index).copied());

            json!({
                "selected": selected_ids.contains(candidate.id.as_str()),
                "candidate": {
                    "index": candidate.index,
                    "id": candidate.id,
                    "source": candidate.source,
                    "provider": candidate.provider,
                    "media_type": candidate.media_type,
                    "title": candidate.title,
                    "url": candidate.public_url(),
                    "download_url": candidate.download_url,
                    "thumbnail": candidate.thumbnail,
                    "uploader": candidate.uploader,
                    "creator": candidate.creator,
                    "duration_seconds": candidate.duration,
                    "tags": candidate.tags,
                    "license": candidate.license,
                    "license_key": candidate.license_key,
                    "license_url": candidate.license_url,
                    "commercial_use": candidate.commercial_use,
                    "attribution_required": candidate.attribution_required,
                    "attribution": candidate.attribution,
                },
                "review": decision.map(|item| json!({
                    "score": item.score,
                    "decision": item.decision,
                    "reject_type": item.reject_type,
                    "reason": item.reason,
                })),
            })
        })
        .collect();

    write_json_pretty_atomic(
        &output_directory.join("download_review.json"),
        &json!({ "items": items }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(index: usize, id: &str, download_url: &str) -> DownloadCandidate {
        DownloadCandidate {
            index,
            id: id.to_string(),
            source: "source".to_string(),
            provider: "provider".to_string(),
            media_type: "video".to_string(),
            title: format!("candidate {id}"),
            description: String::new(),
            uploader: String::new(),
            creator: String::new(),
            creator_url: String::new(),
            webpage_url: String::new(),
            download_url: download_url.to_string(),
            thumbnail: String::new(),
            duration: None,
            filetype: "mp4".to_string(),
            view_count: None,
            upload_date: String::new(),
            tags: vec![],
            license: String::new(),
            license_key: String::new(),
            license_url: String::new(),
            commercial_use: None,
            attribution_required: None,
            attribution: String::new(),
        }
    }

    fn decision(id: &str, index: usize, score: f32, value: &str) -> DownloadCandidateDecision {
        DownloadCandidateDecision {
            id: id.to_string(),
            index,
            score,
            decision: value.to_string(),
            reason: String::new(),
            reject_type: String::new(),
        }
    }

    #[test]
    fn parses_fenced_decisions_and_discards_unidentifiable_items() {
        let parsed = parse_json_response_text(
            r#"```json
            {"items":[
                {"id":"a","index":"1","score":"88.5","decision":"ACCEPT","reason":"fit"},
                {"score":99}
            ]}
            ```"#,
        )
        .expect("parse fenced response");

        let decisions = parse_candidate_decisions(&parsed);

        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].id, "a");
        assert_eq!(decisions[0].index, 1);
        assert_eq!(decisions[0].score, 88.5);
        assert_eq!(decisions[0].decision, "accept");
        assert_eq!(decisions[0].reason, "fit");
    }

    #[test]
    fn non_finite_model_scores_are_treated_as_zero() {
        let parsed = json!({
            "candidates": [
                {"id": "a", "score": "NaN", "decision": "accept"},
                {"id": "b", "score": "1e300", "decision": "accept"}
            ]
        });

        let decisions = parse_candidate_decisions(&parsed);

        assert_eq!(decisions.len(), 2);
        assert_eq!(decisions[0].score, 0.0);
        assert_eq!(decisions[1].score, 0.0);
    }

    #[test]
    fn selection_applies_policy_and_sorts_by_score_then_index() {
        let candidates = vec![
            candidate(1, "a", "https://example.com/a.mp4"),
            candidate(2, "b", "https://example.com/b.mp4"),
            candidate(3, "c", ""),
            candidate(4, "d", "https://example.com/d.mp4"),
        ];
        let decisions = vec![
            decision("a", 99, 90.0, "accept"),
            decision("", 1, 100.0, "reject"),
            decision("", 2, 95.0, "accept"),
            decision("", 3, 100.0, "accept"),
            decision("d", 4, 100.0, "reject"),
        ];

        let selected = select_candidates_for_download(&candidates, &decisions, 4, 80.0);
        assert_eq!(
            selected
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );

        let above_higher_threshold =
            select_candidates_for_download(&candidates, &decisions, 4, 91.0);
        assert_eq!(
            above_higher_threshold
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }

    #[test]
    fn malformed_json_response_has_actionable_error() {
        let error = parse_json_response_text("```json\nnot-json\n```")
            .expect_err("malformed response should fail");

        assert!(error.to_string().contains("模型没有返回可解析 JSON"));
    }

    #[test]
    fn prompt_renderer_replaces_all_occurrences() {
        let rendered = render_prompt_template(
            "{{title}} / {{title}} / {{query}}",
            &[
                ("title", "Example".to_string()),
                ("query", "footage".to_string()),
            ],
        );

        assert_eq!(rendered, "Example / Example / footage");
    }

    #[test]
    fn relay_root_controls_chat_endpoint_and_keeps_direct_fallback() {
        assert_eq!(
            resolve_dashscope_chat_completions_url(
                Some(" https://api.evstai.com/ "),
                Some("https://old.example/v1/chat/completions"),
            ),
            "https://api.evstai.com/v1/chat/completions"
        );
        assert_eq!(
            resolve_dashscope_chat_completions_url(
                None,
                Some(" https://custom.example/chat/completions "),
            ),
            "https://custom.example/chat/completions"
        );
        assert_eq!(
            resolve_dashscope_chat_completions_url(None, None),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
    }
}
