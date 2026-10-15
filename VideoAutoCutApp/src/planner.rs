use anyhow::{Context, Result, bail};
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::domain::{plan_needs_bgm, shot_needs_download, shot_needs_voice};
use crate::models::{CapabilityId, JobPlan, JobStep, RunConfig, ShotPlan};
use crate::persistence::write_json_pretty_atomic;

pub(crate) fn read_job_plan(path: &Path) -> Result<JobPlan> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("读取任务编排 JSON 失败: {}", path.display()))?;
    let plan: JobPlan =
        serde_json::from_str(&text).with_context(|| format!("任务编排 JSON 无效: {}", text))?;
    validate_job_plan(plan)
}

pub(crate) fn write_job_plan(path: &Path, plan: &JobPlan) -> Result<()> {
    write_json_pretty_atomic(path, plan)
}

pub(crate) fn default_video_job_plan(shots: &ShotPlan, config: &RunConfig) -> Result<JobPlan> {
    let needs_stock_download = shots.shots.iter().any(shot_needs_download);
    let needs_query_optimization = needs_stock_download
        && shots
            .shots
            .iter()
            .any(|shot| shot_needs_download(shot) && shot.query_optimized != Some(true));
    let needs_voice = config.voiceover && shots.shots.iter().any(shot_needs_voice);
    let needs_bgm = plan_needs_bgm(shots, config);

    let mut steps = vec![
        default_job_step(CapabilityId::ParseScript),
        default_job_step(CapabilityId::PlanStoryboard),
    ];

    if needs_query_optimization {
        steps.push(default_job_step(CapabilityId::OptimizeQueries));
    }
    if needs_stock_download {
        steps.push(default_job_step(CapabilityId::DownloadAssets));
    }
    if needs_voice {
        steps.push(default_job_step(CapabilityId::PrepareVoice));
    }

    steps.push(default_job_step(CapabilityId::ClipSegments));
    steps.push(default_job_step(CapabilityId::ComposeVideo));
    if needs_bgm {
        steps.push(default_job_step(CapabilityId::PrepareBgm));
    }

    validate_job_plan(JobPlan {
        confidence: Some(1.0),
        reason: Some("default deterministic main workflow".to_string()),
        steps,
    })
}

fn validate_job_plan(mut plan: JobPlan) -> Result<JobPlan> {
    if plan.steps.is_empty() {
        bail!("任务编排缺少 steps，执行器不会自动补全流程");
    }

    plan.steps
        .retain(|step| step.capability != CapabilityId::GenerateCards);

    normalize_compose_requirements(&mut plan);

    for step in &plan.steps {
        validate_capability_is_executable(step.capability)?;
    }

    Ok(plan)
}

fn normalize_compose_requirements(plan: &mut JobPlan) {
    if has_capability(plan, CapabilityId::PrepareBgm) {
        ensure_capability_before(plan, CapabilityId::ComposeVideo, CapabilityId::PrepareBgm);
    }

    if !has_capability(plan, CapabilityId::ComposeVideo) {
        return;
    }

    ensure_capability_before(plan, CapabilityId::ClipSegments, CapabilityId::ComposeVideo);

    if has_capability(plan, CapabilityId::DownloadAssets) {
        ensure_capability_before(
            plan,
            CapabilityId::DownloadAssets,
            CapabilityId::ClipSegments,
        );
    }
}

fn has_capability(plan: &JobPlan, capability: CapabilityId) -> bool {
    plan.steps.iter().any(|step| step.capability == capability)
}

fn ensure_capability_before(plan: &mut JobPlan, capability: CapabilityId, before: CapabilityId) {
    let Some(target_index) = capability_index(plan, before) else {
        return;
    };

    match capability_index(plan, capability) {
        Some(current_index) if current_index < target_index => {}
        Some(current_index) => {
            let step = plan.steps.remove(current_index);
            let target_index = capability_index(plan, before).unwrap_or(plan.steps.len());
            plan.steps.insert(target_index, step);
        }
        None => {
            plan.steps
                .insert(target_index, default_job_step(capability));
        }
    }
}

fn capability_index(plan: &JobPlan, capability: CapabilityId) -> Option<usize> {
    plan.steps
        .iter()
        .position(|step| step.capability == capability)
}

