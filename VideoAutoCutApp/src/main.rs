mod output_format;
use anyhow::{Context, Result, anyhow, bail};
use chrono::Local;
use clap::Parser;
use serde_json::json;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

mod bgm;
mod candidate;
mod checkpoint;
mod cli;
mod clip_manifest;
mod config;
mod domain;
mod final_video;
mod incremental;
mod logging;
mod material_clip;
mod material_download;
mod material_review;
mod models;
mod normalization_cache;
mod paths;
mod persistence;
mod planner;
mod process;
mod remote_config;
mod script;
mod video_encoder;

use bgm::{BgmContext, prepare_and_mix_bgm};
use cli::{Cli, Commands};
use config::{
    config_from_env_and_cli, ensure_api_key_file, prompt_source, validate_download_source,
};
use domain::{plan_needs_bgm, shot_needs_download, shot_visual_mode};
use final_video::{FinalVideoContext, concat_final_video};
use logging::{clear_last_error_file, init_run_log, log_line, pause_before_exit, write_last_error};
use material_clip::{
    MaterialClipContext, MaterialClipProgress, MaterialClipProgressEvent, MaterialPreparationMode,
    clean_missing_material_index, create_shot_clips, prepare_shot_materials,
    stage_manifest_materials, validate_material_contract,
};
use models::{
    AppPaths, CapabilityId, GenerationMaterialManifest, JobPlan, JobStep, RunConfig, Shot, ShotPlan,
};
use paths::add_child_env;
use persistence::write_json_pretty_atomic;
use planner::{default_video_job_plan, read_job_plan, write_job_plan};
use process::run_command;
use script::{discover_script_file, read_plan_from_file, read_plan_from_script_ai};

fn emit_workflow_stage(stage: &str) {
    emit_workflow_event(stage, "running", "stage", None, None, "");
}

fn emit_workflow_done() {
    println!(
        "VACUT_EVENT:{}",
        json!({
            "kind": "workflow",
            "version": 1,
            "workflowStage": "done",
            "workflowStatus": "completed",
        })
    );
}

fn emit_workflow_event(
    stage: &str,
    status: &str,
    phase: &str,
    current: Option<usize>,
    total: Option<usize>,
    label: impl Into<String>,
) {
    let label = label.into();
    println!(
        "VACUT_EVENT:{}",
        json!({
            "kind": "workflow",
            "version": 1,
            "workflowStage": stage,
            "workflowStatus": status,
            "workflowProgress": {
                "stage": stage,
                "status": status,
                "phase": phase,
                "current": current,
                "total": total,
                "label": label,
            },
        })
    );
}

fn bgm_failure_message(final_file: &Path) -> String {
    if final_file.is_file() {
        "背景音乐处理失败，已保留无背景音乐成片".to_string()
    } else {
        format!(
            "背景音乐处理失败，原成片未能恢复到输出路径: {}",
            final_file.display()
        )
    }
}

#[derive(Clone, Copy)]
struct WorkflowProgressContext {
    stage: &'static str,
    current: usize,
    total: usize,
}

impl WorkflowProgressContext {
    fn emit(self, phase: &'static str, label: impl Into<String>) {
        emit_workflow_event(
            self.stage,
            "running",
            phase,
            Some(self.current),
            Some(self.total),
            label,
        );
    }

    fn emit_done(self, label: impl Into<String>) {
        emit_workflow_event(
            self.stage,
            "running",
            "completed_item",
            Some(self.current + 1),
            Some(self.total),
            label,
        );
    }

    fn emit_material_event(self, event: MaterialClipProgressEvent) {
        emit_workflow_event(
            self.stage,
            "running",
            event.phase,
            Some(event.current),
            Some(event.total),
            event.label,
        );
    }
}

fn emit_workflow_plan(stages: &[&str]) {
    println!(
        "VACUT_EVENT:{}",
        json!({
            "kind": "workflow_plan",
            "workflowPlan": {
                "stages": stages,
            },
        })
    );
}

fn workflow_stage_for_capability(capability: CapabilityId) -> &'static str {
    match capability {
        CapabilityId::ParseScript => "script",
        CapabilityId::PlanStoryboard => "plan",
        CapabilityId::OptimizeQueries => "query",
        CapabilityId::PrepareVoice => "voice",
        CapabilityId::DownloadAssets
        | CapabilityId::ReviewAssets
        | CapabilityId::SelectLocalMaterials
        | CapabilityId::IndexMaterials => "material",
        CapabilityId::GenerateCards => "card",
        CapabilityId::ClipSegments => "clip",
        CapabilityId::ComposeVideo => "compose",
        CapabilityId::PrepareBgm => "bgm",
    }
}

fn workflow_plan_from_steps(steps: &[JobStep]) -> Vec<&'static str> {
    let mut plan = Vec::new();
    for step in steps {
        let stage = workflow_stage_for_capability(step.capability);
        if !plan.contains(&stage) {
            plan.push(stage);
        }
    }
    plan
}

fn capability_label(step: &JobStep) -> String {
    step.label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{:?}", step.capability))
}

