use serde_json::Value;

use crate::models::{RunConfig, Shot, ShotPlan};

pub(crate) fn shot_voice_text(shot: &Shot) -> Option<&str> {
    if shot.voiceover == Some(false) {
        return None;
    }

    shot.voice_text.as_deref().and_then(non_empty_trimmed)
}

pub(crate) fn shot_needs_voice(shot: &Shot) -> bool {
    shot_voice_text(shot).is_some()
}

pub(crate) fn shot_visual_mode(shot: &Shot) -> &str {
    shot.visual_mode
        .as_deref()
        .and_then(non_empty_trimmed)
        .unwrap_or("stock_video")
}

pub(crate) fn shot_needs_download(shot: &Shot) -> bool {
    shot.download_material
        .unwrap_or_else(|| shot_visual_mode(shot).eq_ignore_ascii_case("stock_video"))
}

pub(crate) fn plan_needs_bgm(plan: &ShotPlan, config: &RunConfig) -> bool {
    if !config.bgm_enabled {
        return false;
    }

    if config
        .bgm_query
        .as_deref()
        .and_then(non_empty_trimmed)
        .is_some()
    {
        return true;
    }

    if let Some(bgm) = &plan.background_music {
        if let Some(enabled) = bgm.enabled {
            return enabled;
        }

        return bgm
            .description
            .as_deref()
            .and_then(non_empty_trimmed)
            .is_some()
            || bgm.query.as_deref().and_then(non_empty_trimmed).is_some();
    }

    legacy_plan_has_bgm_intent(plan)
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn legacy_plan_has_bgm_intent(plan: &ShotPlan) -> bool {
    plan.content_blocks
        .iter()
        .chain(&plan.extra_requirements)
        .chain(plan.shots.iter().flat_map(|shot| {
            shot.content_blocks
                .iter()
                .chain(&shot.extra_requirements)
                .chain(&shot.production_notes)
        }))
        .any(value_has_bgm_intent)
}

fn value_has_bgm_intent(value: &Value) -> bool {
    match value {
        Value::String(text) => text_has_bgm_intent(text),
        Value::Array(items) => items.iter().any(value_has_bgm_intent),
        Value::Object(map) => map
            .iter()
            .any(|(key, item)| text_has_bgm_intent(key) || value_has_bgm_intent(item)),
        _ => false,
    }
}

fn text_has_bgm_intent(text: &str) -> bool {
    let lowered = text.to_lowercase();
    let has_bgm = lowered.contains("bgm")
        || lowered.contains("background music")
        || text.contains("背景音乐")
        || text.contains("配乐");
    if !has_bgm {
        return false;
    }

    !(text.contains("不要背景音乐")
        || text.contains("不需要背景音乐")
        || text.contains("无背景音乐")
        || text.contains("不要配乐")
        || text.contains("不需要配乐")
        || text.contains("无配乐")
        || lowered.contains("no bgm")
        || lowered.contains("without bgm")
        || lowered.contains("no background music")
        || lowered.contains("without background music"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Source;
    use crate::models::BackgroundMusicPlan;
    use serde_json::json;

    fn shot() -> Shot {
        Shot {
            shot_id: "shot_test".to_string(),
            shot: 1,
            title: "shot".to_string(),
            module_label: None,
            download_query: String::new(),
            visual_query: String::new(),
            visual_mode: None,
            query_optimized: None,
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

    fn plan() -> ShotPlan {
        ShotPlan {
            schema_version: 2,
            task_revision: 0,
            topic: "topic".to_string(),
            background_music: None,
            content_blocks: vec![],
            extra_requirements: vec![],
            shots: vec![shot()],
            extra: Default::default(),
        }
    }

    fn config() -> RunConfig {
        RunConfig {
            source: Source::Pexels,
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
            bgm_enabled: true,
            bgm_source: "auto".to_string(),
            bgm_query: None,
            bgm_candidate_pool: 8,
            bgm_min_duration: Some(15),
            bgm_max_duration: Some(300),
            bgm_volume: 0.16,
        }
    }

    #[test]
    fn card_layout_round_trips_and_stays_absent_when_missing() {
        // 2026-09-23：Python 校验层按脚本版式标签写的 card_layout 必须原样经过引擎，
        // 没写的镜序列化后不能多出这个键（旧 plan 逐字节不变）。
        let plan: ShotPlan = serde_json::from_value(json!({
            "topic": "t",
            "shots": [
                {"shot": 1, "title": "a", "card_content": "大字\n小字", "card_layout": "headline_sub"},
                {"shot": 2, "title": "b", "card_content": "单行"}
            ]
        }))
        .expect("parse plan");
        assert_eq!(plan.shots[0].card_layout.as_deref(), Some("headline_sub"));
        assert_eq!(plan.shots[1].card_layout, None);
        let value = serde_json::to_value(&plan).expect("serialize plan");
        assert_eq!(value["shots"][0]["card_layout"], json!("headline_sub"));
        assert_eq!(value["shots"][0]["card_content"], json!("大字\n小字"));
        assert!(value["shots"][1].get("card_layout").is_none());
    }

    #[test]
    fn voice_text_is_trimmed_and_honors_per_shot_opt_out() {
        let mut input = shot();
        input.voice_text = Some("  narration  ".to_string());
        assert_eq!(shot_voice_text(&input), Some("narration"));

        input.voiceover = Some(false);
        assert_eq!(shot_voice_text(&input), None);
    }

    #[test]
    fn visual_mode_defaults_only_when_missing_or_blank() {
        let mut input = shot();
        assert_eq!(shot_visual_mode(&input), "stock_video");

        input.visual_mode = Some("  card  ".to_string());
        assert_eq!(shot_visual_mode(&input), "card");
    }

    #[test]
    fn explicit_download_material_is_independent_from_visual_mode() {
        let mut input = shot();
        input.visual_mode = Some("stock_video".to_string());
        input.download_material = Some(false);
        assert!(!shot_needs_download(&input));

        input.visual_mode = Some("local_material".to_string());
        input.download_material = Some(true);
        assert!(shot_needs_download(&input));
    }

    #[test]
    fn explicit_bgm_disable_overrides_descriptions() {
        let mut input = plan();
        input.background_music = Some(BackgroundMusicPlan {
            enabled: Some(false),
            description: Some("calm background music".to_string()),
            query: None,
        });

        assert!(!plan_needs_bgm(&input, &config()));
    }

    #[test]
    fn legacy_bgm_intent_supports_nested_values_and_negation() {
        let mut input = plan();
        input.extra_requirements = vec![json!({"audio": ["calm BGM"]})];
        assert!(plan_needs_bgm(&input, &config()));

        input.extra_requirements = vec![json!({"audio": ["without background music"]})];
        assert!(!plan_needs_bgm(&input, &config()));
    }
}
