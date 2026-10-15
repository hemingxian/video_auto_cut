use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

use crate::cli::Source;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Shot {
    #[serde(default)]
    pub(crate) shot_id: String,

    pub(crate) shot: usize,
    pub(crate) title: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) module_label: Option<String>,

    #[serde(default)]
    pub(crate) download_query: String,

    #[serde(default)]
    pub(crate) visual_query: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) visual_mode: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) query_optimized: Option<bool>,

    #[serde(default, deserialize_with = "deserialize_optional_duration")]
    pub(crate) duration: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) voice_text: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) voiceover: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subtitle: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) clip_requirements: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) progress_text: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) highlight_rule: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subtitle_effect: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) voice_requirements: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) time_range: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) card_content: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) card_hint: Option<String>,

    /// 上屏卡片版式（`headline_sub` / `equal_lines`），由 Python 校验层按脚本版式标签写入，
    /// 引擎只原样透传到 shots.json，不解释、不生成。缺省时不序列化，旧 plan 逐字节不变。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) card_layout: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) download_material: Option<bool>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) material_bindings: Vec<ShotMaterialBinding>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) extra_requirements: Vec<Value>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) production_notes: Vec<Value>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) content_blocks: Vec<Value>,

    #[serde(flatten)]
    pub(crate) extra: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "binding_type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ShotMaterialBinding {
    Material {
        material_id: String,
    },
    Folder {
        folder_id: String,
        include_subfolders: bool,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GenerationMaterialManifest {
    pub(crate) schema_version: u32,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) task_revision: u64,
    pub(crate) resolved_at: String,
    pub(crate) shots: Vec<GenerationManifestShot>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GenerationManifestShot {
    pub(crate) shot_id: String,
    pub(crate) materials: Vec<GenerationManifestItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GenerationManifestItem {
    pub(crate) material_id: String,
    pub(crate) asset_id: String,
    pub(crate) asset_version: u32,
    pub(crate) source_sha256: String,
    pub(crate) local_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ShotPlan {
    #[serde(default = "shot_plan_schema_version")]
    pub(crate) schema_version: u32,

    #[serde(default)]
    pub(crate) task_revision: u64,

    pub(crate) topic: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) background_music: Option<BackgroundMusicPlan>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) content_blocks: Vec<Value>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) extra_requirements: Vec<Value>,

    pub(crate) shots: Vec<Shot>,

    #[serde(flatten)]
    pub(crate) extra: Map<String, Value>,
}