fn print_job_steps(plan: &JobPlan) {
    println!("\n========== 任务步骤 ==========");
    for (index, step) in plan.steps.iter().enumerate() {
        println!(
            "#{:02} {} ({:?})",
            index + 1,
            capability_label(step),
            step.capability
        );
    }
    println!("============================\n");
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let message = format!("程序崩溃: {}", info);
        eprintln!("{}", message);
        log_line(&message);
        write_last_error(&message).ok();
    }));

    if let Err(err) = run_app() {
        let message = format!("{:#}", err);
        eprintln!("\n错误: {}", message);
        log_line(format!("错误: {}", message));
        write_last_error(&message).ok();
        pause_before_exit();
        std::process::exit(1);
    }

    log_line("程序正常结束");
    pause_before_exit();
}

fn run_app() -> Result<()> {
    let mut cli = Cli::parse();

    let paths = AppPaths::discover()?;
    clear_last_error_file(&paths.data_root);

    if let Some(Commands::CleanMissing) = cli.command {
        clean_missing_material_index(&paths)?;
        return Ok(());
    }

    ensure_api_key_file(&paths.env_path)?;

    let auto_script_mode =
        cli.topic.is_none() && cli.shots_json.is_none() && cli.script_file.is_none();

    if auto_script_mode {
        let script_path = match discover_script_file(&paths.data_root)? {
            Some(path) => Some(path),
            None if paths.root != paths.data_root => discover_script_file(&paths.root)?,
            None => None,
        };
        if let Some(script_path) = script_path {
            println!("自动使用脚本文档: {}", script_path.display());
            cli.script_file = Some(script_path);
        }
    }

    let topic = if let Some(script_path) = cli.script_file.as_ref() {
        script_path
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("脚本文档")
            .to_string()
    } else if let Some(t) = cli.topic.clone() {
        t
    } else if cli.shots_json.is_some() {
        "JSON分镜".to_string()
    } else {
        bail!("没有找到脚本文档。请把脚本文档放到程序目录，或使用 --script-file 指定。")
    };

    if topic.trim().is_empty() {
        bail!("主题不能为空");
    }

    let mut config = config_from_env_and_cli(&cli)?;

    if cli.source.is_none()
        && env::var("SOURCE").is_err()
        && (auto_script_mode
            || (cli.topic.is_none() && cli.shots_json.is_none() && cli.script_file.is_none()))
    {
        config.source = prompt_source(config.source.clone())?;
    }

    let material_manifest = if let Some(manifest_path) = cli.material_manifest.as_ref() {
        let text = fs::read_to_string(manifest_path).with_context(|| {
            format!(
                "failed to read material manifest: {}",
                manifest_path.display()
            )
        })?;
        Some(
            serde_json::from_str::<GenerationMaterialManifest>(&text).with_context(|| {
                format!(
                    "invalid material manifest JSON: {}",
                    manifest_path.display()
                )
            })?,
        )
    } else {
        None
    };

    let resume_dir = cli.resume_run.as_ref().map(fs::canonicalize).transpose()?;
    if let Some(dir) = &resume_dir {
        if !dir.starts_with(fs::canonicalize(&paths.runs_dir)?)
            || !dir.join("checkpoint.json").is_file()
        {
            bail!("此任务没有可用检查点，请选择重新生成全部");
        }
        if cli.shots_json.as_ref().map(fs::canonicalize).transpose()?
            != Some(fs::canonicalize(dir.join("shots.json"))?)
        {
            bail!("断点续跑必须使用原任务的分镜文件");
        }
    }
    let workspace = create_run_workspace(
        &paths.runs_dir,
        resume_dir
            .as_ref()
            .and_then(|dir| dir.file_name())
            .and_then(OsStr::to_str)
            .or_else(|| {
                material_manifest
                    .as_ref()
                    .map(|manifest| manifest.run_id.as_str())
            }),
        cli.project_name.as_deref().unwrap_or(&topic),
        cli.shots_json.as_deref(),
    )?;
    let run_id = workspace.run_id;
    let run_dir = fs::canonicalize(&workspace.run_dir)?;
    let output_format = output_format::configure(
        cli.aspect_ratio.as_deref(),
        cli.output_resolution.as_deref(),
        cli.shots_json.as_deref(),
        &run_dir,
        resume_dir.is_some(),
    )?;
    let project_name = workspace.project_name;
    fs::create_dir_all(&workspace.final_dir)?;
    let project_final_dir = fs::canonicalize(&workspace.final_dir)?;
    if let Some(expected) = &resume_dir {
        if fs::canonicalize(&run_dir)? != *expected {
            bail!("断点运行目录不匹配");
        }
    }
    if cli.restart_all && run_dir.join("shots.json").exists() {
        bail!("重新生成全部需要新的运行编号，原结果已保留");
    }
    let run_raw = if cli.restart_all || run_dir.join("raw").exists() {
        run_dir.join("raw")
    } else {
        fs::canonicalize(&workspace.material_dir)?
    };
    let run_clips = run_dir.join("clips");
    let run_norm = run_dir.join("normalized");
    let run_voice = run_dir.join("voice");
    let run_temp = run_dir.join("temp");
    let run_bgm = run_dir.join("bgm");
    let run_final_clips = run_dir.join("final_clips");

    for dir in [
        &run_raw,
        &run_clips,
        &run_norm,
        &run_voice,
        &run_temp,
        &run_bgm,
        &run_final_clips,
    ] {
        fs::create_dir_all(dir)?;
    }

    if let Err(err) = init_run_log(&paths.data_root, &run_dir) {
        eprintln!("[警告] 初始化运行日志失败: {err:#}");
    }
    log_line(format!("运行目录: {}", run_dir.display()));

    println!("\n========== VideoAuto ==========");
    println!("主题: {}", topic);
    println!("运行目录: {}", run_dir.display());
    if let Some(script_path) = cli.script_file.as_ref() {
        println!("脚本文档: {}", script_path.display());
    }
    println!("素材来源: {}", config.source.label());
    println!("每分镜下载: {}", config.downloads_per_shot);
    println!("每分镜剪出: {}", config.clips_per_shot);
    println!("匹配接受阈值: {:.2}", config.match_accept_threshold);
    println!("================================\n");

    let mut initial_plan = if let Some(script_path) = cli.script_file.as_ref() {
        read_plan_from_script_ai(
            &paths,
            script_path,
            &topic,
            cli.voice_script_body.as_deref(),
        )
        .with_context(|| script_parse_error(script_path))?
    } else if let Some(json_path) = cli.shots_json.as_ref() {
        read_plan_from_file(json_path)?
    } else {
        bail!("当前版本已改为脚本文档/JSON 脚本流程，不再根据主题自动生成分镜。")
    };
    println!("{}", shot_count_message(&initial_plan));

    if cli.restart_all {
        for shot in &mut initial_plan.shots {
            shot.query_optimized = None;
        }
    }
    let use_incremental =
        !cli.plan_only && (resume_dir.is_none() || run_dir.join("incremental.json").is_file());
    validate_material_contract(&initial_plan, material_manifest.as_ref(), !cli.plan_only)?;
    if let Some(manifest) = material_manifest.as_ref() {
        if resume_dir.is_none() && !use_incremental {
            stage_manifest_materials(&run_raw, &run_clips, &initial_plan, manifest)?;
        }
        write_json_pretty_atomic(&run_dir.join("material_manifest.json"), manifest)?;
    }

    let plan_path = run_dir.join("shots.json");
    if resume_dir.is_none() {
        write_json_pretty_atomic(&plan_path, &initial_plan)?;
    }

    let job_plan_path = run_dir.join("job_plan.json");
    let mut job_plan = if cli.plan_only {
        let plan = JobPlan::storyboard_only("plan only requested");
        write_job_plan(&job_plan_path, &plan)?;
        plan
    } else if let Some(external_job_plan_path) = cli.job_plan_json.as_ref() {
        let plan = read_job_plan(external_job_plan_path).with_context(|| {
            format!("读取外部任务计划失败: {}", external_job_plan_path.display())
        })?;
        write_job_plan(&job_plan_path, &plan)?;
        plan
    } else if resume_dir.is_some() && !use_incremental {
        read_job_plan(&job_plan_path)?
    } else {
        let plan = default_video_job_plan(&initial_plan, &config)?;
        write_job_plan(&job_plan_path, &plan)?;
        plan
    };
    if use_incremental {
        incremental::Journal::ensure_stages(&mut job_plan);
        write_job_plan(&job_plan_path, &job_plan)?;
    }
    let checkpoint_path = run_dir.join("checkpoint.json");
    let signature = format!(
        "{:?}|{}|{}|{}|{}",
        config,
        serde_json::to_string(&job_plan)?,
        cli.skip_download,
        cli.skip_index,
        cli.skip_concat
    );
    let settings = env::vars()
        .filter(|(key, _)| {
            (key.starts_with("VIDEOAUTO_")
                || key.starts_with("DASHSCOPE_")
                || key.starts_with("QWEN_")
                || key.starts_with("TTS_")
                || key.starts_with("ASR_")
                || key.starts_with("VOICE_")
                || key.starts_with("SUBTITLE_")
                || key.starts_with("BGM_")
                || key.starts_with("MATERIAL_"))
                && !["KEY", "TOKEN", "SECRET", "ROOT"]
                    .iter()
                    .any(|part| key.contains(part))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let signature = format!(
        "{}|{}|{}",
        signature,
        serde_json::to_string(&material_manifest)?,
        serde_json::to_string(&settings)?
    );
    let checkpoint_open = if use_incremental {
        checkpoint::Checkpoint::open_incremental
    } else {
        checkpoint::Checkpoint::open
    };
    let mut checkpoint = checkpoint_open(
        &checkpoint_path,
        &signature,
        &plan_path,
        resume_dir.is_some(),
    )?;
    checkpoint.bind_output_dimensions(
        output_format.width,
        output_format.height,
        resume_dir.is_some(),
    )?;
    let final_file = checkpoint.final_path.clone().or_else(|| {
        job_plan
            .steps
            .iter()
            .any(|step| step.capability == CapabilityId::ComposeVideo)
            .then(|| next_project_final_path(&project_final_dir, &project_name))
    });
    if let Some(file) = &final_file {
        if file.parent() != Some(project_final_dir.as_path()) {
            bail!("检查点成片路径超出当前项目");
        }
    }
    checkpoint.final_path = final_file.clone();
    let mut incremental = if use_incremental {
        Some(incremental::Journal::open(&run_dir, resume_dir.is_some())?)
    } else {
        None
    };
    if let Some(journal) = incremental.as_mut() {
        journal.bind_final(final_file.clone());
    }

    if let Some(reason) = job_plan
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        println!("任务编排说明: {}", reason);
    }
    if let Some(confidence) = job_plan.confidence {
        println!("任务编排置信度: {:.2}", confidence);
    }

    print_job_steps(&job_plan);
    let workflow_plan = workflow_plan_from_steps(&job_plan.steps);
    emit_workflow_plan(&workflow_plan);
    println!("已生成分镜: {}", plan_path.display());

    let mut plan = initial_plan;
    let material_context = MaterialClipContext {
        paths: &paths,
        run_raw: &run_raw,
        run_clips: &run_clips,
        config: &config,
        skip_download: cli.skip_download,
        skip_index: cli.skip_index,
    };

    let mut artifact_roots = vec![
        run_raw.clone(),
        run_clips.clone(),
        run_voice.clone(),
        run_norm.clone(),
        run_bgm.clone(),
        run_final_clips.clone(),
    ];
    if let Some(file) = &final_file {
        artifact_roots.push(file.clone());
    }
    let step_names = job_plan
        .steps
        .iter()
        .map(|step| format!("{:?}", step.capability))
        .collect::<Vec<_>>();
    let resume_at = if resume_dir.is_some() && !use_incremental {
        checkpoint.valid_prefix(&step_names, &artifact_roots)?
    } else {
        0
    };
    if resume_dir.is_some() && !use_incremental {
        println!(
            "断点校验完成：复用 {} 个已完成步骤，从第 {} 步继续",
            resume_at,
            resume_at + 1
        );
    }
    for (step_index, step) in job_plan.steps.iter().enumerate() {
        if step_index < resume_at {
            emit_workflow_event(
                workflow_stage_for_capability(step.capability),
                "completed",
                "reused",
                Some(1),
                Some(1),
                "已校验并复用原有结果",
            );
            continue;
        }
        if step.requires_confirmation {
            bail!(
                "步骤 {} 需要用户确认，但当前执行器没有收到确认令牌",
                capability_label(step)
            );
        }

        let workflow_stage = workflow_stage_for_capability(step.capability);
        emit_workflow_stage(workflow_stage);
        println!(
            "\n>>> 执行能力步骤 #{:02}: {} ({:?})",
            step_index + 1,
            capability_label(step),
            step.capability
        );

        let step_result: Result<()> = (|| {
            if let Some(journal) = incremental.as_mut() {
                if journal.prepare(
                    step.capability,
                    &paths,
                    &plan_path,
                    &config,
                    material_manifest.as_ref(),
                    cli.skip_download,
                    cli.skip_index,
                )? {
                    plan = read_plan_from_file(&plan_path)?;
                    return Ok(());
                }
                let final_stage = match step.capability {
                    CapabilityId::ComposeVideo => Some("compose"),
                    CapabilityId::PrepareBgm => Some("bgm"),
                    _ => None,
                };
                if let Some(name) = final_stage {
                    if journal.reuse_final_stage(name, &plan_path, &config)? {
                        emit_workflow_event(
                            workflow_stage,
                            "completed",
                            "reused",
                            Some(1),
                            Some(1),
                            "已校验并复用原有结果",
                        );
                        return Ok(());
                    }
                }
            }
            match step.capability {
                CapabilityId::ParseScript => {
                    println!("脚本文档已解析: {}", plan_path.display());
                }
                CapabilityId::PlanStoryboard => {
                    print_plan(&plan);
                }
                CapabilityId::OptimizeQueries => {
                    let active_plan = run_temp.join("active_shots.json");
                    fs::copy(&plan_path, &active_plan)?;
                    optimize_queries_with_ai(&paths, &active_plan, &config)?;
                    plan = read_plan_from_file(&active_plan)?;
                    write_json_pretty_atomic(
                        &plan_path,
                        &serde_json::from_slice::<serde_json::Value>(&fs::read(&active_plan)?)?,
                    )?;
                    println!("分镜计划已更新: {}", plan_path.display());
                    print_plan(&plan);
                }
                CapabilityId::PrepareVoice => {
                    let active_plan = run_temp.join("active_shots.json");
                    fs::copy(&plan_path, &active_plan)?;
                    prepare_voice_and_update_plan(
                        &paths,
                        &active_plan,
                        &run_voice,
                        &run_temp,
                        &config,
                    )?;
                    plan = read_plan_from_file(&active_plan)?;
                    write_json_pretty_atomic(
                        &plan_path,
                        &serde_json::from_slice::<serde_json::Value>(&fs::read(&active_plan)?)?,
                    )?;
                }
                CapabilityId::GenerateCards => {
                    // 暂时保留协议能力，任务计划当前会在校验阶段过滤该步骤。
                }
                CapabilityId::DownloadAssets => {
                    if plan.shots.iter().any(shot_needs_download) {
                        validate_download_source(&config.source)?;
                    }
                    let download_shots: Vec<&Shot> = plan
                        .shots
                        .iter()
                        .filter(|shot| shot_needs_download(shot))
                        .collect();
                    let total = download_shots.len().max(1);
                    emit_workflow_event(
                        "material",
                        "running",
                        "preparing",
                        Some(0),
                        Some(total),
                        "准备下载候选素材",
                    );

                    for (index, shot) in download_shots.into_iter().enumerate() {
                        let progress = WorkflowProgressContext {
                            stage: "material",
                            current: index,
                            total,
                        };
                        progress.emit("searching", format!("搜索候选素材 {}/{}", index + 1, total));
                        prepare_shot_materials(
                            &material_context,
                            shot,
                            MaterialPreparationMode::DownloadOnly,
                            Some(MaterialClipProgress {
                                current: progress.current,
                                total: progress.total,
                            }),
                            |event| progress.emit_material_event(event),
                        )?;
                        progress.emit_done(format!("已处理素材 {}/{}", index + 1, total));
                    }
                }
                CapabilityId::ClipSegments => {
                    let mut clip_manifest = clip_manifest::ClipManifest::start(&run_clips, &plan)?;
                    let total = plan.shots.len().max(1);
                    emit_workflow_event(
                        "clip",
                        "running",
                        "preparing",
                        Some(0),
                        Some(total),
                        "准备剪辑片段",
                    );

                    for (index, shot) in plan.shots.iter().enumerate() {
                        let progress = WorkflowProgressContext {
                            stage: "clip",
                            current: index,
                            total,
                        };
                        progress.emit("indexing", format!("索引素材 {}/{}", index + 1, total));
                        prepare_shot_materials(
                            &material_context,
                            shot,
                            MaterialPreparationMode::IndexForClip,
                            Some(MaterialClipProgress {
                                current: progress.current,
                                total: progress.total,
                            }),
                            |event| progress.emit_material_event(event),
                        )?;
                        progress.emit("clipping", format!("剪辑片段 {}/{}", index + 1, total));
                        let clip_paths = create_shot_clips(&material_context, shot)?;
                        clip_manifest.record(&run_clips, shot, clip_paths)?;
                        progress.emit_done(format!("已剪辑 {}/{}", index + 1, total));
                    }
                }
                CapabilityId::ComposeVideo => {
                    emit_workflow_event(
                        "compose",
                        "running",
                        "composing",
                        Some(0),
                        Some(1),
                        "准备合成成片",
                    );
                    if !cli.skip_concat {
                        let final_file = final_file
                            .as_ref()
                            .ok_or_else(|| anyhow!("没有为合成步骤准备最终视频路径"))?;
                        fs::create_dir_all(&project_final_dir)?;
                        concat_final_video(FinalVideoContext {
                            paths: &paths,
                            plan: &plan,
                            clips_root: &run_clips,
                            norm_directory: &run_norm,
                            voice_directory: &run_voice,
                            final_clips_directory: &run_final_clips,
                            final_file: &final_file,
                            config: &config,
                        })?;
                        write_json_pretty_atomic(
                            &run_dir.join("final_video.json"),
                            &json!({
                                "schema_version": 1,
                                "run_id": run_id,
                                "path": final_file,
                            }),
                        )?;
                    } else {
                        println!("跳过合成. clips: {}", run_clips.display());
                    }
                    emit_workflow_event(
                        "compose",
                        "completed",
                        "composing",
                        Some(1),
                        Some(1),
                        "成片合成完成",
                    );
                }
                CapabilityId::PrepareBgm => {
                    let final_file = final_file
                        .as_ref()
                        .ok_or_else(|| anyhow!("没有为背景音乐步骤准备最终视频路径"))?;
                    emit_workflow_event(
                        "bgm",
                        "running",
                        "preparing",
                        Some(0),
                        Some(1),
                        "准备背景音乐",
                    );

                    if !plan_needs_bgm(&plan, &config) {
                        println!("未检测到背景音乐需求，跳过 BGM。");
                        emit_workflow_event(
                            "bgm",
                            "completed",
                            "skipped",
                            Some(1),
                            Some(1),
                            "无需背景音乐",
                        );
                    } else if cli.skip_concat {
                        println!("已跳过合成，无法混入背景音乐。");
                        emit_workflow_event(
                            "bgm",
                            "completed",
                            "skipped",
                            Some(1),
                            Some(1),
                            "已跳过背景音乐",
                        );
                    } else if !final_file.exists() {
                        println!(
                            "[警告] 未找到最终视频，无法混入背景音乐: {}",
                            final_file.display()
                        );
                        emit_workflow_event(
                            "bgm",
                            "completed",
                            "skipped",
                            Some(1),
                            Some(1),
                            "未找到成片，已跳过背景音乐",
                        );
                    } else {
                        match prepare_and_mix_bgm(
                            BgmContext {
                                paths: &paths,
                                plan: &plan,
                                directory: &run_bgm,
                                final_file: &final_file,
                                config: &config,
                            },
                            |event| {
                                emit_workflow_event(
                                    "bgm",
                                    "running",
                                    event.phase,
                                    Some(event.current),
                                    Some(event.total),
                                    event.label,
                                );
                            },
                        ) {
                            Ok(true) => emit_workflow_event(
                                "bgm",
                                "completed",
                                "mixing",
                                Some(1),
                                Some(1),
                                "背景音乐已混入",
                            ),
                            Ok(false) => {
                                println!("[错误] 未找到可用 BGM，已保留无背景音乐成片。");
                                emit_workflow_event(
                                    "bgm",
                                    "failed",
                                    "unavailable",
                                    Some(1),
                                    Some(1),
                                    "未找到可用背景音乐，已保留原成片",
                                );
                                bail!("未找到可用背景音乐，已保留无背景音乐成片");
                            }
                            Err(err) => {
                                let failure_message = bgm_failure_message(&final_file);
                                println!("[错误] {failure_message}: {err:#}");
                                emit_workflow_event(
                                    "bgm",
                                    "failed",
                                    "failed",
                                    Some(1),
                                    Some(1),
                                    failure_message.clone(),
                                );
                                return Err(err).context(failure_message);
                            }
                        }
                    }
                }
                CapabilityId::ReviewAssets
                | CapabilityId::SelectLocalMaterials
                | CapabilityId::IndexMaterials => {
                    bail!("能力 {:?} 当前没有执行器实现", step.capability);
                }
            }
            if let Some(journal) = incremental.as_mut() {
                match step.capability {
                    CapabilityId::ComposeVideo if !cli.skip_concat => {
                        journal.complete_final_stage("compose", &plan_path, &config)?
                    }
                    CapabilityId::PrepareBgm if !cli.skip_concat => {
                        journal.complete_final_stage("bgm", &plan_path, &config)?
                    }
                    _ => (),
                }
            }
            Ok(())
        })();
        if let Err(error) = step_result {
            checkpoint.record_partial_plan(&plan_path, &checkpoint_path)?;
            return Err(error);
        }
        if use_incremental {
            checkpoint.record_partial_plan(&plan_path, &checkpoint_path)?;
        } else {
            checkpoint.complete(
                format!("{:?}", step.capability),
                &artifact_roots,
                &plan_path,
                &checkpoint_path,
            )?;
        }
    }

    emit_workflow_done();
    println!("\n全部完成. run: {}", run_dir.display());
    log_line(format!("全部完成: {}", run_dir.display()));
    Ok(())
}

struct RunWorkspace {
    run_id: String,
    run_dir: PathBuf,
    material_dir: PathBuf,
    final_dir: PathBuf,
    project_name: String,
}

fn project_directory_from_shots_json(
    runs_dir: &Path,
    shots_json: Option<&Path>,
) -> Option<PathBuf> {
    let shots_path = fs::canonicalize(shots_json?).ok()?;
    let runs_root = fs::canonicalize(runs_dir).ok()?;
    let relative = shots_path.strip_prefix(&runs_root).ok()?;
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if parts
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case(".videoautocut"))
        && parts
            .get(1)
            .is_some_and(|part| part.len() == 8 && part.bytes().all(|value| value.is_ascii_digit()))
        && parts.get(2).is_some_and(|part| !part.is_empty())
    {
        return Some(runs_root.join(&parts[1]).join(&parts[2]));
    }
    if parts
        .first()
        .is_some_and(|part| part.len() == 8 && part.bytes().all(|value| value.is_ascii_digit()))
        && parts.get(1).is_some_and(|part| !part.is_empty())
        && parts
            .get(2)
            .is_some_and(|part| part.eq_ignore_ascii_case(".videoautocut"))
    {
        return Some(runs_root.join(&parts[0]).join(&parts[1]));
    }
    None
}