fn default_job_step(capability: CapabilityId) -> JobStep {
    JobStep {
        capability,
        id: Some(default_capability_id(capability).to_string()),
        label: Some(default_capability_label(capability).to_string()),
        inputs: Value::Object(Default::default()),
        requires_confirmation: false,
    }
}

fn default_capability_id(capability: CapabilityId) -> &'static str {
    match capability {
        CapabilityId::ParseScript => "parse_script",
        CapabilityId::PlanStoryboard => "plan_storyboard",
        CapabilityId::OptimizeQueries => "optimize_queries",
        CapabilityId::DownloadAssets => "download_assets",
        CapabilityId::ReviewAssets => "review_assets",
        CapabilityId::PrepareVoice => "prepare_voice",
        CapabilityId::GenerateCards => "generate_cards",
        CapabilityId::ClipSegments => "clip_segments",
        CapabilityId::ComposeVideo => "compose_video",
        CapabilityId::PrepareBgm => "prepare_bgm",
        CapabilityId::SelectLocalMaterials => "select_local_materials",
        CapabilityId::IndexMaterials => "index_materials",
    }
}

fn default_capability_label(capability: CapabilityId) -> &'static str {
    match capability {
        CapabilityId::ParseScript => "解析脚本",
        CapabilityId::PlanStoryboard => "整理分镜",
        CapabilityId::OptimizeQueries => "优化搜索词",
        CapabilityId::DownloadAssets => "下载素材",
        CapabilityId::ReviewAssets => "评估素材",
        CapabilityId::PrepareVoice => "准备口播",
        CapabilityId::GenerateCards => "生成卡片",
        CapabilityId::ClipSegments => "剪辑片段",
        CapabilityId::ComposeVideo => "合成视频",
        CapabilityId::PrepareBgm => "背景音乐",
        CapabilityId::SelectLocalMaterials => "选择本地素材",
        CapabilityId::IndexMaterials => "索引素材",
    }
}