fn shot_plan_schema_version() -> u32 {
    2
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct BackgroundMusicPlan {
    #[serde(default)]
    pub(crate) enabled: Option<bool>,

    #[serde(default)]
    pub(crate) description: Option<String>,

    #[serde(default)]
    pub(crate) query: Option<String>,
}

fn deserialize_optional_duration<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    let seconds = match value {
        Value::Null => return Ok(None),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };

    let Some(seconds) = seconds else {
        return Ok(None);
    };
    if !seconds.is_finite() || seconds <= 0.0 {
        return Ok(None);
    }

    Ok(Some(seconds.ceil().min(u32::MAX as f64) as u32))
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_plan_and_shot_fields_round_trip_as_json_values() {
        let input = json!({"schema_version":2,"task_revision":0,"topic":"t",
            "script_source":{"中文键":[1,null]},"shots":[{"shot_id":"s1","shot":1,
            "title":"one","download_query":"","visual_query":"","duration":null,
            "script_meta":{"review":{"warnings":["w"]}},
            "render_hints":{"caption_source":"subtitle"},"voice_audio":{"path":"voice.wav"},
            "material_resolution":null}]});
        let plan: ShotPlan = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(plan).unwrap(), input);
    }

    #[test]
    fn flatten_keeps_duration_and_tagged_material_bindings_semantics() {
        let plan: ShotPlan = serde_json::from_value(json!({"topic":"t","script_source":{"v":1},
            "shots":[{"shot_id":"s1","shot":1,"title":"one","duration":"9.5",
            "material_bindings":[{"binding_type":"folder","folder_id":"f","include_subfolders":true},
            {"binding_type":"material","material_id":"m"}],"script_meta":{"x":1}}]})).unwrap();
        assert_eq!(plan.shots[0].duration, Some(10));
        assert_eq!(plan.shots[0].material_bindings.len(), 2);
        assert_eq!(
            serde_json::to_value(&plan.shots[0].material_bindings).unwrap(),
            json!([
                {"binding_type":"folder","folder_id":"f","include_subfolders":true},
                {"binding_type":"material","material_id":"m"}
            ])
        );
        assert_eq!(plan.shots[0].extra["script_meta"], json!({"x":1}));
        assert_eq!(plan.extra["script_source"], json!({"v":1}));
    }

    #[test]
    fn tagged_material_bindings_still_reject_unknown_fields() {
        let result = serde_json::from_value::<ShotPlan>(json!({"topic":"t","shots":[{
            "shot":1,"title":"one","material_bindings":[{"binding_type":"material",
            "material_id":"m","unknown":true}]}]}));
        assert!(result.is_err());
    }

    #[test]
    fn known_only_plan_serialization_is_byte_stable() {
        let plan: ShotPlan = serde_json::from_value(json!({"topic":"t","shots":[{
            "shot":1,"title":"one"}]}))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&plan).unwrap(),
            r#"{"schema_version":2,"task_revision":0,"topic":"t","shots":[{"shot_id":"","shot":1,"title":"one","download_query":"","visual_query":"","duration":null}]}"#
        );
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CapabilityId {
    ParseScript,
    PlanStoryboard,
    OptimizeQueries,
    DownloadAssets,
    ReviewAssets,
    PrepareVoice,
    GenerateCards,
    ClipSegments,
    ComposeVideo,
    PrepareBgm,
    SelectLocalMaterials,
    IndexMaterials,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct JobStep {
    pub(crate) capability: CapabilityId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,

    #[serde(default)]
    pub(crate) inputs: Value,

    #[serde(default)]
    pub(crate) requires_confirmation: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct JobPlan {
    #[serde(default)]
    pub(crate) confidence: Option<f32>,

    #[serde(default)]
    pub(crate) reason: Option<String>,

    pub(crate) steps: Vec<JobStep>,
}

impl JobPlan {
    pub(crate) fn storyboard_only(reason: impl Into<String>) -> Self {
        Self {
            confidence: Some(1.0),
            reason: Some(reason.into()),
            steps: vec![
                JobStep {
                    capability: CapabilityId::ParseScript,
                    id: Some("parse_script".to_string()),
                    label: Some("解析脚本".to_string()),
                    inputs: Value::Null,
                    requires_confirmation: false,
                },
                JobStep {
                    capability: CapabilityId::PlanStoryboard,
                    id: Some("plan_storyboard".to_string()),
                    label: Some("整理分镜".to_string()),
                    inputs: Value::Null,
                    requires_confirmation: false,
                },
            ],
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AppPaths {
    pub(crate) root: PathBuf,
    pub(crate) data_root: PathBuf,
    pub(crate) env_path: PathBuf,
    pub(crate) yt_dlp: PathBuf,
    pub(crate) sentrysearch: PathBuf,
    pub(crate) sentry_py: Option<(PathBuf, PathBuf)>,
    pub(crate) ffmpeg: Option<PathBuf>,
    pub(crate) node: Option<PathBuf>,
    pub(crate) runs_dir: PathBuf,
    pub(crate) archive: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct RunConfig {
    pub(crate) source: Source,
    pub(crate) downloads_per_shot: usize,
    pub(crate) download_review: bool,
    pub(crate) download_candidate_pool: usize,
    pub(crate) download_review_threshold: f32,
    pub(crate) clips_per_shot: usize,
    pub(crate) results_per_shot: usize,
    pub(crate) chunk_duration: u32,
    pub(crate) min_source_duration: Option<u32>,
    pub(crate) max_source_duration: Option<u32>,
    pub(crate) match_accept_threshold: f32,
    pub(crate) voiceover: bool,
    pub(crate) subtitles: bool,
    pub(crate) progress_bar: bool,
    pub(crate) bgm_enabled: bool,
    pub(crate) bgm_source: String,
    pub(crate) bgm_query: Option<String>,
    pub(crate) bgm_candidate_pool: usize,
    pub(crate) bgm_min_duration: Option<u32>,
    pub(crate) bgm_max_duration: Option<u32>,
    pub(crate) bgm_volume: f32,
}