fn create_run_workspace(
    runs_dir: &Path,
    preferred_run_id: Option<&str>,
    task_name: &str,
    shots_json: Option<&Path>,
) -> Result<RunWorkspace> {
    fs::create_dir_all(runs_dir)
        .with_context(|| format!("无法创建运行根目录: {}", runs_dir.display()))?;
    let preferred_run_id = if let Some(run_id) = preferred_run_id {
        let is_valid = run_id.starts_with("run_")
            && run_id.len() <= 128
            && run_id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-');
        if !is_valid {
            bail!("invalid material manifest run_id");
        }
        Some(run_id.to_owned())
    } else {
        None
    };
    let now = Local::now();
    let requested_task_name = run_task_name(task_name);
    let project_dir =
        project_directory_from_shots_json(runs_dir, shots_json).unwrap_or_else(|| {
            runs_dir
                .join(now.format("%Y%m%d").to_string())
                .join(&requested_task_name)
        });
    let task_name = project_dir
        .file_name()
        .and_then(OsStr::to_str)
        .map(run_task_name)
        .unwrap_or(requested_task_name);
    let material_dir = project_dir.join("分镜视频");
    fs::create_dir_all(&material_dir)
        .with_context(|| format!("无法创建任务素材目录: {}", material_dir.display()))?;
    let final_dir = project_dir.join(format!("{}最终视频", task_name));
    let work_root = project_dir.join(".videoautocut").join("runs");
    fs::create_dir_all(&work_root)
        .with_context(|| format!("无法创建任务工作目录: {}", work_root.display()))?;
    if let Some(run_id) = preferred_run_id {
        let run_dir = work_root.join(&run_id);
        fs::create_dir_all(&run_dir)
            .with_context(|| format!("无法创建运行目录: {}", run_dir.display()))?;
        return Ok(RunWorkspace {
            run_id: run_id.clone(),
            run_dir,
            material_dir,
            final_dir,
            project_name: task_name,
        });
    }
    let base = format!(
        "run_{}_{}",
        now.format("%Y%m%d_%H%M%S_%3f"),
        std::process::id(),
    );

    for suffix in 0..1000 {
        let workspace_id = if suffix == 0 {
            base.clone()
        } else {
            format!("{}_{}", base, suffix)
        };
        let run_dir = work_root.join(&workspace_id);
        match fs::create_dir(&run_dir) {
            Ok(()) => {
                return Ok(RunWorkspace {
                    run_id: workspace_id,
                    run_dir,
                    material_dir,
                    final_dir,
                    project_name: task_name,
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("无法创建运行目录: {}", run_dir.display()));
            }
        }
    }

    bail!("无法创建唯一运行目录: {}", work_root.display())
}

fn next_project_final_path(final_dir: &Path, project_name: &str) -> PathBuf {
    let safe_name = run_task_name(project_name);
    let prefix = format!("{safe_name}_v");
    let mut greatest_version = 0_u32;
    if let Ok(entries) = fs::read_dir(final_dir) {
        for entry in entries.filter_map(|entry| entry.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(version) = name
                .strip_prefix(&prefix)
                .and_then(|value| value.strip_suffix(".mp4"))
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            greatest_version = greatest_version.max(version);
        }
    }
    final_dir.join(format!("{safe_name}_v{:03}.mp4", greatest_version + 1))
}

fn script_parse_error(path: &Path) -> String {
    format!("脚本文档解析失败: {}", path.display())
}

fn shot_count_message(plan: &ShotPlan) -> String {
    format!("分镜数: {}", plan.shots.len())
}

fn run_task_name(task_name: &str) -> String {
    let sanitized = sanitize_filename::sanitize(task_name.trim());
    let truncated = sanitized.chars().take(64).collect::<String>();
    let normalized = truncated.trim_matches([' ', '.', '_', '-']);
    if normalized.is_empty() {
        "未命名任务".to_string()
    } else {
        normalized.to_string()
    }
}

fn print_plan(plan: &ShotPlan) {
    println!("\n========== 分镜 ==========");

    for shot in &plan.shots {
        println!(
            "#{:02} {}\n  视觉模式: {}\n  下载关键词: {}\n  画面搜索描述: {}\n  时长: {} 秒",
            shot.shot,
            shot.title,
            shot_visual_mode(shot),
            shot.download_query,
            shot.visual_query,
            shot.duration.unwrap_or(4)
        );

        if let Some(subtitle) = shot.subtitle.as_deref() {
            println!("  字幕: {}", subtitle);
        }

        if let Some(voice_text) = shot.voice_text.as_deref() {
            println!("  口播: {}", voice_text);
        }

        if let Some(card_content) = shot.card_content.as_deref() {
            println!("  卡片: {}", card_content);
        }
    }

    println!("===========================\n");
}

fn prepare_voice_and_update_plan(
    paths: &AppPaths,

    plan_path: &Path,

    voice_dir: &Path,

    temp_dir: &Path,

    config: &RunConfig,
) -> Result<()> {
    let script = paths.root.join("tools").join("prepare_voice.py");

    if !script.exists() {
        bail!("未找到 tools/prepare_voice.py");
    }

    let (python, _) = paths
        .sentry_py
        .as_ref()
        .ok_or_else(|| anyhow!("找不到用于 tools/prepare_voice.py 的内置 Python"))?;

    let mut cmd = Command::new(python);

    add_child_env(&mut cmd, paths);

    cmd.env("VIDEOAUTO_TEMP_DIR", temp_dir);
    cmd.arg(script)
        .arg("--shots-json")
        .arg(plan_path)
        .arg("--voice-dir")
        .arg(voice_dir);

    if !config.voiceover {
        cmd.arg("--no-voiceover");
    }

    run_command(&mut cmd, "python prepare_voice")
}

fn optimize_queries_with_ai(paths: &AppPaths, plan_path: &Path, config: &RunConfig) -> Result<()> {
    let script = paths.root.join("tools").join("optimize_queries.py");

    if !script.exists() {
        bail!("未找到 tools/optimize_queries.py");
    }

    let (python, _) = paths
        .sentry_py
        .as_ref()
        .ok_or_else(|| anyhow!("找不到用于 tools/optimize_queries.py 的内置 Python"))?;

    let mut cmd = Command::new(python);

    add_child_env(&mut cmd, paths);
    cmd.arg(script)
        .arg("--shots-json")
        .arg(plan_path)
        .arg("--source")
        .arg(config.source.label());

    run_command(&mut cmd, "python optimize_queries").context("搜索词 AI 优化失败")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn script_error_is_neutral_and_shot_count_uses_parsed_plan() {
        let error = script_parse_error(Path::new("坏脚本.txt"));
        assert_eq!(error, "脚本文档解析失败: 坏脚本.txt");
        assert!(!error.contains("AI"));

        let plan: ShotPlan = serde_json::from_value(serde_json::json!({
            "schema_version": 2,
            "task_revision": 0,
            "topic": "测试",
            "shots": [
                {"shot_id":"s1","shot":1,"title":"一"},
                {"shot_id":"s2","shot":2,"title":"二"}
            ]
        }))
        .unwrap();
        assert_eq!(shot_count_message(&plan), "分镜数: 2");
    }

    #[test]
    fn bgm_failure_message_only_claims_preservation_when_final_file_exists() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let final_file = std::env::temp_dir().join(format!(
            "video_auto_bgm_failure_{}_{nonce}.mp4",
            std::process::id()
        ));

        let missing_message = bgm_failure_message(&final_file);
        assert!(missing_message.contains("未能恢复"));
        assert!(!missing_message.contains("已保留"));

        fs::write(&final_file, b"video").expect("write final file fixture");
        let preserved_message = bgm_failure_message(&final_file);
        assert!(preserved_message.contains("已保留"));
        assert!(!preserved_message.contains("未能恢复"));

        let _ = fs::remove_file(final_file);
    }

    #[test]
    fn run_task_name_is_safe_and_readable() {
        assert_eq!(run_task_name(" 纸飞机:30秒/投放版 "), "纸飞机30秒投放版");
        assert_eq!(run_task_name(" <>:\\/?*| "), "未命名任务");
        assert_eq!(run_task_name("任务名称"), "任务名称");
    }

    #[test]
    fn run_workspace_reuses_date_and_task_material_folder_without_replacing_cloud_run_id() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "video_auto_run_workspace_{}_{nonce}",
            std::process::id()
        ));
        let workspace = create_run_workspace(&root, Some("run_test_12345"), "任务名称", None)
            .expect("create run workspace");
        let task_folder_name = workspace
            .material_dir
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .expect("task material folder name");
        let date_folder_name = workspace
            .material_dir
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .expect("date material folder name");

        assert_eq!(workspace.run_id, "run_test_12345");
        assert_eq!(task_folder_name, "任务名称");
        assert_eq!(
            workspace.material_dir.file_name().and_then(OsStr::to_str),
            Some("分镜视频")
        );
        assert!(
            regex::Regex::new(r"^\d{8}$")
                .expect("date folder regex")
                .is_match(date_folder_name)
        );
        assert_eq!(
            workspace.run_dir,
            root.join(date_folder_name)
                .join(task_folder_name)
                .join(".videoautocut")
                .join("runs")
                .join(&workspace.run_id)
        );
        assert_eq!(
            workspace.final_dir,
            root.join(date_folder_name)
                .join(task_folder_name)
                .join("任务名称最终视频")
        );

        let reused = create_run_workspace(&root, Some("run_test_12345"), "任务名称", None)
            .expect("reuse run workspace");
        assert_eq!(reused.material_dir, workspace.material_dir);
        assert_eq!(reused.run_dir, workspace.run_dir);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shots_json_continuation_stays_in_the_original_project() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "video_auto_project_continuation_{}_{nonce}",
            std::process::id()
        ));
        let shots_path = root
            .join(".videoautocut")
            .join("20260903")
            .join("上下料B端视频")
            .join("run_plan")
            .join("shots.json");
        fs::create_dir_all(shots_path.parent().expect("shots parent")).expect("create legacy run");
        fs::write(&shots_path, b"{}").expect("write shots fixture");

        let workspace =
            create_run_workspace(&root, Some("run_generate"), "JSON分镜", Some(&shots_path))
                .expect("continue project");

        assert_eq!(workspace.project_name, "上下料B端视频");
        assert_eq!(
            workspace.material_dir,
            fs::canonicalize(&root)
                .expect("canonical runs root")
                .join("20260903")
                .join("上下料B端视频")
                .join("分镜视频")
        );
        assert!(!root.join("20260903").join("JSON分镜").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn final_video_versions_never_replace_an_existing_export() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "video_auto_final_versions_{}_{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create final directory");
        fs::write(root.join("项目_v001.mp4"), b"first").expect("write first final");
        fs::write(root.join("项目_v003.mp4"), b"third").expect("write third final");

        assert_eq!(
            next_project_final_path(&root, "项目"),
            root.join("项目_v004.mp4")
        );

        let _ = fs::remove_dir_all(root);
    }
}
