//! Per-shot receipts: an input match alone never proves an output can be reused.
use crate::{
    checkpoint::hash_file,
    clip_manifest::ClipManifest,
    domain::{shot_needs_download, shot_needs_voice},
    material_clip::{
        MaterialClipContext, MaterialPreparationMode, create_shot_clips, prepare_shot_materials,
        stage_manifest_materials,
    },
    models::{
        AppPaths, CapabilityId, GenerationMaterialManifest, JobPlan, JobStep, RunConfig, Shot,
        ShotPlan,
    },
    persistence::write_json_pretty_atomic,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Journal {
    schema_version: u32,
    records: BTreeMap<String, Receipt>,
    #[serde(skip)]
    root: PathBuf,
    #[serde(skip)]
    final_file: Option<PathBuf>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    input_hash: String,
    files: BTreeMap<PathBuf, String>,
    output: Value,
}

pub(crate) fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
fn fields(value: &Value, names: &[&str]) -> Value {
    names
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                value.get(name).cloned().unwrap_or(Value::Null),
            )
        })
        .collect()
}
fn is_stage_setting(stage: &str, key: &str) -> bool {
    if ["KEY", "TOKEN", "SECRET", "ROOT"]
        .iter()
        .any(|part| key.contains(part))
    {
        return false;
    }
    match stage {
        "query" => key.starts_with("DASHSCOPE_TEXT_") || key.starts_with("QWEN_TEXT_"),
        "voice" => {
            [
                "TTS_",
                "ASR_",
                "VOICE_",
                "DASHSCOPE_TTS_",
                "DASHSCOPE_TEXT_",
                "QWEN_TEXT_",
            ]
            .iter()
            .any(|prefix| key.starts_with(prefix))
                || [
                    "SUBTITLE_MAX_CHARS",
                    "DASHSCOPE_BASE_URL",
                    "DASHSCOPE_OPENAI_BASE_URL",
                ]
                .contains(&key)
        }
        "clip" => [
            "MATERIAL_EXCLUDE_OVERLAYS",
            "MATERIAL_RANDOM_BOUND_FALLBACK",
            "DASHSCOPE_VISUAL_REVIEW_MODEL",
            "DASHSCOPE_EMBEDDING_MODEL",
        ]
        .contains(&key),
        "download" => {
            (key.starts_with("MATERIAL_")
                && ![
                    "MATERIAL_EXCLUDE_OVERLAYS",
                    "MATERIAL_RANDOM_BOUND_FALLBACK",
                ]
                .contains(&key))
                || key == "DASHSCOPE_VISUAL_REVIEW_MODEL"
        }
        _ => [
            "VIDEOAUTO_",
            "DASHSCOPE_",
            "QWEN_",
            "TTS_",
            "ASR_",
            "VOICE_",
            "SUBTITLE_",
            "BGM_",
            "MATERIAL_",
        ]
        .iter()
        .any(|prefix| key.starts_with(prefix)),
    }
}
fn settings(stage: &str) -> Value {
    let values: BTreeMap<_, _> = std::env::vars()
        .filter(|(key, _)| is_stage_setting(stage, key))
        .collect();
    json!(values)
}
pub(crate) fn shot_input(stage: &str, shot: &Value, config: &Value, sources: &Value) -> String {
    let selected = match stage {
        "query" => fields(
            shot,
            &[
                "download_query",
                "visual_query",
                "visual_mode",
                "clip_requirements",
            ],
        ),
        "voice" => fields(shot, &["voice_text", "voiceover", "voice_requirements"]),
        "download" => {
            if shot["download_material"].as_bool().unwrap_or(true) {
                fields(shot, &["download_material", "download_query"])
            } else {
                fields(shot, &["download_material", "material_bindings"])
            }
        }
        "clip" => fields(shot, &["visual_query", "visual_mode", "clip_requirements"]),
        _ => without_ignored_metadata(shot, &["script_meta"]),
    };
    digest(&json!([stage, selected, config, sources]))
}

/// Removes annotation-only metadata before hashing. If rendering later consumes a field such as
/// transition or camera movement, expose it through render_hints or include it in the hash here.
fn without_ignored_metadata(value: &Value, ignored: &[&str]) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        for key in ignored {
            object.remove(*key);
        }
    }
    value
}

/// `script_source.route` (template or organized) affects rendering only with per-shot `render_hints`,
/// which remains hashed. If the route can independently affect rendering, include it in this hash.
fn without_plan_annotation_metadata(value: &Value) -> Value {
    let mut value = without_ignored_metadata(value, &["task_revision", "script_source"]);
    if let Some(shots) = value.get_mut("shots").and_then(Value::as_array_mut) {
        for shot in shots {
            if let Some(object) = shot.as_object_mut() {
                object.remove("script_meta");
            }
        }
    }
    value
}

fn aggregate_digest(stage: &str, plan: &Value, config: &Value, inputs: &Value) -> String {
    digest(&json!([
        "render-contract-2-narration-captions",
        "packaging-template-1",
        stage,
        without_plan_annotation_metadata(plan),
        config,
        inputs
    ]))
}