fn validate_capability_is_executable(capability: CapabilityId) -> Result<()> {
    match capability {
        CapabilityId::ParseScript
        | CapabilityId::PlanStoryboard
        | CapabilityId::OptimizeQueries
        | CapabilityId::DownloadAssets
        | CapabilityId::PrepareVoice
        | CapabilityId::GenerateCards
        | CapabilityId::ClipSegments
        | CapabilityId::ComposeVideo
        | CapabilityId::PrepareBgm => Ok(()),
        CapabilityId::ReviewAssets
        | CapabilityId::SelectLocalMaterials
        | CapabilityId::IndexMaterials => {
            bail!("能力 {:?} 已被规划，但当前执行器还没有独立实现", capability)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Shot;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn step(capability: CapabilityId) -> JobStep {
        JobStep {
            capability,
            id: None,
            label: None,
            inputs: Value::Null,
            requires_confirmation: false,
        }
    }

    fn plan(capabilities: &[CapabilityId]) -> JobPlan {
        JobPlan {
            confidence: None,
            reason: None,
            steps: capabilities.iter().copied().map(step).collect(),
        }
    }

    fn capabilities(plan: &JobPlan) -> Vec<CapabilityId> {
        plan.steps.iter().map(|step| step.capability).collect()
    }

    fn stock_shot(query_optimized: Option<bool>) -> Shot {
        Shot {
            shot_id: "shot_test".to_string(),
            shot: 1,
            title: "shot".to_string(),
            module_label: None,
            download_query: "query".to_string(),
            visual_query: "visual".to_string(),
            visual_mode: Some("stock_video".to_string()),
            query_optimized,
            duration: None,
            voice_text: None,
            voiceover: None,
            subtitle: None,
            clip_requirements: None,
            progress_text: None,
            highlight_rule: None,
            subtitle_effect: None,
            voice_requirements: None,
            time_range: None,
            card_content: None,
            card_hint: None,
            card_layout: None,
            download_material: None,
            material_bindings: vec![],
            extra_requirements: vec![],
            production_notes: vec![],
            content_blocks: vec![],
            extra: Default::default(),
        }
    }

    fn shot_plan(shot: Shot) -> ShotPlan {
        ShotPlan {
            schema_version: 2,
            task_revision: 0,
            topic: "topic".to_string(),
            background_music: None,
            content_blocks: vec![],
            extra_requirements: vec![],
            shots: vec![shot],
            extra: Default::default(),
        }
    }

    fn run_config() -> RunConfig {
        RunConfig {
            source: crate::cli::Source::Pexels,
            downloads_per_shot: 2,
            download_review: true,
            download_candidate_pool: 10,
            download_review_threshold: 70.0,
            clips_per_shot: 1,
            results_per_shot: 10,
            chunk_duration: 30,
            min_source_duration: None,
            max_source_duration: None,
            match_accept_threshold: 0.25,
            voiceover: true,
            subtitles: true,
            progress_bar: true,
            bgm_enabled: false,
            bgm_source: "openverse-audio".to_string(),
            bgm_query: None,
            bgm_candidate_pool: 8,
            bgm_min_duration: Some(15),
            bgm_max_duration: Some(300),
            bgm_volume: 0.16,
        }
    }

    #[test]
    fn compose_requires_clip_segments() {
        let plan = validate_job_plan(plan(&[
            CapabilityId::DownloadAssets,
            CapabilityId::PrepareVoice,
            CapabilityId::ComposeVideo,
        ]))
        .unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::DownloadAssets,
                CapabilityId::PrepareVoice,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn download_assets_runs_before_clip_segments() {
        let plan = validate_job_plan(plan(&[
            CapabilityId::ClipSegments,
            CapabilityId::DownloadAssets,
            CapabilityId::ComposeVideo,
        ]))
        .unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::DownloadAssets,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn default_video_plan_optimizes_stock_queries_before_download() {
        let plan =
            default_video_job_plan(&shot_plan(stock_shot(Some(false))), &run_config()).unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::ParseScript,
                CapabilityId::PlanStoryboard,
                CapabilityId::OptimizeQueries,
                CapabilityId::DownloadAssets,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn default_video_plan_does_not_repeat_finished_query_optimization() {
        let plan =
            default_video_job_plan(&shot_plan(stock_shot(Some(true))), &run_config()).unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::ParseScript,
                CapabilityId::PlanStoryboard,
                CapabilityId::DownloadAssets,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn default_video_plan_ignores_card_fields_while_cards_are_disabled() {
        let mut shot = stock_shot(Some(true));
        shot.card_content = Some("需要展示的卡片内容".to_string());
        shot.card_hint = Some("使用数据卡片".to_string());

        let plan = default_video_job_plan(&shot_plan(shot), &run_config()).unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::ParseScript,
                CapabilityId::PlanStoryboard,
                CapabilityId::DownloadAssets,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn read_job_plan_filters_disabled_generate_cards_step() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "video_auto_job_plan_cards_{}_{nonce}.json",
            std::process::id()
        ));
        let external_plan = plan(&[
            CapabilityId::ParseScript,
            CapabilityId::GenerateCards,
            CapabilityId::ComposeVideo,
        ]);
        fs::write(
            &path,
            serde_json::to_vec(&external_plan).expect("serialize external plan"),
        )
        .expect("write external plan fixture");

        let filtered = read_job_plan(&path).expect("read external plan");
        let _ = fs::remove_file(path);

        assert_eq!(
            capabilities(&filtered),
            vec![
                CapabilityId::ParseScript,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
            ]
        );
    }

    #[test]
    fn default_video_plan_adds_bgm_after_compose_when_requested() {
        let mut config = run_config();
        config.bgm_enabled = true;
        let mut plan_input = shot_plan(stock_shot(Some(true)));
        plan_input.background_music = Some(crate::models::BackgroundMusicPlan {
            enabled: Some(true),
            description: Some("calm technology background music".to_string()),
            query: None,
        });

        let plan = default_video_job_plan(&plan_input, &config).unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::ParseScript,
                CapabilityId::PlanStoryboard,
                CapabilityId::DownloadAssets,
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
                CapabilityId::PrepareBgm,
            ]
        );
    }

    #[test]
    fn prepare_bgm_requires_compose_video() {
        let plan = validate_job_plan(plan(&[CapabilityId::PrepareBgm])).unwrap();

        assert_eq!(
            capabilities(&plan),
            vec![
                CapabilityId::ClipSegments,
                CapabilityId::ComposeVideo,
                CapabilityId::PrepareBgm,
            ]
        );
    }
}