impl Journal {
    pub(crate) fn ensure_stages(job: &mut JobPlan) {
        if !job
            .steps
            .iter()
            .any(|step| step.capability == CapabilityId::ClipSegments)
        {
            return;
        }
        for capability in [
            CapabilityId::OptimizeQueries,
            CapabilityId::DownloadAssets,
            CapabilityId::PrepareVoice,
        ] {
            if job.steps.iter().any(|step| step.capability == capability) {
                continue;
            }
            let before = job
                .steps
                .iter()
                .position(|step| match capability {
                    CapabilityId::OptimizeQueries => [
                        CapabilityId::DownloadAssets,
                        CapabilityId::PrepareVoice,
                        CapabilityId::ClipSegments,
                    ]
                    .contains(&step.capability),
                    CapabilityId::DownloadAssets => {
                        [CapabilityId::PrepareVoice, CapabilityId::ClipSegments]
                            .contains(&step.capability)
                    }
                    _ => step.capability == CapabilityId::ClipSegments,
                })
                .unwrap();
            job.steps.insert(
                before,
                JobStep {
                    capability,
                    id: None,
                    label: None,
                    inputs: Value::Null,
                    requires_confirmation: false,
                },
            );
        }
    }
    pub(crate) fn bind_final(&mut self, file: Option<PathBuf>) {
        self.final_file = file;
    }
    pub(crate) fn open(root: &Path, resume: bool) -> Result<Self> {
        let root = fs::canonicalize(root)?;
        let mut journal = if resume {
            let saved: Self = serde_json::from_slice(&fs::read(root.join("incremental.json"))?)?;
            if saved.schema_version != 1 {
                bail!("分镜续跑记录版本不支持，请重新生成全部");
            }
            saved
        } else {
            Self {
                schema_version: 1,
                ..Self::default()
            }
        };
        journal.root = root;
        journal.save()?;
        Ok(journal)
    }
    fn save(&self) -> Result<()> {
        write_json_pretty_atomic(&self.root.join("incremental.json"), self)
    }
    fn checked(&self, file: &Path) -> Result<PathBuf> {
        let file = fs::canonicalize(file)?;
        let final_match = self
            .final_file
            .as_ref()
            .and_then(|value| fs::canonicalize(value).ok())
            .as_ref()
            == Some(&file);
        if (!file.starts_with(&self.root) && !final_match)
            || !file.is_file()
            || fs::metadata(&file)?.len() == 0
        {
            bail!("分镜缓存产物不属于当前运行目录或为空");
        }
        Ok(file)
    }
    fn reusable(&self, key: &str, input: &str) -> Option<Receipt> {
        self.records
            .get(key)
            .filter(|saved| {
                saved.input_hash == input
                    && saved.files.iter().all(|(file, hash)| {
                        self.checked(file)
                            .ok()
                            .and_then(|file| hash_file(&file).ok())
                            .as_ref()
                            == Some(hash)
                    })
            })
            .cloned()
    }
    fn voice_output_files(&self, output: &Value, required: bool) -> Result<Vec<PathBuf>> {
        if !required {
            if ["voice_audio", "subtitle_cues_file", "subtitle_cues"]
                .iter()
                .any(|key| output.get(key).is_some())
            {
                bail!("未启用口播的分镜仍包含旧音频或字幕时间轴");
            }
            return Ok(Vec::new());
        }
        let audio = self.checked(Path::new(
            output["voice_audio"].as_str().context("口播缓存缺少音频")?,
        ))?;
        // Match the renderer's minimum usable audio size; otherwise it would
        // generate another voice with a different timeline during composition.
        if fs::metadata(&audio)?.len() <= 1024 {
            bail!("口播缓存音频不完整");
        }
        let cues_file = self.checked(Path::new(
            output["subtitle_cues_file"]
                .as_str()
                .context("口播缓存缺少字幕时间轴文件")?,
        ))?;
        let cues: Value = serde_json::from_slice(&fs::read(&cues_file)?)?;
        let items = cues.as_array().context("口播缓存字幕时间轴格式无效")?;
        if items.is_empty() || cues != output["subtitle_cues"] {
            bail!("口播缓存字幕时间轴为空或与分镜不一致");
        }
        let duration = output["duration"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .context("口播缓存缺少有效时长")?;
        for cue in items {
            let start = cue["start"].as_f64().unwrap_or(f64::NAN);
            let end = cue["end"].as_f64().unwrap_or(f64::NAN);
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end <= start
                || end > duration
                || cue["text"]
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty())
            {
                bail!("口播缓存包含无效字幕片段");
            }
        }
        Ok(vec![audio, cues_file])
    }
    fn reusable_voice(&self, key: &str, input: &str, required: bool) -> Option<Receipt> {
        self.reusable(key, input).filter(|saved| {
            self.voice_output_files(&saved.output, required)
                .is_ok_and(|files| files.iter().all(|file| saved.files.contains_key(file)))
        })
    }
    fn record(
        &mut self,
        key: &str,
        input: String,
        files: Vec<PathBuf>,
        output: Value,
    ) -> Result<()> {
        let mut hashes = BTreeMap::new();
        for file in files {
            let actual = self.checked(&file)?;
            hashes.insert(actual.clone(), hash_file(&actual)?);
        }
        self.records.insert(
            key.into(),
            Receipt {
                input_hash: input,
                files: hashes,
                output,
            },
        );
        self.save()
    }
    fn quarantine_changed_outputs(&self, key: &str) -> Result<()> {
        let Some(saved) = self.records.get(key) else {
            return Ok(());
        };
        for (file, expected) in &saved.files {
            if !file.exists() || hash_file(file).ok().as_ref() == Some(expected) {
                continue;
            }
            let file = fs::canonicalize(file)?;
            if !file.starts_with(&self.root) || !file.is_file() {
                bail!("不能移动当前任务目录外的缓存产物");
            }
            let backup = file.with_file_name(format!(
                "{}.invalid-{}",
                file.file_name().unwrap().to_string_lossy(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            fs::rename(file, backup)?;
        }
        Ok(())
    }
    fn config(&self, stage: &str, config: &RunConfig) -> Value {
        let values = match stage {
            "query" => json!([config.source.label()]),
            "voice" => json!([config.voiceover]),
            "download" => json!([
                config.source.label(),
                config.downloads_per_shot,
                config.download_review,
                config.download_candidate_pool,
                config.download_review_threshold,
                config.min_source_duration,
                config.max_source_duration
            ]),
            "clip" => json!([
                config.clips_per_shot,
                config.results_per_shot,
                config.chunk_duration,
                config.match_accept_threshold
            ]),
            _ => json!(format!("{config:?}")),
        };
        json!([values, settings(stage)])
    }
    fn aggregate_input(&self, stage: &str, plan: &Path, config: &RunConfig) -> Result<String> {
        let value: Value = serde_json::from_slice(&fs::read(plan)?)?;
        let inputs: BTreeMap<_, _> = self
            .records
            .iter()
            .filter(|(key, _)| key.starts_with("clip:") || key.starts_with("voice:"))
            .map(|(key, saved)| (key, (&saved.input_hash, &saved.files)))
            .collect();
        Ok(aggregate_digest(
            stage,
            &value,
            &self.config(stage, config),
            &json!(inputs),
        ))
    }
    pub(crate) fn reuse_final_stage(
        &self,
        stage: &str,
        plan: &Path,
        config: &RunConfig,
    ) -> Result<bool> {
        Ok(self
            .reusable(stage, &self.aggregate_input(stage, plan, config)?)
            .is_some())
    }
    pub(crate) fn complete_final_stage(
        &mut self,
        stage: &str,
        plan: &Path,
        config: &RunConfig,
    ) -> Result<()> {
        let files = self
            .final_file
            .clone()
            .filter(|file| file.is_file())
            .into_iter()
            .collect::<Vec<_>>();
        if files.is_empty() {
            return Ok(());
        }
        self.record(
            stage,
            self.aggregate_input(stage, plan, config)?,
            files,
            Value::Null,
        )?;
        if stage == "bgm" {
            // BGM intentionally replaces the composed file; preserve its verified producer receipt.
            if let Some(composed) = self.records.get("compose").cloned() {
                self.record(
                    "compose",
                    composed.input_hash,
                    composed.files.keys().cloned().collect(),
                    composed.output,
                )?;
            }
        }
        Ok(())
    }
    fn source_items(manifest: Option<&GenerationMaterialManifest>, id: &str) -> Value {
        json!(
            manifest
                .and_then(|value| value.shots.iter().find(|shot| shot.shot_id == id))
                .map(|shot| shot
                    .materials
                    .iter()
                    .map(|item| json!([
                        item.material_id,
                        item.asset_id,
                        item.asset_version,
                        item.source_sha256
                    ]))
                    .collect::<Vec<_>>())
                .unwrap_or_default()
        )
    }
    fn directory(&self, kind: &str, id: &str, input: &str) -> PathBuf {
        self.root.join(kind).join(digest(&json!(id))).join(input)
    }
    fn raw_files(root: &Path) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        for directory in fs::read_dir(root)? {
            let directory = directory?;
            if !directory.file_type()?.is_dir() {
                continue;
            }
            for file in fs::read_dir(directory.path())? {
                let file = file?;
                if file.file_type()?.is_file()
                    && file.path().extension().is_some_and(|extension| {
                        ["mp4", "mov", "mkv", "avi", "webm", "m4v"]
                            .iter()
                            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                    })
                {
                    files.push(file.path());
                }
            }
        }
        if files.is_empty() {
            bail!("此分镜没有有效的素材产物");
        }
        Ok(files)
    }
    fn single_plan(plan: &Value, shot: &Value) -> Value {
        let mut single = plan.clone();
        single["shots"] = json!([shot]);
        single
    }
    fn merge_fields(plan: &mut Value, index: usize, output: &Value, names: &[&str]) {
        for name in names {
            if let Some(value) = output.get(name) {
                plan["shots"][index][*name] = value.clone();
            } else if let Some(shot) = plan["shots"][index].as_object_mut() {
                shot.remove(*name);
            }
        }
    }
    pub(crate) fn prepare(
        &mut self,
        stage: CapabilityId,
        paths: &AppPaths,
        plan_path: &Path,
        config: &RunConfig,
        manifest: Option<&GenerationMaterialManifest>,
        skip_download: bool,
        skip_index: bool,
    ) -> Result<bool> {
        let name = match stage {
            CapabilityId::OptimizeQueries => "query",
            CapabilityId::PrepareVoice => "voice",
            CapabilityId::DownloadAssets => "download",
            CapabilityId::ClipSegments => "clip",
            _ => return Ok(false),
        };
        let mut plan: Value = serde_json::from_slice(&fs::read(plan_path)?)?;
        let stage_config = self.config(name, config);
        let count = plan["shots"].as_array().context("分镜列表无效")?.len();
        let typed: ShotPlan = serde_json::from_value(plan.clone())?;
        let mut clips = if name == "clip" {
            Some(ClipManifest::start(&self.root.join("clips"), &typed)?)
        } else {
            None
        };
        for index in 0..count {
            let shot_json = plan["shots"][index].clone();
            let shot: Shot = serde_json::from_value(shot_json.clone())?;
            let key = format!("{name}:{}", shot.shot_id);
            let sources = Self::source_items(manifest, &shot.shot_id);
            let download_input = shot_input(
                "download",
                &shot_json,
                &self.config("download", config),
                &sources,
            );
            let raw = self.directory("raw", &shot.shot_id, &download_input);
            let clip_sources = self
                .records
                .get(&format!("download:{}", shot.shot_id))
                .map(|record| json!([record.input_hash, record.files.values().collect::<Vec<_>>()]))
                .unwrap_or(Value::Null);
            let input = shot_input(
                name,
                &shot_json,
                &stage_config,
                if name == "download" {
                    &sources
                } else if name == "clip" {
                    &clip_sources
                } else {
                    &Value::Null
                },
            );
            let voice_required = config.voiceover && shot_needs_voice(&shot);
            let saved = if name == "voice" {
                self.reusable_voice(&key, &input, voice_required)
            } else {
                self.reusable(&key, &input)
            };
            if let Some(saved) = saved {
                if let Some(clips) = clips.as_mut() {
                    let ranked: Vec<PathBuf> =
                        serde_json::from_value(saved.output["paths"].clone())
                            .context("剪辑缓存缺少排名清单")?;
                    if ranked.iter().any(|path| !saved.files.contains_key(path)) {
                        bail!("剪辑缓存排名引用了未校验文件");
                    }
                    clips.record(&self.root.join("clips"), &shot, ranked)?;
                }
                if name == "voice" {
                    Self::merge_fields(
                        &mut plan,
                        index,
                        &saved.output,
                        &[
                            "duration",
                            "voice_audio",
                            "subtitle_cues",
                            "subtitle_cues_file",
                        ],
                    );
                    self.map_voice(index, &saved.output)?;
                    write_json_pretty_atomic(plan_path, &plan)?;
                }
                println!("分镜 #{} {}：已校验并复用", index + 1, name);
                crate::emit_workflow_event(
                    crate::workflow_stage_for_capability(stage),
                    "running",
                    "reused",
                    Some(index + 1),
                    Some(count),
                    format!("已复用分镜 {}", index + 1),
                );
                continue;
            }
            println!("分镜 #{} {}：输入变化或产物缺失，重新处理", index + 1, name);
            self.quarantine_changed_outputs(&key)?;
            let workspace = self.directory("incremental-work", &shot.shot_id, &input);
            fs::create_dir_all(&workspace)?;
            let active = workspace.join("shots.json");
            let mut single = Self::single_plan(&plan, &shot_json);
            let mut result_files = Vec::new();
            let mut output: Value;
            match name {
                "query" => {
                    if !self.records.contains_key(&key)
                        && (!shot_needs_download(&shot) || shot.query_optimized == Some(true))
                    {
                        // Preserve the existing first-run policy for explicit library queries and
                        // already optimized plans; future edits must match this recorded baseline.
                        output = shot_json.clone();
                    } else {
                        single["shots"][0]["query_optimized"] = json!(false);
                        write_json_pretty_atomic(&active, &single)?;
                        crate::optimize_queries_with_ai(paths, &active, config)?;
                        output = serde_json::from_slice::<Value>(&fs::read(&active)?)?["shots"][0]
                            .clone();
                        Self::merge_fields(
                            &mut plan,
                            index,
                            &output,
                            &[
                                "download_query",
                                "visual_query",
                                "raw_download_query",
                                "raw_visual_query",
                                "query_optimized",
                            ],
                        );
                    }
                }
                "voice" => {
                    let voice = workspace.join("voice");
                    write_json_pretty_atomic(&active, &single)?;
                    crate::prepare_voice_and_update_plan(
                        paths, &active, &voice, &workspace, config,
                    )?;
                    output =
                        serde_json::from_slice::<Value>(&fs::read(&active)?)?["shots"][0].clone();
                    if !config.voiceover
                        || shot.voiceover == Some(false)
                        || shot.voice_text.as_deref().unwrap_or("").trim().is_empty()
                    {
                        if let Some(object) = output.as_object_mut() {
                            for key in ["voice_audio", "subtitle_cues", "subtitle_cues_file"] {
                                object.remove(key);
                            }
                        }
                    }
                    Self::merge_fields(
                        &mut plan,
                        index,
                        &output,
                        &[
                            "duration",
                            "voice_audio",
                            "subtitle_cues",
                            "subtitle_cues_file",
                        ],
                    );
                    result_files = self.voice_output_files(&output, voice_required)?;
                    self.map_voice(index, &output)?;
                }
                "download" => {
                    fs::create_dir_all(&raw)?;
                    let clip_root = self
                        .root
                        .join("clips")
                        .join("staging")
                        .join(digest(&json!(shot.shot_id)));
                    fs::create_dir_all(&clip_root)?;
                    if !shot_needs_download(&shot) {
                        let one: ShotPlan = serde_json::from_value(single)?;
                        let mut binding = manifest.context("缺少素材范围清单")?.clone();
                        binding.shots.retain(|item| item.shot_id == shot.shot_id);
                        stage_manifest_materials(&raw, &clip_root, &one, &binding)?;
                    } else {
                        crate::config::validate_download_source(&config.source)?;
                        let context = MaterialClipContext {
                            paths,
                            run_raw: &raw,
                            run_clips: &clip_root,
                            config,
                            skip_download,
                            skip_index,
                        };
                        prepare_shot_materials(
                            &context,
                            &shot,
                            MaterialPreparationMode::DownloadOnly,
                            None,
                            |_| {},
                        )?;
                    }
                    result_files = Self::raw_files(&raw)?;
                    // The desktop uses this baseline to avoid re-resolving untouched shots,
                    // including completed Pexels downloads, when only text/order changed.
                    output = shot_json.clone();
                }
                "clip" => {
                    let clip_root = self.directory("clips", &shot.shot_id, &input);
                    fs::create_dir_all(&clip_root)?;
                    let context = MaterialClipContext {
                        paths,
                        run_raw: &raw,
                        run_clips: &clip_root,
                        config,
                        skip_download,
                        skip_index,
                    };
                    prepare_shot_materials(
                        &context,
                        &shot,
                        MaterialPreparationMode::IndexForClip,
                        None,
                        |_| {},
                    )?;
                    // The workspace may rename a shot directory after a title/order edit.
                    // Keep its verified source receipt pointing at the resulting paths.
                    self.record(
                        &format!("download:{}", shot.shot_id),
                        download_input.clone(),
                        Self::raw_files(&raw)?,
                        shot_json.clone(),
                    )?;
                    result_files = create_shot_clips(&context, &shot)?;
                    result_files = result_files
                        .iter()
                        .map(|file| self.checked(file))
                        .collect::<Result<_>>()?;
                    output = json!({"paths": result_files});
                    clips.as_mut().unwrap().record(
                        &self.root.join("clips"),
                        &shot,
                        result_files.clone(),
                    )?;
                }
                _ => unreachable!(),
            }
            write_json_pretty_atomic(plan_path, &plan)?;
            // Query and voice tools write derived fields; save the resulting visual input too.
            let current_input = if name == "query" {
                shot_input(name, &plan["shots"][index], &stage_config, &Value::Null)
            } else {
                input
            };
            self.record(&key, current_input, result_files, output)?;
        }
        if name == "voice" {
            refresh_timeline(&mut plan)?;
            write_json_pretty_atomic(plan_path, &plan)?;
        }
        Ok(true)
    }
    fn map_voice(&self, index: usize, output: &Value) -> Result<()> {
        let root = self.root.join("voice");
        fs::create_dir_all(&root)?;
        for (key, suffix) in [
            ("voice_audio", "voice.mp3"),
            ("subtitle_cues_file", "cues.json"),
        ] {
            let destination = root.join(format!("{:04}_{suffix}", index + 1));
            if let Some(source) = output[key].as_str() {
                fs::copy(self.checked(Path::new(source))?, &destination)?;
            } else if destination.is_file() {
                fs::remove_file(destination)?;
            }
        }
        Ok(())
    }
}

fn refresh_timeline(plan: &mut Value) -> Result<()> {
    let shots = plan["shots"].as_array_mut().context("分镜列表无效")?;
    let mut elapsed = 0u64;
    for (index, shot) in shots.iter_mut().enumerate() {
        let duration = shot["duration"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.ceil() as u64)
            .unwrap_or(4)
            .max(1);
        let end = elapsed
            .checked_add(duration)
            .context("分镜总时长超出范围")?;
        shot["shot"] = json!(index + 1);
        shot["time_range"] = json!(format!(
            "{}:{:02}-{}:{:02}",
            elapsed / 60,
            elapsed % 60,
            end / 60,
            end % 60
        ));
        elapsed = end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> RunConfig {
        RunConfig {
            source: crate::cli::Source::Pexels,
            downloads_per_shot: 2,
            download_review: false,
            download_candidate_pool: 6,
            download_review_threshold: 0.1,
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
            bgm_source: "local".into(),
            bgm_query: None,
            bgm_candidate_pool: 3,
            bgm_min_duration: None,
            bgm_max_duration: None,
            bgm_volume: 0.2,
        }
    }
    fn paths(root: &Path) -> AppPaths {
        AppPaths {
            root: root.into(),
            data_root: root.into(),
            env_path: root.join("unused.env"),
            yt_dlp: root.join("must-not-execute"),
            sentrysearch: root.join("must-not-execute"),
            sentry_py: None,
            ffmpeg: None,
            node: None,
            runs_dir: root.into(),
            archive: root.join("archive"),
        }
    }
    /// 每个测试一个独立临时目录。只用时间戳会撞名：同一进程里并行的测试线程可能拿到同一个
    /// 纳秒值（macOS 时钟只到微秒），两个 `cargo test` 进程并发时也会撞——之前偶发的
    /// `reordered_*` 失败就是两个测试写进了同一个目录。进程号 + 进程内原子计数器 + 时间戳三者合起来唯一。
    fn root() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "vacut-incremental-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn reordered_revision_rebuilds_clip_manifest_by_id_and_preserves_producer_ranking_without_executors()
     {
        let root = root();
        fs::create_dir_all(root.join("clips")).unwrap();
        let config = config();
        let mut journal = Journal::open(&root, false).unwrap();
        let mut plan = json!({"schema_version":2,"task_revision":1,"topic":"demo","shots":[
            {"shot_id":"a","shot":1,"title":"A","visual_query":"robot","download_material":false},
            {"shot_id":"b","shot":2,"title":"B","visual_query":"conveyor","download_material":false}]});
        let mut expected = Vec::new();
        for shot in plan["shots"].as_array().unwrap() {
            let id = shot["shot_id"].as_str().unwrap();
            journal
                .record(
                    &format!("download:{id}"),
                    "same-sources".into(),
                    vec![],
                    Value::Null,
                )
                .unwrap();
            let ranked = [
                root.join("clips").join(format!("{id}-z.mp4")),
                root.join("clips").join(format!("{id}-a.mp4")),
            ];
            for file in &ranked {
                fs::write(file, format!("{id}-{}", file.display())).unwrap();
            }
            let ranked = ranked.map(|file| fs::canonicalize(file).unwrap());
            let input = shot_input(
                "clip",
                shot,
                &journal.config("clip", &config),
                &json!(["same-sources", []]),
            );
            journal
                .record(
                    &format!("clip:{id}"),
                    input,
                    ranked.to_vec(),
                    json!({"paths":ranked}),
                )
                .unwrap();
            expected.push(ranked[0].clone());
        }
        plan["shots"].as_array_mut().unwrap().reverse();
        plan["task_revision"] = json!(9);
        plan["shots"][0]["shot"] = json!(1);
        plan["shots"][1]["shot"] = json!(2);
        let plan_path = root.join("shots.json");
        write_json_pretty_atomic(&plan_path, &plan).unwrap();
        journal
            .prepare(
                CapabilityId::ClipSegments,
                &paths(&root),
                &plan_path,
                &config,
                None,
                false,
                false,
            )
            .unwrap();
        let typed: ShotPlan = serde_json::from_value(plan).unwrap();
        let resolved = crate::clip_manifest::resolve_clips(&root.join("clips"), &typed).unwrap();
        assert_eq!(resolved, vec![expected[1].clone(), expected[0].clone()]);
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changing_one_bound_range_stages_only_that_shot_and_never_contaminates_the_old_candidates() {
        use crate::models::{GenerationManifestItem, GenerationManifestShot};
        let root = root();
        let config = config();
        let mut journal = Journal::open(&root, false).unwrap();
        let source_a = root.join("source-a.mp4");
        let source_b = root.join("source-b.mp4");
        let replacement = root.join("replacement.mp4");
        fs::write(&source_a, "asset-a").unwrap();
        fs::write(&source_b, "asset-b").unwrap();
        fs::write(&replacement, "new-a").unwrap();
        let item = |name: &str, file: &Path| GenerationManifestItem {
            material_id: name.into(),
            asset_id: name.into(),
            asset_version: 1,
            source_sha256: hash_file(file).unwrap(),
            local_path: file.into(),
        };
        let mut manifest = GenerationMaterialManifest {
            schema_version: 1,
            run_id: "run_demo".into(),
            task_id: "task".into(),
            task_revision: 1,
            resolved_at: "now".into(),
            shots: vec![
                GenerationManifestShot {
                    shot_id: "a".into(),
                    materials: vec![item("asset_a", &source_a)],
                },
                GenerationManifestShot {
                    shot_id: "b".into(),
                    materials: vec![item("asset_b", &source_b)],
                },
            ],
        };
        let mut plan = json!({"schema_version":2,"task_revision":1,"topic":"demo","shots":[
            {"shot_id":"a","shot":1,"title":"A","download_material":false,"material_bindings":[{"binding_type":"material","material_id":"asset_a"}]},
            {"shot_id":"b","shot":2,"title":"B","download_material":false,"material_bindings":[{"binding_type":"material","material_id":"asset_b"}]}]});
        let plan_path = root.join("shots.json");
        write_json_pretty_atomic(&plan_path, &plan).unwrap();
        journal
            .prepare(
                CapabilityId::DownloadAssets,
                &paths(&root),
                &plan_path,
                &config,
                Some(&manifest),
                false,
                false,
            )
            .unwrap();
        let a_before = journal.records["download:a"].clone();
        let b_before = journal.records["download:b"].clone();
        // The second run must use B's verified staged result, with no re-access of its source.
        fs::remove_file(&source_b).unwrap();
        plan["task_revision"] = json!(2);
        plan["shots"][0]["material_bindings"][0]["material_id"] = json!("asset_new_a");
        manifest.task_revision = 2;
        manifest.shots[0].materials = vec![item("asset_new_a", &replacement)];
        write_json_pretty_atomic(&plan_path, &plan).unwrap();
        journal
            .prepare(
                CapabilityId::DownloadAssets,
                &paths(&root),
                &plan_path,
                &config,
                Some(&manifest),
                false,
                false,
            )
            .unwrap();
        assert_ne!(
            journal.records["download:a"].input_hash,
            a_before.input_hash
        );
        assert_eq!(
            journal.records["download:b"].input_hash,
            b_before.input_hash
        );
        assert_eq!(journal.records["download:b"].files, b_before.files);
        assert_eq!(journal.records["download:a"].files.len(), 1);
        assert_eq!(
            fs::read(journal.records["download:a"].files.keys().next().unwrap()).unwrap(),
            b"new-a"
        );
        assert!(a_before.files.keys().all(|file| file.is_file()));
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reordered_voice_maps_saved_audio_and_cues_to_the_new_timeline_without_tts() {
        let root = root();
        let config = config();
        let mut journal = Journal::open(&root, false).unwrap();
        let mut plan = json!({"schema_version":2,"task_revision":1,"topic":"demo","shots":[
            {"shot_id":"a","shot":1,"title":"A","voice_text":"alpha","duration":3},
            {"shot_id":"b","shot":2,"title":"B","voice_text":"beta","duration":4}]});
        for shot in plan["shots"].as_array().unwrap() {
            let id = shot["shot_id"].as_str().unwrap();
            let audio = root.join(format!("saved-{id}.mp3"));
            let cues = root.join(format!("saved-{id}.json"));
            fs::write(&audio, id.repeat(2048)).unwrap();
            let timeline = json!([{"text":shot["voice_text"],"start":0.25,"end":2.5}]);
            write_json_pretty_atomic(&cues, &timeline).unwrap();
            let output = json!({"voice_audio":audio,"subtitle_cues_file":cues,"subtitle_cues":timeline,"duration":shot["duration"]});
            journal
                .record(
                    &format!("voice:{id}"),
                    shot_input(
                        "voice",
                        shot,
                        &journal.config("voice", &config),
                        &Value::Null,
                    ),
                    vec![audio, cues],
                    output,
                )
                .unwrap();
        }
        plan["shots"].as_array_mut().unwrap().reverse();
        // A stale display duration must not replace the verified voice duration.
        plan["shots"][0]["duration"] = json!(1);
        let plan_path = root.join("shots.json");
        write_json_pretty_atomic(&plan_path, &plan).unwrap();
        journal
            .prepare(
                CapabilityId::PrepareVoice,
                &paths(&root),
                &plan_path,
                &config,
                None,
                false,
                false,
            )
            .unwrap();
        assert_eq!(
            fs::read(root.join("voice/0001_voice.mp3")).unwrap(),
            b"b".repeat(2048)
        );
        assert_eq!(
            fs::read(root.join("voice/0002_voice.mp3")).unwrap(),
            b"a".repeat(2048)
        );
        let mapped_cues: Value =
            serde_json::from_slice(&fs::read(root.join("voice/0001_cues.json")).unwrap()).unwrap();
        assert_eq!(mapped_cues[0]["text"], "beta");
        fs::remove_file(root.join("voice/0001_voice.mp3")).unwrap();
        journal
            .prepare(
                CapabilityId::PrepareVoice,
                &paths(&root),
                &plan_path,
                &config,
                None,
                false,
                false,
            )
            .unwrap();
        assert_eq!(
            fs::read(root.join("voice/0001_voice.mp3")).unwrap(),
            b"b".repeat(2048)
        );
        let restored: Value = serde_json::from_slice(&fs::read(&plan_path).unwrap()).unwrap();
        assert_eq!(restored["shots"][0]["duration"], 4);
        assert_eq!(restored["shots"][0]["time_range"], "0:00-0:04");
        assert_eq!(restored["shots"][1]["time_range"], "0:04-0:07");
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn voice_receipt_requires_both_hashed_audio_and_matching_valid_cues() {
        let root = root();
        let mut journal = Journal::open(&root, false).unwrap();
        let audio = root.join("saved.mp3");
        let cues_file = root.join("saved.json");
        fs::write(&audio, vec![1u8; 2048]).unwrap();
        let cues = json!([{"text":"spoken words","start":0.1,"end":2.8}]);
        write_json_pretty_atomic(&cues_file, &cues).unwrap();
        let output = json!({"voice_audio":audio,"subtitle_cues_file":cues_file,"subtitle_cues":cues,"duration":3});
        journal
            .record(
                "voice:a",
                "input".into(),
                vec![audio.clone(), cues_file.clone()],
                output.clone(),
            )
            .unwrap();
        let good = journal.records["voice:a"].clone();
        assert!(journal.reusable_voice("voice:a", "input", true).is_some());

        // This is the released regression: the receipt kept only cues and
        // incorrectly claimed that preparation had produced reusable audio.
        let mut legacy = good.clone();
        legacy.output.as_object_mut().unwrap().remove("voice_audio");
        legacy.files.remove(&fs::canonicalize(&audio).unwrap());
        journal.records.insert("voice:a".into(), legacy);
        journal.save().unwrap();
        assert!(
            Journal::open(&root, true)
                .unwrap()
                .reusable_voice("voice:a", "input", true)
                .is_none()
        );

        let mut unverified = good.clone();
        unverified.files.remove(&fs::canonicalize(&audio).unwrap());
        journal.records.insert("voice:a".into(), unverified);
        assert!(journal.reusable_voice("voice:a", "input", true).is_none());
        let mut mismatched = good.clone();
        mismatched.output["subtitle_cues"][0]["text"] = json!("different voice");
        journal.records.insert("voice:a".into(), mismatched);
        assert!(journal.reusable_voice("voice:a", "input", true).is_none());
        journal.records.insert("voice:a".into(), good.clone());
        fs::write(&audio, vec![2u8; 2048]).unwrap();
        assert!(journal.reusable_voice("voice:a", "input", true).is_none());
        fs::write(&audio, vec![1u8; 2048]).unwrap();
        fs::remove_file(&cues_file).unwrap();
        assert!(journal.reusable_voice("voice:a", "input", true).is_none());

        // Even a newly recorded pair must have a real timeline, not merely
        // nonempty files whose hashes happen to agree.
        for bad_cues in [
            json!([]),
            json!([{"text":"spoken words","start":2,"end":1}]),
            json!([{"text":"spoken words","start":0,"end":5}]),
        ] {
            write_json_pretty_atomic(&cues_file, &bad_cues).unwrap();
            let mut invalid = output.clone();
            invalid["subtitle_cues"] = bad_cues;
            journal
                .record(
                    "voice:a",
                    "input".into(),
                    vec![audio.clone(), cues_file.clone()],
                    invalid,
                )
                .unwrap();
            assert!(journal.reusable_voice("voice:a", "input", true).is_none());
        }
        write_json_pretty_atomic(&cues_file, &cues).unwrap();
        fs::write(&audio, vec![1u8; 512]).unwrap();
        journal
            .record("voice:a", "input".into(), vec![audio, cues_file], output)
            .unwrap();
        assert!(journal.reusable_voice("voice:a", "input", true).is_none());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn silent_shot_can_reuse_an_empty_voice_receipt_but_not_stale_audio() {
        let root = root();
        let mut journal = Journal::open(&root, false).unwrap();
        journal
            .record(
                "voice:silent",
                "input".into(),
                vec![],
                json!({"duration":4}),
            )
            .unwrap();
        assert!(
            journal
                .reusable_voice("voice:silent", "input", false)
                .is_some()
        );
        assert!(
            journal
                .reusable_voice("voice:silent", "input", true)
                .is_none()
        );
        journal.records.get_mut("voice:silent").unwrap().output["voice_audio"] = json!("stale.mp3");
        assert!(
            journal
                .reusable_voice("voice:silent", "input", false)
                .is_none()
        );
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn voice_settings_include_the_actual_synthesizer_without_invalidating_visual_stages() {
        for key in [
            "DASHSCOPE_TTS_VOICE",
            "DASHSCOPE_TTS_VOICE_TEMPLATE",
            "DASHSCOPE_TTS_VOICE_ID",
            "DASHSCOPE_TTS_MODEL",
            "DASHSCOPE_TTS_FORMAT",
            "DASHSCOPE_TTS_SAMPLE_RATE",
            "DASHSCOPE_TTS_URL",
            "DASHSCOPE_TEXT_MODEL",
            "DASHSCOPE_BASE_URL",
        ] {
            assert!(
                is_stage_setting("voice", key),
                "missing voice setting {key}"
            );
            assert!(
                !is_stage_setting("clip", key),
                "voice change must not repeat clipping: {key}"
            );
            assert!(
                !is_stage_setting("download", key),
                "voice change must not repeat material preparation: {key}"
            );
        }
        assert!(!is_stage_setting("voice", "DASHSCOPE_API_KEY"));
        assert!(!is_stage_setting("voice", "DASHSCOPE_TTS_TOKEN"));
        for key in [
            "MATERIAL_EXCLUDE_OVERLAYS",
            "MATERIAL_RANDOM_BOUND_FALLBACK",
        ] {
            assert!(is_stage_setting("clip", key));
            assert!(!is_stage_setting("download", key));
        }
    }
    #[test]
    fn stage_dependencies_do_not_recompute_visual_matches_for_text_or_order_edits() {
        let original = json!({"shot_id":"one", "shot":1, "title":"title", "voice_text":"old", "subtitle":"old", "visual_query":"robot", "download_query":"CNC", "download_material":false, "material_bindings":["folder-a"]});
        let mut text = original.clone();
        text["voice_text"] = json!("new");
        text["subtitle"] = json!("new");
        text["shot"] = json!(9);
        text["title"] = json!("new title");
        for stage in ["query", "download", "clip"] {
            assert_eq!(
                shot_input(stage, &original, &Value::Null, &Value::Null),
                shot_input(stage, &text, &Value::Null, &Value::Null)
            );
        }
        assert_ne!(
            shot_input("voice", &original, &Value::Null, &Value::Null),
            shot_input("voice", &text, &Value::Null, &Value::Null)
        );
        let mut visual = original.clone();
        visual["visual_query"] = json!("conveyor");
        for stage in ["query", "clip"] {
            assert_ne!(
                shot_input(stage, &original, &Value::Null, &Value::Null),
                shot_input(stage, &visual, &Value::Null, &Value::Null)
            );
        }
        assert_eq!(
            shot_input("voice", &original, &Value::Null, &Value::Null),
            shot_input("voice", &visual, &Value::Null, &Value::Null)
        );
        let mut bound = original.clone();
        bound["material_bindings"] = json!(["folder-b"]);
        assert_ne!(
            shot_input("download", &original, &Value::Null, &Value::Null),
            shot_input("download", &bound, &Value::Null, &Value::Null)
        );
        assert_ne!(
            shot_input(
                "clip",
                &original,
                &json!({"watermarks":false}),
                &Value::Null
            ),
            shot_input("clip", &original, &json!({"watermarks":true}), &Value::Null)
        );
    }
    #[test]
    fn annotation_metadata_is_ignored_only_at_its_defined_levels() {
        let original = json!({"shot":1,"title":"one","subtitle":"old","card_content":"card"});
        for stage in ["query", "voice", "download", "clip", "render"] {
            let mut annotated = original.clone();
            annotated["script_meta"] = json!({"review":{"confirmed":true}});
            let first = shot_input(stage, &annotated, &Value::Null, &Value::Null);
            annotated["script_meta"] = json!({"review":{"confirmed":false,"warnings":["w"]}});
            assert_eq!(
                first,
                shot_input(stage, &annotated, &Value::Null, &Value::Null),
                "{stage}"
            );
            assert_eq!(
                shot_input(stage, &original, &Value::Null, &Value::Null),
                first,
                "{stage}"
            );
        }
        for (key, value) in [
            ("render_hints", json!({"caption_source":"subtitle"})),
            ("subtitle", json!("new")),
            ("card_content", json!("new card")),
            ("card_layout", json!("headline_sub")),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            assert_ne!(
                shot_input("render", &original, &Value::Null, &Value::Null),
                shot_input("render", &changed, &Value::Null, &Value::Null),
                "{key}"
            );
        }
        assert_eq!(
            shot_input("render", &original, &Value::Null, &Value::Null),
            digest(&json!(["render", original, Value::Null, Value::Null]))
        );
        assert_eq!(
            shot_input("render", &original, &Value::Null, &Value::Null),
            "6e8199ed9d0c7a5e5327cc486417a7be821172046ee0ff5b0466821e8ff0f55d",
            "a29d74f old-plan shot_input hash"
        );

        let plan = json!({"task_revision":3,"script_source":{"x":1},"business":{"script_meta":1},
            "shots":[{"shot":1,"script_meta":{"x":1},"nested":{"script_meta":2}}]});
        assert_eq!(
            without_plan_annotation_metadata(&plan),
            json!({"business":{"script_meta":1},"shots":[{"shot":1,"nested":{"script_meta":2}}]})
        );
        let plain = json!({"topic":"t","shots":[{"shot":1,"title":"one"}]});
        let mut annotated_plan = plain.clone();
        annotated_plan["script_source"] = json!({"template":"VAC-SB-1"});
        annotated_plan["shots"][0]["script_meta"] = json!({"review":["w"]});
        assert_eq!(
            aggregate_digest("compose", &plain, &Value::Null, &Value::Null),
            aggregate_digest("compose", &annotated_plan, &Value::Null, &Value::Null)
        );
        assert_eq!(
            aggregate_digest("compose", &plain, &Value::Null, &Value::Null),
            digest(&json!([
                "render-contract-2-narration-captions",
                "packaging-template-1",
                "compose",
                plain,
                Value::Null,
                Value::Null
            ]))
        );
        assert_eq!(
            aggregate_digest("compose", &plain, &Value::Null, &Value::Null),
            "434b7cb594b3aaa3f826b26d2b5bfd1a21dcfb1de0730d39480a194d90c128ea",
            "a29d74f old-plan aggregate_input hash"
        );
        assert_eq!(
            aggregate_digest("compose", &annotated_plan, &Value::Null, &Value::Null),
            "434b7cb594b3aaa3f826b26d2b5bfd1a21dcfb1de0730d39480a194d90c128ea",
            "a29d74f template-plan aggregate_input hash"
        );
        let mut rendered = plain.clone();
        rendered["shots"][0]["render_hints"] = json!({"caption_source":"subtitle"});
        assert_ne!(
            aggregate_digest("compose", &plain, &Value::Null, &Value::Null),
            aggregate_digest("compose", &rendered, &Value::Null, &Value::Null)
        );
    }
    #[test]
    fn receipts_verify_each_shot_and_reject_missing_corrupt_or_foreign_outputs() {
        let root = root();
        let mut journal = Journal::open(&root, false).unwrap();
        let a = root.join("a.mp4");
        let b = root.join("b.mp4");
        fs::write(&a, "one").unwrap();
        fs::write(&b, "two").unwrap();
        journal
            .record("clip:a", "a".into(), vec![a.clone()], Value::Null)
            .unwrap();
        journal
            .record("clip:b", "b".into(), vec![b.clone()], Value::Null)
            .unwrap();
        let restored = Journal::open(&root, true).unwrap();
        assert!(restored.reusable("clip:a", "a").is_some());
        fs::write(&a, "bad").unwrap();
        assert!(restored.reusable("clip:a", "a").is_none());
        assert!(restored.reusable("clip:b", "b").is_some());
        fs::remove_file(&b).unwrap();
        assert!(restored.reusable("clip:b", "b").is_none());
        assert!(
            journal
                .record(
                    "foreign",
                    "x".into(),
                    vec![PathBuf::from(file!())],
                    Value::Null
                )
                .is_err()
        );
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
